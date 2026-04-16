#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "Initializing submodules..."
git submodule init

echo "Updating submodules..."
git submodule update --recursive

echo ""
echo "Submodule status:"
git submodule status --recursive
