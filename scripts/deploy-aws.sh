#!/usr/bin/env bash
# One-command AWS deploy for hadron-pauser (ECS Fargate).
#
# It creates/updates the Secrets Manager entries, builds and pushes the image
# to ECR, and applies the terraform module (ECS cluster + service + task roles
# + S3 snapshot bucket + CloudWatch logs). Safe to re-run: everything is
# create-or-update, and terraform owns the infrastructure state.
#
#   ./scripts/deploy-aws.sh --key ./pauser-keypair.json
#
# Options (all optional except --key on the first run):
#   --key PATH        pauser keypair file (JSON byte array or bs58) -> Secrets Manager
#   --config PATH     config document (default ./config.json)
#   --name NAME       deployment name, prefixes every AWS resource (default hadron-pauser)
#   --region REGION   default us-east-1  (use a non-US region if a pool uses a binance ref)
#   --profile NAME    AWS CLI profile (default: current credentials)
#   --yes             skip the terraform approval prompt
#
# Prereqs: aws, docker, terraform, python3. The pauser keypair is NEVER
# generated here — supply your own.
set -euo pipefail

NAME="hadron-pauser"; REGION="us-east-1"; CONFIG="config.json"; KEYFILE=""; PROFILE=""; AUTO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEYFILE="$2"; shift 2;;
    --config) CONFIG="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --yes) AUTO="-auto-approve"; shift;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
[ -n "$PROFILE" ] && export AWS_PROFILE="$PROFILE"

for tool in aws docker terraform python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
[ -f "$CONFIG" ] || { echo "config not found: $CONFIG (copy config.example.json)" >&2; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "==> account $ACCOUNT | region $REGION | name $NAME"

# --- 1. secrets -------------------------------------------------------------
# put_secret NAME VALUE -> prints the ARN. Create-or-update, value never echoed.
put_secret() {
  local id="$1" value="$2" arn
  arn="$(aws secretsmanager create-secret --name "$id" --secret-string "$value" \
        --query ARN --output text 2>/dev/null || true)"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    aws secretsmanager put-secret-value --secret-id "$id" --secret-string "$value" >/dev/null
    arn="$(aws secretsmanager describe-secret --secret-id "$id" --query ARN --output text)"
  fi
  printf '%s' "$arn"
}

if [ -n "$KEYFILE" ]; then
  [ -f "$KEYFILE" ] || { echo "keypair not found: $KEYFILE" >&2; exit 1; }
  PAUSER_ARN="$(put_secret "${NAME}/pauser-secret" "$(tr -d '\n' < "$KEYFILE")")"
  echo "==> pauser secret stored"
else
  PAUSER_ARN="$(aws secretsmanager describe-secret --secret-id "${NAME}/pauser-secret" \
                --query ARN --output text 2>/dev/null || true)"
  [ -n "$PAUSER_ARN" ] && [ "$PAUSER_ARN" != "None" ] || {
    echo "no stored pauser secret; pass --key PATH on the first deploy" >&2; exit 1; }
  echo "==> reusing stored pauser secret"
fi

# Optional secrets come from the environment (or a local .env, which is only
# read here — it is never copied into the image or terraform state).
[ -f .env ] && set -a && . ./.env && set +a
declare -a TFSECRETS=()
add_optional() { # add_optional ENV_VAR secret-suffix tf_var
  local val="${!1:-}"; [ -n "$val" ] || return 0
  local arn; arn="$(put_secret "${NAME}/$2" "$val")"
  TFSECRETS+=("$3=$arn"); echo "==> $2 secret stored"
}
add_optional GRPC_API_KEY       grpc-token        grpc_token_secret_arn
add_optional GRPC_ENDPOINT      grpc-endpoint     grpc_endpoint_secret_arn
add_optional RPC_URL_PRIMARY    rpc-url-primary   rpc_url_primary_secret_arn
add_optional RPC_URL_FALLBACK   rpc-url-fallback  rpc_url_fallback_secret_arn

# --- 2. config: force the keypair to the injected env secret ----------------
CONFIG_JSON="$(python3 - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
# On ECS the key arrives as an env secret, never a file path.
cfg["pauserKeypair"] = "env:PAUSER_SECRET"
for k in list(cfg):
    if k.startswith("_"):
        del cfg[k]
for p in cfg.get("pools", []):
    for k in list(p):
        if k.startswith("_"):
            del p[k]
    for r in p.get("refs", []):
        for k in list(r):
            if k.startswith("_"):
                del r[k]
print(json.dumps(cfg, separators=(",", ":")))
PY
)"
# Guard: nothing secret-shaped may land in terraform state via config_json.
if printf '%s' "$CONFIG_JSON" | grep -qE "hooks\.slack\.com/services/[A-Za-z0-9]+|g\.alchemy\.com/v2/[A-Za-z0-9_-]{8,}"; then
  echo "config_json contains a literal credential — use \"env:NAME\" references instead" >&2
  exit 1
fi

# --- 3. ECR repo (created by terraform, so target it first) -----------------
cd terraform
terraform init -input=false >/dev/null
terraform workspace select "$NAME" 2>/dev/null || terraform workspace new "$NAME" >/dev/null
BOOTSTRAP_VARS=(-var "name=$NAME" -var "region=$REGION" -var "image=bootstrap"
                -var "config_json=$CONFIG_JSON" -var "pauser_secret_arn=$PAUSER_ARN")
for kv in "${TFSECRETS[@]}"; do BOOTSTRAP_VARS+=(-var "$kv"); done
terraform apply -input=false -auto-approve -target=aws_ecr_repository.this "${BOOTSTRAP_VARS[@]}" >/dev/null
ECR="$(terraform output -raw ecr_repository_url)"
cd "$ROOT"
echo "==> ecr $ECR"

# --- 4. build + push (linux/amd64: no linux-arm64 yellowstone binding) ------
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ECR%%/*}" >/dev/null
docker build --platform linux/amd64 -t "$ECR:latest" . >/dev/null
docker push -q "$ECR:latest" >/dev/null
echo "==> image pushed"

# --- 5. apply ---------------------------------------------------------------
cd terraform
APPLY_VARS=(-var "name=$NAME" -var "region=$REGION" -var "image=$ECR:latest"
            -var "config_json=$CONFIG_JSON" -var "pauser_secret_arn=$PAUSER_ARN")
for kv in "${TFSECRETS[@]}"; do APPLY_VARS+=(-var "$kv"); done
terraform apply -input=false $AUTO "${APPLY_VARS[@]}"

# `:latest` is a stable tag, so terraform sees no diff on a code-only change.
aws ecs update-service --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null 2>&1 || true

cat <<EOF

deployed.
  logs:    aws logs tail /ecs/$NAME --follow --region $REGION
  status:  aws ecs describe-services --cluster $NAME --services $NAME --region $REGION \\
             --query 'services[0].{running:runningCount,desired:desiredCount,deploy:deployments[0].rolloutState}'
  teardown: cd terraform && terraform destroy -var name=$NAME -var region=$REGION \\
             -var image=$ECR:latest -var 'config_json={}' -var pauser_secret_arn=$PAUSER_ARN

The service starts in whatever mode config.json says — keep dryRun:true +
mode:"shadow" until you have soaked it.
EOF
