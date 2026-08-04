#!/usr/bin/env bash
# Build the customer-facing export: a clean copy with its own git history,
# no local artifacts (.env, config.json, soak logs, state, node_modules) and
# no internal-only files (CLAUDE.md, our assistant notes). llms.txt DOES ship —
# it is the operator's own AI-onboarding playbook and stands alone.
# Verifies from scratch: fresh install, typecheck, tests, build, secret scan.
#
# Usage: ./scripts/release.sh [dest]   (default ../hadron-pauser-release)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$SRC/../hadron-pauser-release}"
OUT="$DEST/hadron-pauser"

rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a \
  --exclude '/node_modules/' --exclude '/dist/' --exclude '/state/' \
  --exclude '/.env' --exclude '/config.json' --exclude '/config.aws-test.json' \
  --exclude '/soak-*.log' --exclude '/CLAUDE.md' \
  --exclude '/package-lock.json' \
  --exclude 'terraform/.terraform/' --exclude 'terraform/*.tfstate*' \
  --exclude 'terraform/terraform.tfvars.json' --exclude '*.tmp' \
  "$SRC/" "$OUT/"

cd "$OUT"
git init -q
git add -A
git -c user.email=eng@hadron.fi -c user.name="Hadron" \
  commit -qm "hadron-pauser v0.1.0 — open-source one-way pause-authority watchdog for Hadron pools"

# Secret scan: fail loudly rather than ship a credential. Patterns match real
# credential shapes (long suffixes), so docs that mention a prefix like
# `xoxb-…` don't trip it. The scanner itself is excluded.
if git ls-files -z | grep -zv '^scripts/release\.sh$' | xargs -0 grep -l -E \
  "hooks\.slack\.com/services/[A-Za-z0-9]+|xoxb-[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{20,}|g\.alchemy\.com/v2/[A-Za-z0-9_-]{8,}|[1-9A-HJ-NP-Za-km-z]{80,}" 2>/dev/null | grep .; then
  echo "SECRET SCAN FAILED (files above)" >&2; exit 1
fi

npm install --no-audit --no-fund >/dev/null
npm run typecheck
npm test
npm run build >/dev/null
rm -rf node_modules dist   # ship source only

# The container is the delivery format for most operators, so prove it builds
# and that the Yellowstone native binding loads (the Dockerfile asserts it).
if command -v docker >/dev/null; then
  docker build -q -t hadron-pauser:release . >/dev/null
  echo "docker image builds (linux/amd64, native binding verified)"
fi

# Tarball from git archive, so it is exactly the committed tree — never local
# junk like terraform provider binaries that rsync/tar would otherwise sweep in.
TARBALL="$DEST/hadron-pauser-$(node -p "require('./package.json').version").tar.gz"
git archive --format=tar.gz --prefix=hadron-pauser/ -o "$TARBALL" HEAD

echo "release ready: $OUT ($(git ls-files | wc -l | tr -d ' ') files)"
echo "tarball:       $TARBALL ($(du -h "$TARBALL" | cut -f1))"
