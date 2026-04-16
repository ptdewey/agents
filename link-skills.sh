#!/usr/bin/env bash
# link-skills.sh <source-dir> [source-dir ...]
# Symlinks each skill directory found in source dirs into ~/.claude/skills/

set -euo pipefail

SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$SKILLS_DIR"

for src_dir in "$@"; do
  for skill in "$src_dir"/*/; do
    [[ -f "$skill/SKILL.md" ]] || continue
    name=$(basename "$skill")
    target="$SKILLS_DIR/$name"
    desired=$(realpath "$skill")
    existing=$(readlink "$target" 2>/dev/null || true)

    if [[ "$existing" == "$desired" ]]; then
      echo "ok:      $name"
    else
      ln -sf "$desired" "$target"
      echo "linked:  $name -> $desired"
    fi
  done
done
