import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const MANAGER_MESSAGE_TYPE = "pi-plugin-manager";
const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_FILE = "settings.json";
const LOCK_FILE = "plugins-lock.json";
const CONFIG_CANDIDATES = [
  "plugins.ts",
  "plugins.mts",
  "plugins.mjs",
  "plugins.js",
  "plugins.cjs",
];

const requireFromHere = createRequire(import.meta.url);

type ResourceFilter = boolean | string[];

type PackageResources = {
  extensions?: ResourceFilter;
  skills?: ResourceFilter;
  prompts?: ResourceFilter;
  themes?: ResourceFilter;
};

type ConfigPlugin = {
  kind?: string;
  path?: string;
  source?: string;
  package?: boolean;
  resources?: PackageResources;
  extensions?: ResourceFilter;
  skills?: ResourceFilter;
  prompts?: ResourceFilter;
  themes?: ResourceFilter;
};

type PluginConfig = {
  plugins?: ConfigPlugin[];
};

type SettingsPackageEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

type PiSettings = Record<string, unknown> & {
  packages?: SettingsPackageEntry[];
  extensions?: string[];
};

type LockFile = {
  version: 1;
  updatedAt: string;
  managed: {
    packages: string[];
    extensions: string[];
  };
};

type DesiredState = {
  packages: SettingsPackageEntry[];
  extensions: string[];
};

type Plan = {
  settingsPath: string;
  lockPath: string;
  configPath: string;
  desired: DesiredState;
  nextSettings: PiSettings;
  nextLock: LockFile;
  changes: string[];
  lockChanged: boolean;
};

function agentDir(): string {
  return expandPath(process.env.PI_PLUGIN_MANAGER_HOME || DEFAULT_AGENT_DIR);
}

function settingsPath(): string {
  return path.join(agentDir(), SETTINGS_FILE);
}

function lockPath(): string {
  return path.join(agentDir(), LOCK_FILE);
}

function configSearchPaths(): string[] {
  const explicit = process.env.PI_PLUGIN_MANAGER_CONFIG;
  if (explicit) return [expandPath(explicit)];
  return CONFIG_CANDIDATES.map((name) => path.join(agentDir(), name));
}

function expandPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizePathForCompare(input: string): string {
  return path.resolve(expandPath(input));
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findConfigPath(): Promise<string | undefined> {
  for (const candidate of configSearchPaths()) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text.trim()) return fallback;
    return JSON.parse(text) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${file}: ${error.message}`);
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function loadConfig(configPath: string): Promise<PluginConfig> {
  const ext = path.extname(configPath);
  const stat = await fs.stat(configPath);

  let loaded: unknown;
  if ([".ts", ".mts", ".cts"].includes(ext)) {
    const createJiti = await loadCreateJiti();
    const jiti = createJiti(configPath, {
      interopDefault: true,
      moduleCache: false,
    });
    loaded = await jiti.import(configPath, { default: true });
  } else if (ext === ".cjs") {
    const resolved = requireFromHere.resolve(configPath);
    delete requireFromHere.cache?.[resolved];
    const mod = requireFromHere(configPath);
    loaded = mod?.default ?? mod;
  } else {
    const mod = await import(
      `${pathToFileURL(configPath).href}?mtime=${stat.mtimeMs}`
    );
    loaded = mod?.default ?? mod;
  }

  if (!loaded || typeof loaded !== "object") {
    throw new Error(
      `${configPath} must export a config object. Use definePlugins({ plugins: [...] }).`,
    );
  }

  const config = loaded as PluginConfig;
  if (!Array.isArray(config.plugins)) {
    throw new Error(`${configPath} must export { plugins: [...] }.`);
  }
  return config;
}

async function loadCreateJiti(): Promise<any> {
  try {
    const mod: any = await import("jiti");
    if (mod.createJiti) return mod.createJiti;
  } catch {}

  const errors: string[] = [];
  for (const candidate of await jitiRequireCandidates()) {
    try {
      const mod: any = candidate.require("jiti");
      if (mod.createJiti) return mod.createJiti;
      errors.push(`${candidate.label}: jiti did not export createJiti`);
    } catch (error: any) {
      errors.push(`${candidate.label}: ${error.message}`);
    }
  }

  throw new Error(
    `Cannot load TypeScript plugin config because the "jiti" package is unavailable. ` +
      `Install dependencies for the plugin manager extension or use plugins.mjs/plugins.cjs instead. ` +
      errors.join("; "),
  );
}

async function jitiRequireCandidates(): Promise<
  Array<{ label: string; require: any }>
> {
  const candidates: Array<{ label: string; require: any }> = [
    { label: "extension", require: requireFromHere },
  ];

  const argvScript = process.argv[1];
  if (argvScript) {
    candidates.push({
      label: `argv:${argvScript}`,
      require: createRequire(path.resolve(argvScript)),
    });

    try {
      const real = await fs.realpath(argvScript);
      candidates.push({
        label: `argv-real:${real}`,
        require: createRequire(real),
      });
    } catch {}
  }

  return candidates;
}

function normalizeDesired(config: PluginConfig): DesiredState {
  const desired: DesiredState = { packages: [], extensions: [] };

  for (const plugin of config.plugins ?? []) {
    if (!plugin || typeof plugin !== "object") {
      throw new Error(
        "Each plugin entry must be an object returned by local(), npm(), or git().",
      );
    }

    if (
      plugin.kind === "local-extension" ||
      (plugin.path &&
        !plugin.package &&
        !plugin.resources &&
        plugin.kind !== "local-package")
    ) {
      desired.extensions.push(requireString(plugin.path, "local plugin path"));
      continue;
    }

    if (
      plugin.kind === "local-package" ||
      (plugin.path && (plugin.package || plugin.resources))
    ) {
      desired.packages.push(
        buildPackageEntry(
          requireString(plugin.path, "local package path"),
          plugin,
        ),
      );
      continue;
    }

    if (plugin.kind === "package" || plugin.source) {
      desired.packages.push(
        buildPackageEntry(
          requireString(plugin.source, "package source"),
          plugin,
        ),
      );
      continue;
    }

    throw new Error(`Unsupported plugin entry: ${JSON.stringify(plugin)}`);
  }

  desired.packages = dedupePackages(desired.packages);
  desired.extensions = dedupeStringsBy(
    desired.extensions,
    normalizePathForCompare,
  );
  return desired;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }
  return value;
}

function buildPackageEntry(
  source: string,
  plugin: ConfigPlugin,
): SettingsPackageEntry {
  const resources: PackageResources = {
    ...plugin.resources,
    extensions: plugin.extensions ?? plugin.resources?.extensions,
    skills: plugin.skills ?? plugin.resources?.skills,
    prompts: plugin.prompts ?? plugin.resources?.prompts,
    themes: plugin.themes ?? plugin.resources?.themes,
  };

  const entry: Extract<SettingsPackageEntry, object> = { source };
  let hasFilter = false;

  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const value = resources[key];
    if (value === undefined || value === true) continue;
    hasFilter = true;
    entry[key] = value === false ? [] : [...value];
  }

  return hasFilter ? entry : source;
}

function dedupePackages(
  entries: SettingsPackageEntry[],
): SettingsPackageEntry[] {
  const seen = new Set<string>();
  const result: SettingsPackageEntry[] = [];
  for (const entry of entries) {
    const source = getPackageSource(entry);
    if (seen.has(source)) continue;
    seen.add(source);
    result.push(entry);
  }
  return result;
}

function dedupeStringsBy(
  values: string[],
  keyFn: (value: string) => string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function getPackageSource(entry: SettingsPackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packageEntriesEqual(
  a: SettingsPackageEntry,
  b: SettingsPackageEntry,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function lockManagedEqual(lock: LockFile, desired: DesiredState): boolean {
  return (
    lock.version === 1 &&
    arraysEqual(lock.managed?.packages ?? [], desired.packages.map(getPackageSource)) &&
    arraysEqual(lock.managed?.extensions ?? [], desired.extensions)
  );
}

function defaultLock(): LockFile {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    managed: { packages: [], extensions: [] },
  };
}

async function buildPlan(): Promise<Plan> {
  const foundConfigPath = await findConfigPath();
  if (!foundConfigPath) {
    throw new Error(
      `No plugin config found. Run /plugins init to create ${path.join(agentDir(), "plugins.ts")}.`,
    );
  }

  const settingsFile = settingsPath();
  const lockFile = lockPath();
  const [settings, lock, config, lockExists] = await Promise.all([
    readJsonFile<PiSettings>(settingsFile, {}),
    readJsonFile<LockFile>(lockFile, defaultLock()),
    loadConfig(foundConfigPath),
    pathExists(lockFile),
  ]);

  const desired = normalizeDesired(config);
  const nextSettings: PiSettings = { ...settings };
  const currentPackages = Array.isArray(settings.packages)
    ? settings.packages
    : [];
  const currentExtensions = Array.isArray(settings.extensions)
    ? settings.extensions
    : [];
  const changes: string[] = [];

  const desiredPackageSources = new Set(desired.packages.map(getPackageSource));
  const lockedPackageSources = new Set(lock.managed?.packages ?? []);
  const desiredExtensions = new Set(
    desired.extensions.map(normalizePathForCompare),
  );
  const lockedExtensions = new Set(
    (lock.managed?.extensions ?? []).map(normalizePathForCompare),
  );

  const nextPackages: SettingsPackageEntry[] = [];
  const usedDesiredSources = new Set<string>();

  for (const current of currentPackages) {
    const source = getPackageSource(current);
    const desiredEntry = desired.packages.find(
      (entry) => getPackageSource(entry) === source,
    );

    if (desiredEntry) {
      usedDesiredSources.add(source);
      nextPackages.push(desiredEntry);
      if (!packageEntriesEqual(current, desiredEntry))
        changes.push(`update package ${source}`);
      continue;
    }

    if (
      lockedPackageSources.has(source) &&
      !desiredPackageSources.has(source)
    ) {
      changes.push(`remove package ${source}`);
      continue;
    }

    nextPackages.push(current);
  }

  for (const desiredEntry of desired.packages) {
    const source = getPackageSource(desiredEntry);
    if (usedDesiredSources.has(source)) continue;
    nextPackages.push(desiredEntry);
    changes.push(`add package ${source}`);
  }

  const nextExtensions: string[] = [];
  const usedDesiredExtensions = new Set<string>();

  for (const current of currentExtensions) {
    const currentKey = normalizePathForCompare(current);
    const desiredExtension = desired.extensions.find(
      (entry) => normalizePathForCompare(entry) === currentKey,
    );

    if (desiredExtension) {
      usedDesiredExtensions.add(currentKey);
      nextExtensions.push(desiredExtension);
      if (current !== desiredExtension)
        changes.push(`update extension ${desiredExtension}`);
      continue;
    }

    if (
      lockedExtensions.has(currentKey) &&
      !desiredExtensions.has(currentKey)
    ) {
      changes.push(`remove extension ${current}`);
      continue;
    }

    nextExtensions.push(current);
  }

  for (const desiredExtension of desired.extensions) {
    const key = normalizePathForCompare(desiredExtension);
    if (usedDesiredExtensions.has(key)) continue;
    nextExtensions.push(desiredExtension);
    changes.push(`add extension ${desiredExtension}`);
  }

  nextSettings.packages = nextPackages;
  nextSettings.extensions = nextExtensions;

  const nextLock: LockFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    managed: {
      packages: desired.packages.map(getPackageSource),
      extensions: desired.extensions,
    },
  };

  return {
    settingsPath: settingsFile,
    lockPath: lockFile,
    configPath: foundConfigPath,
    desired,
    nextSettings,
    nextLock,
    changes,
    lockChanged: !lockExists || !lockManagedEqual(lock, desired),
  };
}

async function applyPlan(plan: Plan): Promise<void> {
  await writeJsonFile(plan.settingsPath, plan.nextSettings);
  await writeJsonFile(plan.lockPath, plan.nextLock);
}

async function initConfig(overwrite: boolean, empty: boolean): Promise<string> {
  const file = path.join(agentDir(), "plugins.ts");
  if (!overwrite && (await pathExists(file))) {
    throw new Error(
      `${file} already exists. Use /plugins init --force to overwrite it.`,
    );
  }

  const settings = empty
    ? undefined
    : await readJsonFile<PiSettings>(settingsPath(), {});
  const content = settings ? configFromSettings(settings) : sampleConfig();

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}

function configFromSettings(settings: PiSettings): string {
  const pluginCalls = pluginCallsFromSettings(settings);
  if (pluginCalls.length === 0) return sampleConfig();

  return `import { definePlugins, git, local, npm } from ${JSON.stringify(dslImportSpecifier())};

export default definePlugins({
  // Seeded from ${settingsPath()} by /plugins init.
  plugins: [
${pluginCalls.map(formatPluginCall).join("\n")}
  ],
});
`;
}

function pluginCallsFromSettings(settings: PiSettings): string[] {
  const calls: string[] = [];

  if (Array.isArray(settings.packages)) {
    for (const entry of settings.packages) {
      calls.push(packageEntryToPluginCall(entry));
    }
  }

  if (Array.isArray(settings.extensions)) {
    for (const extension of settings.extensions) {
      if (typeof extension !== "string" || extension.trim() === "") {
        throw new Error("settings.json#extensions must contain only strings.");
      }
      calls.push(`local(${JSON.stringify(extension)})`);
    }
  }

  return calls;
}

function packageEntryToPluginCall(entry: SettingsPackageEntry): string {
  if (typeof entry === "string") return packageSourceToPluginCall(entry);
  if (!entry || typeof entry.source !== "string" || entry.source.trim() === "") {
    throw new Error("settings.json#packages objects must include a source string.");
  }

  return packageSourceToPluginCall(
    entry.source,
    packageResourcesFromEntry(entry),
  );
}

function packageResourcesFromEntry(
  entry: Extract<SettingsPackageEntry, object>,
): PackageResources | undefined {
  const resources: PackageResources = {};
  let hasResources = false;
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const value = entry[key];
    if (value === undefined) continue;
    resources[key] = [...value];
    hasResources = true;
  }

  return hasResources ? resources : undefined;
}

function packageSourceToPluginCall(
  source: string,
  resources?: PackageResources,
): string {
  const npmSource = parseNpmPackageSource(source);
  if (npmSource) {
    return formatDslCall(
      "npm",
      npmSource.name,
      buildOptions({ version: npmSource.version, resources }),
    );
  }

  const gitSource = parseGitPackageSource(source);
  if (gitSource) {
    return formatDslCall(
      "git",
      gitSource.repo,
      buildOptions({ ref: gitSource.ref, resources }),
    );
  }

  if (isLocalPackageSource(source)) {
    return formatDslCall(
      "local",
      source,
      buildOptions({ package: true, resources }),
    );
  }

  throw new Error(
    `Cannot seed unsupported package source ${JSON.stringify(source)}. ` +
      `/plugins init can seed npm:, git/protocol URLs, and local package paths.`,
  );
}

function parseNpmPackageSource(
  source: string,
): { name: string; version?: string } | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length);
  if (!spec.trim()) throw new Error("npm package source must include a name.");

  const versionIndex = npmVersionDelimiterIndex(spec);
  if (versionIndex === -1) return { name: spec };
  const version = spec.slice(versionIndex + 1);
  if (!version) {
    throw new Error(`npm package source ${source} has an empty version.`);
  }
  return {
    name: spec.slice(0, versionIndex),
    version,
  };
}

function npmVersionDelimiterIndex(spec: string): number {
  if (!spec.startsWith("@")) return spec.indexOf("@");

  const scopeEnd = spec.indexOf("/", 1);
  if (scopeEnd === -1) return -1;
  return spec.indexOf("@", scopeEnd + 1);
}

function parseGitPackageSource(
  source: string,
): { repo: string; ref?: string } | undefined {
  if (!isGitPackageSource(source)) return undefined;
  const withoutPrefix = source.startsWith("git:")
    ? source.slice("git:".length)
    : source;
  const refIndex = gitRefDelimiterIndex(withoutPrefix);
  if (refIndex === -1) return { repo: withoutPrefix };
  const ref = withoutPrefix.slice(refIndex + 1);
  if (!ref) throw new Error(`git package source ${source} has an empty ref.`);
  return {
    repo: withoutPrefix.slice(0, refIndex),
    ref,
  };
}

function isGitPackageSource(source: string): boolean {
  return source.startsWith("git:") || /^[a-z]+:\/\//i.test(source);
}

function gitRefDelimiterIndex(source: string): number {
  const index = source.lastIndexOf("@");
  if (index <= 0) return -1;
  const before = source.slice(0, index);
  const after = source.slice(index + 1);
  if (!after || after.includes(":")) return -1;
  if (!before.includes("/") && !before.includes(":")) return -1;
  return index;
}

function isLocalPackageSource(source: string): boolean {
  return (
    source === "~" ||
    source.startsWith("~/") ||
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../")
  );
}

function buildOptions(input: {
  version?: string;
  ref?: string;
  package?: boolean;
  resources?: PackageResources;
}): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (input.version) options.version = input.version;
  if (input.ref) options.ref = input.ref;
  if (input.package) options.package = true;
  if (input.resources) options.resources = input.resources;
  return Object.keys(options).length > 0 ? options : undefined;
}

function formatDslCall(
  helper: "git" | "local" | "npm",
  source: string,
  options?: Record<string, unknown>,
): string {
  const args = [JSON.stringify(source)];
  if (options) args.push(JSON.stringify(options, null, 2));
  return `${helper}(${args.join(", ")})`;
}

function formatPluginCall(call: string): string {
  return call
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n") + ",";
}

function sampleConfig(): string {
  return `import { definePlugins, git, local, npm } from ${JSON.stringify(dslImportSpecifier())};

export default definePlugins({
  plugins: [
    // Local extension files or directories are written to ~/.pi/agent/settings.json#extensions.
    // local("~/projects/skills/extensions/review.ts"),

    // Local Pi package directories are written to settings.json#packages.
    // local("~/projects/my-pi-package", { package: true }),

    // npm and git packages use Pi's package source syntax.
    // npm("@org/pi-tools", { version: "^1.0.0" }),
    // git("github.com/user/pi-tools", { ref: "main" }),

    // Resource filters mirror Pi package filters.
    // npm("@org/mixed-pi-package", {
    //   resources: {
    //     extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
    //     skills: [],
    //     prompts: false,
    //   },
    // }),
  ],
});
`;
}

function dslImportSpecifier(): string {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const conventionalGlobalDir = path.join(
    agentDir(),
    "extensions",
    "pi-plugin-manager",
  );
  if (
    normalizePathForCompare(extensionDir) ===
    normalizePathForCompare(conventionalGlobalDir)
  ) {
    return "./extensions/pi-plugin-manager/dsl.js";
  }
  return path.join(extensionDir, "dsl.js");
}

function formatPlan(plan: Plan, heading = "Pi plugin plan"): string {
  const lines = [`## ${heading}`, ""];
  lines.push(`Config: ${plan.configPath}`);
  lines.push(`Settings: ${plan.settingsPath}`);
  lines.push(`Lockfile: ${plan.lockPath}`);
  lines.push("");
  lines.push(`Desired packages: ${plan.desired.packages.length}`);
  for (const entry of plan.desired.packages)
    lines.push(`- ${getPackageSource(entry)}`);
  lines.push(`Desired local extensions: ${plan.desired.extensions.length}`);
  for (const entry of plan.desired.extensions) lines.push(`- ${entry}`);
  lines.push("");

  if (plan.changes.length === 0) {
    lines.push(
      plan.lockChanged
        ? "No settings changes. Lockfile will be initialized or updated."
        : "No changes. Settings already match the declarative config.",
    );
  } else {
    lines.push("Changes:");
    for (const change of plan.changes) lines.push(`- ${change}`);
  }

  return lines.join("\n");
}

function sendReport(
  pi: ExtensionAPI,
  content: string,
  details?: Record<string, unknown>,
) {
  pi.sendMessage({
    customType: MANAGER_MESSAGE_TYPE,
    content,
    display: true,
    details,
  });
}

function parseCommand(args: string): { command: string; flags: Set<string> } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const command = parts[0] || "status";
  const flags = new Set(parts.slice(1));
  return { command, flags };
}

async function sync(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reload: boolean,
): Promise<void> {
  const plan = await buildPlan();
  const settingsChanged = plan.changes.length > 0;
  if (!settingsChanged && !plan.lockChanged) {
    sendReport(pi, formatPlan(plan, "Pi plugins already synced"));
    return;
  }

  await applyPlan(plan);
  sendReport(
    pi,
    formatPlan(
      plan,
      settingsChanged ? "Pi plugins synced" : "Pi plugin lockfile synced",
    ),
  );

  if (!settingsChanged) return;

  if (reload) {
    await ctx.reload();
    return;
  }

  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Reload Pi resources?",
      "Settings changed. Reload extensions, skills, prompts, and themes now?",
    );
    if (ok) {
      await ctx.reload();
      return;
    }
  }
}

function helpText(): string {
  return `## Pi plugin manager

Commands:

- /plugins init [--force] [--empty] - create ~/.pi/agent/plugins.ts seeded from current settings
- /plugins plan - show desired settings changes
- /plugins sync - write ~/.pi/agent/settings.json and plugins-lock.json
- /plugins reload - sync, then reload Pi resources
- /plugins update - run pi update --extensions
- /plugins status - summarize desired plugins and drift
- /plugins doctor - show paths and loader health

Config defaults to ~/.pi/agent/plugins.ts, then plugins.mts, plugins.mjs, plugins.js, plugins.cjs.
Override with PI_PLUGIN_MANAGER_CONFIG. Override the global agent dir with PI_PLUGIN_MANAGER_HOME.
`;
}

async function doctorText(): Promise<string> {
  const found = await findConfigPath();
  let jitiStatus = "available";
  try {
    await loadCreateJiti();
  } catch (error: any) {
    jitiStatus = `missing (${error.message})`;
  }

  return [
    "## Pi plugin manager doctor",
    "",
    `Agent dir: ${agentDir()}`,
    `Config: ${found ?? "not found"}`,
    `Settings: ${settingsPath()}`,
    `Lockfile: ${lockPath()}`,
    `TypeScript loader: ${jitiStatus}`,
  ].join("\n");
}

export default function piPluginManager(pi: ExtensionAPI) {
  pi.registerCommand("plugins", {
    description: "Declaratively manage global Pi extensions and packages",
    handler: async (args, ctx) => {
      const { command, flags } = parseCommand(args);

      try {
        switch (command) {
          case "help":
          case "--help":
          case "-h":
            sendReport(pi, helpText());
            return;

          case "init": {
            const file = await initConfig(
              flags.has("--force"),
              flags.has("--empty"),
            );
            sendReport(pi, `Created ${file}. Edit it, then run /plugins sync.`);
            return;
          }

          case "plan": {
            const plan = await buildPlan();
            sendReport(pi, formatPlan(plan));
            return;
          }

          case "sync":
            await sync(pi, ctx, false);
            return;

          case "reload":
            await sync(pi, ctx, true);
            return;

          case "update": {
            const result = await pi.exec("pi", ["update", "--extensions"]);
            sendReport(
              pi,
              [
                "## Pi plugin update",
                "",
                `Exit code: ${result.code}`,
                result.stdout
                  ? `\nstdout:\n\n\`\`\`\n${result.stdout.trim()}\n\`\`\``
                  : "",
                result.stderr
                  ? `\nstderr:\n\n\`\`\`\n${result.stderr.trim()}\n\`\`\``
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
              { result },
            );
            return;
          }

          case "status": {
            const plan = await buildPlan();
            const heading =
              plan.changes.length === 0 && !plan.lockChanged
                ? "Pi plugins status: synced"
                : "Pi plugins status: drift detected";
            sendReport(pi, formatPlan(plan, heading));
            return;
          }

          case "doctor":
            sendReport(pi, await doctorText());
            return;

          default:
            sendReport(
              pi,
              `Unknown /plugins command: ${command}\n\n${helpText()}`,
            );
            return;
        }
      } catch (error: any) {
        const message = error?.stack || error?.message || String(error);
        sendReport(pi, `Pi plugin manager error:\n\n${message}`);
        if (ctx.hasUI)
          ctx.ui.notify(
            `Plugin manager error: ${error?.message || error}`,
            "error",
          );
      }
    },
  });
}
