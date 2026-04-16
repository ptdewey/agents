#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Parse .gitmodules and re-add each submodule properly.
# This is needed when .gitmodules exists but the submodules
# were never registered in the git index.
entries=$(git config --file .gitmodules --get-regexp 'submodule\..*\.path')

while IFS= read -r line; do
    key="${line%% *}"
    path="${line#* }"
    name="${key#submodule.}"
    name="${name%.path}"
    url=$(git config --file .gitmodules "submodule.${name}.url")

    echo "Adding submodule: $name"
    echo "  path: $path"
    echo "  url:  $url"

    # Remove any partial state
    git rm --cached "$path" 2>/dev/null || true
    rm -rf "$path"

    git submodule add --force "$url" "$path"
    echo ""
done <<< "$entries"

echo "Submodule status:"
git submodule status --recursive
