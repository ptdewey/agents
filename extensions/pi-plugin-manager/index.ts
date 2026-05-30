import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
const NETWORK_TIMEOUT_MS = 10_000;

const requireFromHere = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

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

type LockedPackage = {
  source: string;
  lockedSource: string;
  type: "npm" | "git" | "local";
  name?: string;
  version?: string;
  repo?: string;
  ref?: string;
  commit?: string;
  resolved?: string;
  integrity?: string;
};

type LockFile = {
  version: 1 | 2;
  updatedAt: string;
  managed: {
    packages: string[];
    extensions: string[];
  };
  packages?: LockedPackage[];
};

type DesiredState = {
  packages: SettingsPackageEntry[];
  extensions: string[];
};

type BuildPlanOptions = {
  refreshLocks?: boolean;
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

function withPackageSource(
  entry: SettingsPackageEntry,
  source: string,
): SettingsPackageEntry {
  return typeof entry === "string" ? source : { ...entry, source };
}

function packageIdentity(source: string): string {
  const npmSource = parseNpmPackageSource(source);
  if (npmSource) return `npm:${npmSource.name}`;

  const gitSource = parseGitPackageSource(source);
  if (gitSource) return `git:${gitSource.repo}`;

  if (isLocalPackageSource(source)) {
    return `local:${normalizePathForCompare(source)}`;
  }

  return source;
}

function isNpmVersionPinned(version: string | undefined): boolean {
  return Boolean(
    version && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version),
  );
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

function lockComparable(lock: LockFile): unknown {
  return {
    version: 2,
    managed: lock.managed,
    packages: lock.packages ?? [],
  };
}

function lockManagedEqual(lock: LockFile, nextLock: LockFile): boolean {
  return (
    JSON.stringify(lockComparable(lock)) ===
    JSON.stringify(lockComparable(nextLock))
  );
}

function lockedPackagesByIdentity(lock: LockFile): Map<string, LockedPackage> {
  const result = new Map<string, LockedPackage>();
  for (const locked of lock.packages ?? []) {
    result.set(packageIdentity(locked.source), locked);
  }
  return result;
}

async function lockDesiredPackages(
  desiredPackages: SettingsPackageEntry[],
  lock: LockFile,
  refreshLocks: boolean,
): Promise<{ packages: SettingsPackageEntry[]; locked: LockedPackage[] }> {
  const existing = lockedPackagesByIdentity(lock);
  const packages: SettingsPackageEntry[] = [];
  const locked: LockedPackage[] = [];

  for (const entry of desiredPackages) {
    const source = getPackageSource(entry);
    const identity = packageIdentity(source);
    const current = existing.get(identity);
    const next = await lockPackageSource(
      source,
      refreshLocks ? undefined : current,
    );
    locked.push(next);
    packages.push(withPackageSource(entry, next.lockedSource));
  }

  return { packages, locked };
}

async function lockPackageSource(
  source: string,
  existing?: LockedPackage,
): Promise<LockedPackage> {
  const npmSource = parseNpmPackageSource(source);
  if (npmSource) return lockNpmPackageSource(source, npmSource, existing);

  const gitSource = parseGitPackageSource(source);
  if (gitSource) return lockGitPackageSource(source, gitSource, existing);

  return {
    source,
    lockedSource: source,
    type: "local",
  };
}

async function lockNpmPackageSource(
  source: string,
  npmSource: { name: string; version?: string },
  existing?: LockedPackage,
): Promise<LockedPackage> {
  if (existing?.type === "npm" && existing.version && !npmSource.version) {
    return { ...existing, source };
  }

  const version = isNpmVersionPinned(npmSource.version)
    ? npmSource.version
    : await resolveNpmVersion(npmSource.name, npmSource.version);
  if (!version) {
    throw new Error(
      `Could not resolve an exact npm version for ${source}. ` +
        `Pin it in plugins.ts or retry when npm metadata is available.`,
    );
  }

  const metadata = await resolveNpmDistMetadata(npmSource.name, version);
  return {
    source,
    lockedSource: `npm:${npmSource.name}@${version}`,
    type: "npm",
    name: npmSource.name,
    version,
    ...metadata,
  };
}

async function resolveNpmVersion(
  name: string,
  range: string | undefined,
): Promise<string | undefined> {
  try {
    const spec = range ? `${name}@${range}` : name;
    const { stdout } = await execFileAsync(
      "npm",
      ["view", spec, "version", "--json"],
      { timeout: NETWORK_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout.trim());
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed) && typeof parsed.at(-1) === "string") {
      return parsed.at(-1);
    }
  } catch {}
  return readInstalledNpmVersion(name);
}

async function resolveNpmDistMetadata(
  name: string,
  version: string,
): Promise<Pick<LockedPackage, "resolved" | "integrity">> {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", `${name}@${version}`, "dist", "--json"],
      { timeout: NETWORK_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout.trim());
    return {
      resolved: typeof parsed?.tarball === "string" ? parsed.tarball : undefined,
      integrity:
        typeof parsed?.integrity === "string" ? parsed.integrity : undefined,
    };
  } catch {
    return readInstalledNpmLockMetadata(name);
  }
}

function readInstalledNpmVersion(name: string): string | undefined {
  return readInstalledNpmPackageJson(name)?.version;
}

function readInstalledNpmPackageJson(name: string): any {
  const file = path.join(
    agentDir(),
    "npm",
    "node_modules",
    name,
    "package.json",
  );
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readInstalledNpmLockMetadata(
  name: string,
): Pick<LockedPackage, "resolved" | "integrity"> {
  const file = path.join(
    agentDir(),
    "npm",
    "node_modules",
    ".package-lock.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entry = parsed?.packages?.[`node_modules/${name}`];
    return {
      resolved: typeof entry?.resolved === "string" ? entry.resolved : undefined,
      integrity:
        typeof entry?.integrity === "string" ? entry.integrity : undefined,
    };
  } catch {
    return {};
  }
}

async function lockGitPackageSource(
  source: string,
  gitSource: { repo: string; ref?: string },
  existing?: LockedPackage,
): Promise<LockedPackage> {
  if (existing?.type === "git" && existing.commit && !gitSource.ref) {
    return { ...existing, source };
  }

  const commit = await resolveGitCommit(gitSource.repo, gitSource.ref);
  if (!commit) {
    throw new Error(
      `Could not resolve a git commit for ${source}. ` +
        `Pin it to a commit SHA or retry when the remote is available.`,
    );
  }
  return {
    source,
    lockedSource: `git:${gitSource.repo}@${commit}`,
    type: "git",
    repo: gitSource.repo,
    ref: gitSource.ref,
    commit,
  };
}

async function resolveGitCommit(
  repo: string,
  ref: string | undefined,
): Promise<string | undefined> {
  if (/^[0-9a-f]{40}$/i.test(ref ?? "")) return ref;
  try {
    const remote = normalizeGitRemoteForLsRemote(repo);
    const args = ref ? [remote, ref] : [remote, "HEAD"];
    const { stdout } = await execFileAsync("git", ["ls-remote", ...args], {
      timeout: NETWORK_TIMEOUT_MS,
    });
    const match = stdout.match(/^([0-9a-f]{40})\s+/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function normalizeGitRemoteForLsRemote(repo: string): string {
  if (/^[^/:]+\.[^/]+\/.+/.test(repo)) return `https://${repo}`;
  return repo;
}

function defaultLock(): LockFile {
  return {
    version: 2,
    updatedAt: new Date(0).toISOString(),
    managed: { packages: [], extensions: [] },
    packages: [],
  };
}

async function buildPlan(options: BuildPlanOptions = {}): Promise<Plan> {
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
  const lockedDesired = await lockDesiredPackages(
    desired.packages,
    lock,
    Boolean(options.refreshLocks),
  );
  const desiredForSettings: DesiredState = {
    packages: lockedDesired.packages,
    extensions: desired.extensions,
  };
  const nextSettings: PiSettings = { ...settings };
  const currentPackages = Array.isArray(settings.packages)
    ? settings.packages
    : [];
  const currentExtensions = Array.isArray(settings.extensions)
    ? settings.extensions
    : [];
  const changes: string[] = [];

  const desiredPackageSources = new Set(
    desiredForSettings.packages.map((entry) =>
      packageIdentity(getPackageSource(entry)),
    ),
  );
  const lockedPackageSources = new Set(
    (lock.managed?.packages ?? []).map(packageIdentity),
  );
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
    const desiredEntry = desiredForSettings.packages.find(
      (entry) =>
        packageIdentity(getPackageSource(entry)) === packageIdentity(source),
    );

    if (desiredEntry) {
      usedDesiredSources.add(getPackageSource(desiredEntry));
      nextPackages.push(desiredEntry);
      if (!packageEntriesEqual(current, desiredEntry))
        changes.push(`update package ${source}`);
      continue;
    }

    if (
      lockedPackageSources.has(packageIdentity(source)) &&
      !desiredPackageSources.has(packageIdentity(source))
    ) {
      changes.push(`remove package ${source}`);
      continue;
    }

    nextPackages.push(current);
  }

  for (const desiredEntry of desiredForSettings.packages) {
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
    version: 2,
    updatedAt: new Date().toISOString(),
    managed: {
      packages: desired.packages.map(getPackageSource),
      extensions: desired.extensions,
    },
    packages: lockedDesired.locked,
  };

  return {
    settingsPath: settingsFile,
    lockPath: lockFile,
    configPath: foundConfigPath,
    desired: desiredForSettings,
    nextSettings,
    nextLock,
    changes,
    lockChanged: !lockExists || !lockManagedEqual(lock, nextLock),
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

type LoadingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

async function withLoadingWindow<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!ctx.hasUI) return operation();

  const result = await ctx.ui.custom<LoadingResult<T>>(
    (tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, message, {
        cancellable: false,
      });

      queueMicrotask(() => {
        operation()
          .then((value) => done({ ok: true, value }))
          .catch((error) => done({ ok: false, error }));
      });

      return loader;
    },
  );

  if (result.ok) return result.value;
  throw result.error;
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
  const plan = await withLoadingWindow(
    ctx,
    "Resolving plugin pins...",
    () => buildPlan(),
  );
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
- /plugins update - refresh locked npm/git versions and write settings
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
            const plan = await withLoadingWindow(
              ctx,
              "Resolving plugin pins...",
              () => buildPlan(),
            );
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
            const plan = await withLoadingWindow(
              ctx,
              "Refreshing plugin pins...",
              () => buildPlan({ refreshLocks: true }),
            );
            await applyPlan(plan);
            sendReport(pi, formatPlan(plan, "Pi plugin lockfile updated"));
            if (ctx.hasUI) {
              const ok = await ctx.ui.confirm(
                "Reload Pi resources?",
                "The plugin lockfile was refreshed. Reload to install pinned package versions now?",
              );
              if (ok) await ctx.reload();
            }
            return;
          }

          case "status": {
            const plan = await withLoadingWindow(
              ctx,
              "Resolving plugin pins...",
              () => buildPlan(),
            );
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
