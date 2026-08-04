#!/usr/bin/env bash
# MAINTAINERS ONLY — requires the hadron monorepo layout (../../sdks).
# Vendors @hadron-fi/stream + @hadron-fi/observability sources into src/vendor/.
# Those packages are private npm; hadron-pauser is open-source and self-contained,
# so we copy rather than depend (decision 2026-08-04). Re-run after upstream
# changes. Rewrites extensionless relative imports to NodeNext-style ".js".
# Downstream users never need this: src/vendor/ ships in the repo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDKS="${SDKS:-$ROOT/../../sdks}"
for pkg in stream observability; do
  src="$SDKS/hadron-$pkg-ts/src"
  dst="$ROOT/src/vendor/$pkg"
  [ -d "$src" ] || { echo "missing $src" >&2; exit 1; }
  rm -rf "$dst"; mkdir -p "$dst"
  cp "$src"/*.ts "$dst/"
  perl -pi -e 's/(from\s+"\.\/[A-Za-z0-9_-]+)"/$1.js"/g' "$dst"/*.ts
  ver="$(node -p "require('$SDKS/hadron-$pkg-ts/package.json').version")"
  printf 'Vendored from @hadron-fi/%s@%s (sdks/hadron-%s-ts src). Do not edit by hand; re-run scripts/vendor.sh\n' "$pkg" "$ver" "$pkg" > "$dst/VENDORED.txt"
done
echo "vendored ok"
