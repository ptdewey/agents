#!/usr/bin/env bash
# link-global.sh
# Walks the repo's home-mirror dirs (.claude, .codex, .config/opencode) and
# symlinks each file inside into the matching path under $HOME. Existing
# non-symlink targets are backed up before being replaced.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MIRROR_DIRS=(
  ".claude"
  ".codex"
  ".config/opencode"
)

# Files inside mirror dirs that should NOT be linked to $HOME.
# settings.local.json is Claude Code's per-project file written when editing
# this repo, not a template for the global config.
SKIP_NAMES=(
  "settings.local.json"
)

skip() {
  local name="$1"
  for s in "${SKIP_NAMES[@]}"; do
    [[ "$name" == "$s" ]] && return 0
  done
  return 1
}

link_file() {
  local src="$1" target="$2"
  local desired existing
  desired="$(realpath "$src")"
  existing="$(readlink "$target" 2>/dev/null || true)"

  if [[ "$existing" == "$desired" ]]; then
    echo "ok:      $target"
  elif [[ -e "$target" && -z "$existing" ]]; then
    local backup="$target.backup.$(date +%Y%m%d%H%M%S)"
    mv "$target" "$backup"
    ln -s "$desired" "$target"
    echo "backup:  $target -> $backup"
    echo "linked:  $target -> $desired"
  else
    ln -sf "$desired" "$target"
    echo "linked:  $target -> $desired"
  fi
}

for mirror in "${MIRROR_DIRS[@]}"; do
  src_dir="$REPO_DIR/$mirror"
  dst_dir="$HOME/$mirror"

  [[ -d "$src_dir" ]] || { echo "skip:    $mirror (missing in repo)"; continue; }
  mkdir -p "$dst_dir"

  shopt -s nullglob dotglob
  for entry in "$src_dir"/*; do
    name="$(basename "$entry")"
    if skip "$name"; then
      echo "skip:    $mirror/$name (excluded)"
      continue
    fi
    link_file "$entry" "$dst_dir/$name"
  done
  shopt -u nullglob dotglob
done
