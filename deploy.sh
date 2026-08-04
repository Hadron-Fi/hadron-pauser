#!/usr/bin/env bash
# Deploy hadron-pauser to Railway (the `monitoring` project).
#
# One-time setup:
#   railway login
#   railway link                 # link this directory to the `monitoring` project
#   # NO NPM_TOKEN needed: @hadron-fi/sdk-v2 is public npm and the
#   # stream/observability layers are vendored into src/vendor.
#
# Set env vars on the Railway service (dashboard, or):
#   railway variables --service hadron-pauser \
#     --set "PAUSER_SECRET=..." --set "GRPC_API_KEY=..." \
#     --set "CONFIG_JSON=$(cat config.json)"
#
# Usage: ./deploy.sh
set -euo pipefail

SERVICE="${SERVICE:-hadron-pauser}"

if ! command -v railway >/dev/null 2>&1; then
  echo "Error: Railway CLI not found. Install with: npm i -g @railway/cli"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required by deploy.sh for JSON parsing."
  exit 1
fi

service_exists() {
  local target="$1" status_json
  status_json="$(railway status --json 2>/dev/null || true)"
  [[ -z "${status_json}" ]] && return 1
  printf "%s" "${status_json}" | python3 -c '
import json, sys
target = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw: raise SystemExit(1)
s = raw.find("{"); e = raw.rfind("}")
if s == -1 or e == -1 or e <= s: raise SystemExit(1)
data = json.loads(raw[s:e+1])
for env_edge in data.get("environments", {}).get("edges", []):
    env = env_edge.get("node", {})
    if env.get("name") != "production": continue
    for svc_edge in env.get("serviceInstances", {}).get("edges", []):
        if svc_edge.get("node", {}).get("serviceName") == target: raise SystemExit(0)
raise SystemExit(1)
' "$target"
}

ensure_service() {
  local service="$1"
  service_exists "$service" && return
  echo "Service '${service}' not found. Creating..."
  railway add --service "$service" >/dev/null 2>&1 || true
}

ensure_service "${SERVICE}"
echo "Deploying ${SERVICE}..."
railway up --service "${SERVICE}" --detach
echo "Done. Deploy submitted."
