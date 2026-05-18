export function definePlugins(config) {
  return config;
}

export function local(path, options = {}) {
  return {
    kind:
      options.package || options.resources
        ? "local-package"
        : "local-extension",
    path,
    ...options,
  };
}

export function npm(name, options = {}) {
  return {
    kind: "package",
    source: buildNpmSource(name, options.version),
    ...options,
  };
}

export function git(repo, options = {}) {
  return {
    kind: "package",
    source: buildGitSource(repo, options.ref),
    ...options,
  };
}

export function pkg(source, options = {}) {
  return {
    kind: "package",
    source,
    ...options,
  };
}

function buildNpmSource(name, version) {
  const base = name.startsWith("npm:") ? name : `npm:${name}`;
  if (!version) return base;
  return `${base}@${version}`;
}

function buildGitSource(repo, ref) {
  const base =
    repo.startsWith("git:") || /^[a-z]+:\/\//i.test(repo)
      ? repo
      : `git:${repo}`;
  if (!ref) return base;
  return `${base}@${ref}`;
}
