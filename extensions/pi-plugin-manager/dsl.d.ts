export type ResourceFilter = boolean | string[];

export interface PackageResources {
  extensions?: ResourceFilter;
  skills?: ResourceFilter;
  prompts?: ResourceFilter;
  themes?: ResourceFilter;
}

export interface BasePluginOptions {
  /**
   * Optional human-readable note for your config. The plugin manager ignores it.
   */
  name?: string;
  /**
   * Pi package resource filters. Omit a key or set it to true to load all of
   * that resource type. Set false or [] to load none. String arrays use Pi's
   * package filter syntax, including !pattern, +path, and -path.
   */
  resources?: PackageResources;
}

export interface LocalPluginOptions extends BasePluginOptions {
  /** Treat this local path as a Pi package instead of a single extension path. */
  package?: boolean;
}

export interface NpmPluginOptions extends BasePluginOptions {
  /** Optional npm version/range. The plugin lockfile resolves ranges to exact versions. */
  version?: string;
}

export interface GitPluginOptions extends BasePluginOptions {
  /** Optional git ref. The plugin lockfile resolves movable refs to commit SHAs when possible. */
  ref?: string;
}

export interface LocalExtensionPlugin extends LocalPluginOptions {
  kind: "local-extension";
  path: string;
}

export interface LocalPackagePlugin extends LocalPluginOptions {
  kind: "local-package";
  path: string;
  package: true;
}

export interface PackagePlugin extends BasePluginOptions {
  kind: "package";
  source: string;
}

export type Plugin = LocalExtensionPlugin | LocalPackagePlugin | PackagePlugin;

export interface PluginConfig {
  plugins: Plugin[];
}

export declare function definePlugins<T extends PluginConfig>(config: T): T;

/**
 * Manage a local extension file/directory by adding it to settings.extensions.
 * Pass { package: true } or { resources: ... } to manage it as a local Pi package.
 */
export declare function local(
  path: string,
  options?: LocalPluginOptions,
): LocalExtensionPlugin | LocalPackagePlugin;

/** Manage an npm Pi package. Example: npm("@org/pi-tools", { version: "^1.2.0" }). */
export declare function npm(
  name: string,
  options?: NpmPluginOptions,
): PackagePlugin;

/** Manage a git Pi package. Example: git("github.com/user/repo", { ref: "main" }). */
export declare function git(
  repo: string,
  options?: GitPluginOptions,
): PackagePlugin;

