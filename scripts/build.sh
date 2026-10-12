#!/usr/bin/env bash
# Build dsh-supervisor against the installed DSH host.
#
# The host ships every @deepseek-ai/* package we compile against, so instead of
# resolving peers from a registry we junction them out of the app bundle, then
# run tsc (host) and tsdown (client). The toolchain itself is borrowed from a
# sibling plugin checkout that already has typescript + tsdown installed.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

HOST_MODULES="${DSH_HOST_MODULES:-$LOCALAPPDATA/DSH Desktop Rust/resources/app/node_modules}"
TOOLCHAIN="${DSH_TOOLCHAIN:-D:/workroom/dsh-usage-heatmap/node_modules}"

if [ ! -d "$HOST_MODULES/@deepseek-ai/cordis" ]; then
  echo "build: cannot locate the DSH host node_modules (set DSH_HOST_MODULES)" >&2
  exit 1
fi
if [ ! -f "$TOOLCHAIN/typescript/bin/tsc" ]; then
  echo "build: cannot locate the typescript toolchain (set DSH_TOOLCHAIN)" >&2
  exit 1
fi

link_pkg() { # <package-name> <absolute-target>
  node -e '
const fs = require("fs"), path = require("path");
const [name, target] = process.argv.slice(1);
const link = path.join("node_modules", ...name.split("/"));
fs.rmSync(link, { recursive: true, force: true });
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
' "$1" "$2"
}

# --- dependencies (junctions; the host owns the real bytes) ------------------
mkdir -p node_modules
for pkg in cordis schemastery dsh-llm; do
  [ -d "$HOST_MODULES/@deepseek-ai/$pkg" ] || { echo "build: host is missing @deepseek-ai/$pkg" >&2; exit 1; }
  link_pkg "@deepseek-ai/$pkg" "$(cd "$HOST_MODULES/@deepseek-ai/$pkg" && pwd)"
done
for pkg in @types/node; do
  [ -d "$TOOLCHAIN/$pkg" ] && link_pkg "$pkg" "$(cd "$TOOLCHAIN/$pkg" && pwd)"
done

# --- host -------------------------------------------------------------------
node "$TOOLCHAIN/typescript/bin/tsc" -p tsconfig.json

# --- client -----------------------------------------------------------------
if [ -f src/client/index.ts ]; then
  node "$TOOLCHAIN/tsdown/dist/run.mjs" || exit 1
fi

echo "build: ok -> $ROOT/lib"
