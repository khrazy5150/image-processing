#!/usr/bin/env bash
set -euo pipefail

# No pagers
export AWS_PAGER="" AWS_CLI_PAGER="" PAGER=""

##### CONFIG DEFAULTS (override with flags or env) ############################################
STACK_NAME="${STACK_NAME:-image-processing-stack}"
REGION="${REGION:-us-west-2}"
ARCH="${ARCH:-}"                       # auto-detect from template.yaml if empty: x86_64|arm64
TARGET_BUCKET="${TARGET_BUCKET:-images.juniorbay.net}"
SOURCE_BUCKET_BASE="${SOURCE_BUCKET_BASE:-image-processor-source}"
PROFILE="${PROFILE:-}"                 # e.g. default
TABLE_NAME="${TABLE_NAME:-image_processing_metadata}"
CDN_BASE="${CDN_BASE:-https://images.juniorbay.net}"
AUTO_RECOVER_ROLLBACK="${AUTO_RECOVER_ROLLBACK:-0}"  # 1 = auto delete/redeploy on rollback/delete_failed
CLEAN="${CLEAN:-0}"
SHOW_EVENTS="${SHOW_EVENTS:-0}"        # 1 = print last 30 stack events on failures (no pager)

BUILD_IMAGE="public.ecr.aws/sam/build-nodejs20.x:latest"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$ROOT_DIR/src"
TPL="$ROOT_DIR/template.yaml"
###############################################################################################

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]
  -s, --stack STACK_NAME         CloudFormation stack name (default: $STACK_NAME)
  -r, --region REGION            AWS region (default: $REGION)
  -a, --arch ARCH                Lambda arch: x86_64 | arm64 (default: auto from template.yaml, else x86_64)
  -t, --target TARGET_BUCKET     Target S3 bucket for resized outputs (default: $TARGET_BUCKET)
  -b, --base SOURCE_BUCKET_BASE  Base name for source bucket (default: $SOURCE_BUCKET_BASE)
  --table TABLE_NAME           DynamoDB table name (default: $TABLE_NAME)
  --cdn CDN_BASE                 CDN base URL for image URLs (default: $CDN_BASE)
  -p, --profile AWS_PROFILE      AWS profile for CLI/SAM
  --clean                        Remove .aws-sam and src/node_modules before build
  -R, --auto-recover-rollback    Auto-delete stuck stacks (ROLLBACK_* / DELETE_FAILED) and redeploy
  --show-events                  Print last 30 stack events on failures (no pager)
  -h, --help                     Show help
EOF
}

##### HELPERS ################################################################################
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1"; exit 1; }; }

# Wrappers without arrays (safe with `set -u` on older bash)
aws_cli() {
  if [[ -n "${PROFILE:-}" ]]; then
    aws --profile "$PROFILE" "$@"
  else
    aws "$@"
  fi
}

sam_cli() {
  if [[ -n "${PROFILE:-}" ]]; then
    sam --profile "$PROFILE" "$@"
  else
    sam "$@"
  fi
}

stack_exists() {
  aws_cli cloudformation describe-stacks \
    --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].StackStatus" --output text >/dev/null 2>&1
}

get_stack_status() {
  aws_cli cloudformation describe-stacks \
    --region "$REGION" --stack-name "$STACK_NAME" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || true
}

is_blocking_state() {
  case "$1" in
    ROLLBACK_COMPLETE|ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE|UPDATE_ROLLBACK_FAILED|DELETE_FAILED|DELETE_IN_PROGRESS) return 0 ;;
    *) return 1 ;;
  esac
}

list_stack_buckets() {
  aws_cli cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
    --output text 2>/dev/null || true
}

empty_bucket_versions() {
  local B="$1"
  echo "Emptying ALL versions in s3://$B ..."
  while true; do
    local VERS OUT
    VERS="$(aws_cli s3api list-object-versions --bucket "$B" \
      --query 'length(Versions) + length(DeleteMarkers)' --output text 2>/dev/null || echo 0)"
    [[ "$VERS" == "0" || -z "$VERS" ]] && break
    aws_cli s3api delete-objects --bucket "$B" --delete "$(
      aws_cli s3api list-object-versions --bucket "$B" \
        --query '{Objects: Versions[].{Key:Key, VersionId:VersionId}, Quiet: true}' \
        --output json
    )" >/dev/null || true
    aws_cli s3api delete-objects --bucket "$B" --delete "$(
      aws_cli s3api list-object-versions --bucket "$B" \
        --query '{Objects: DeleteMarkers[].{Key:Key, VersionId:VersionId}, Quiet: true}' \
        --output json
    )" >/dev/null || true
  done
}

delete_bucket_if_exists() {
  local B="$1"
  if aws_cli s3api head-bucket --bucket "$B" 2>/dev/null; then
    echo "Emptying and deleting existing bucket: $B"
    empty_bucket_versions "$B" || true
    aws_cli s3 rb "s3://$B" --force >/dev/null || true
  fi
}

##### ARG PARSE ###############################################################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--stack) STACK_NAME="$2"; shift 2 ;;
    -r|--region) REGION="$2"; shift 2 ;;
    -a|--arch) ARCH="$2"; shift 2 ;;
    -t|--target) TARGET_BUCKET="$2"; shift 2 ;;
    -b|--base) SOURCE_BUCKET_BASE="$2"; shift 2 ;;
    --table) TABLE_NAME="$2"; shift 2 ;;
    --cdn) CDN_BASE="$2"; shift 2 ;;
    -p|--profile) PROFILE="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -R|--auto-recover-rollback) AUTO_RECOVER_ROLLBACK=1; shift ;;
    --show-events) SHOW_EVENTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

##### PRECHECKS ###############################################################################
require_cmd aws
require_cmd sam
require_cmd docker
require_cmd node

[[ -f "$TPL" ]] || { echo "Missing template: $TPL"; exit 1; }
[[ -d "$SRC_DIR" ]] || { echo "Missing source dir: $SRC_DIR"; exit 1; }

# Auto-detect Architecture from template.yaml (no external deps)
if [[ -z "$ARCH" ]]; then
  if grep -q 'ImageProcessorFunction:' "$TPL"; then
    # Try Architectures: [x86_64] or Architectures: [arm64]
    ARCH="$(awk '/ImageProcessorFunction:/{flag=1} flag && /Architectures:/ {gsub(/\[|\]|,*/,"",$0); print $2; exit}' "$TPL" || true)"
    # Fallback to singular Architecture: value
    if [[ -z "$ARCH" ]]; then
      ARCH="$(awk '/ImageProcessorFunction:/{flag=1} flag && /Architecture:/ {print $2; exit}' "$TPL" || true)"
    fi
  fi
  [[ -z "$ARCH" ]] && ARCH="x86_64"
fi
echo "Resolved Architecture: $ARCH"

if [[ "$CLEAN" -eq 1 ]]; then
  echo "Cleaning build artifacts..."
  rm -rf "$ROOT_DIR/.aws-sam" "$SRC_DIR/node_modules"
fi

##### ENV VARS TO PASS INTO DEPLOY ############################################################
PARAM_OVERRIDES=(
  "SourceBucketName=$SOURCE_BUCKET_BASE"
  "TargetBucketName=$TARGET_BUCKET"
  "ImageMetadataTableName=$TABLE_NAME"
  "CdnBase=$CDN_BASE"
)

# Docker platform for cross-arch builds (for the build container)
DOCKER_PLATFORM="linux/amd64"
[[ "$ARCH" == "arm64" ]] && DOCKER_PLATFORM="linux/arm64"

echo "Using Docker platform: $DOCKER_PLATFORM"
echo "Region: $REGION  Stack: $STACK_NAME"

##### VERIFY AWS CALLER #######################################################################
echo "Verifying AWS identity..."
aws_cli sts get-caller-identity --region "$REGION" >/dev/null

##### ESM SAFEGUARD (SHELL-ONLY) ##############################################################
echo "Ensuring ESM (type: module) in $SRC_DIR/package.json ..."

# If package.json doesn't exist, create a minimal one
if [[ ! -f "$SRC_DIR/package.json" ]]; then
  cat > "$SRC_DIR/package.json" <<'JSON'
{
  "name": "image-processor",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "imageProcessorApp.js",
  "module": "imageProcessorApp.js"
}
JSON
else
  # If jq is available, use it to safely enforce keys
  if command -v jq >/dev/null 2>&1; then
    tmp="$(mktemp)"
    jq '
      .type = "module"
      | .engines = (.engines // {}) | .engines.node = ">=20"
      | .main = (.main // "imageProcessorApp.js")
      | .module = (.module // "imageProcessorApp.js")
    ' "$SRC_DIR/package.json" > "$tmp" && mv "$tmp" "$SRC_DIR/package.json"
  else
    # Fallback: sed insert if missing
    if ! grep -q '"type"' "$SRC_DIR/package.json"; then
      sed -i.bak '1 a\  "type": "module",' "$SRC_DIR/package.json"
    fi
    if ! grep -q '"engines"' "$SRC_DIR/package.json"; then
      sed -i.bak '1 a\  "engines": { "node": ">=20" },' "$SRC_DIR/package.json"
    else
      if ! grep -q '"node":' "$SRC_DIR/package.json"; then
        sed -i.bak 's/"engines": {/"engines": { "node": ">=20",/' "$SRC_DIR/package.json"
      fi
    fi
    # 3) Ensure main/module defaults if missing
    grep -q '"main"' "$SRC_DIR/package.json" || sed -i.bak '1 a\  "main": "imageProcessorApp.js",' "$SRC_DIR/package.json"
    grep -q '"module"' "$SRC_DIR/package.json" || sed -i.bak '1 a\  "module": "imageProcessorApp.js",' "$SRC_DIR/package.json"
    rm -f "$SRC_DIR/package.json.bak" 2>/dev/null || true
  fi
fi

echo "package.json ensured as ESM."

##### INSTALL DEPS INSIDE SAM NODE20 CONTAINER (sharp for AL2023) ############################
echo "Installing node modules inside build image..."
docker run --rm --platform "$DOCKER_PLATFORM" -v "$SRC_DIR":/var/task -w /var/task "$BUILD_IMAGE" \
  bash -lc '
    set -euo pipefail
    if [[ ! -f package.json ]]; then npm init -y >/dev/null; fi
    if [[ -f package-lock.json ]]; then npm ci; else npm i; fi
    node -e "try{require(\"sharp\");process.exit(0)}catch(e){process.exit(1)}" || npm i sharp@^0.34.3
    node -e "require(\"sharp\");console.log(\"sharp ready\")"
  '

##### SAM BUILD ###############################################################################
echo "Building with SAM..."
# If host is arm64 but target arch is x86_64, help Docker choose the right platform
if [[ "$(uname -m)" == "arm64" && "$ARCH" == "x86_64" ]]; then export DOCKER_DEFAULT_PLATFORM=linux/amd64; fi
sam_cli build --use-container

##### HANDLE PRE-EXISTING BLOCKING STATES #####################################################
if stack_exists; then
  STATUS="$(get_stack_status)"
  if is_blocking_state "$STATUS"; then
    echo "Stack is in blocking state: $STATUS"
    if [[ "$AUTO_RECOVER_ROLLBACK" -eq 1 ]]; then
      echo "Attempting auto-recover: deleting stack..."
      aws_cli cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" || true
      echo "Waiting for deletion..."
      aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION" || true

      # Buckets created by previous stack may block re-deploy; remove them
      echo "Pruning leftover buckets from previous stack (if any)..."
      for B in $(list_stack_buckets); do
        delete_bucket_if_exists "$B"
      done
    else
      echo "Re-run with -R/--auto-recover-rollback to auto-clean and redeploy."
      exit 2
    fi
  fi
fi

##### DEPLOY ##################################################################################
echo "Deploying stack: $STACK_NAME"
set +e
sam_cli deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "${PARAM_OVERRIDES[@]}"
RC=$?
set -e

if [[ "$RC" -ne 0 ]]; then
  echo "sam deploy failed with code $RC"
  echo "Stack status: $(get_stack_status)"
  if [[ "$SHOW_EVENTS" -eq 1 ]]; then
    echo "Recent stack events:"
    aws_cli cloudformation describe-stack-events \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --max-items 30 --output table || true
  fi

  # Attempt auto-recover on rollback states
  STATUS="$(get_stack_status)"
  if is_blocking_state "$STATUS" && [[ "$AUTO_RECOVER_ROLLBACK" -eq 1 ]]; then
    echo "Auto-recover: deleting stack and retrying deploy..."
    aws_cli cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" || true
    aws_cli cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION" || true

    for B in $(list_stack_buckets); do
      delete_bucket_if_exists "$B"
    done

    echo "Retrying deploy..."
    sam_cli deploy \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --capabilities CAPABILITY_IAM \
      --parameter-overrides "${PARAM_OVERRIDES[@]}"
  else
    exit "$RC"
  fi
fi

##### OUTPUTS #################################################################################
aws_cli cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue,Description]" \
  --output table

##### OPTIONAL: SHOW LAST EVENTS ON FAILURE ###################################################
if [[ "$SHOW_EVENTS" -eq 1 ]]; then
  echo
  echo "Recent stack events:"
  aws_cli cloudformation describe-stack-events \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --max-items 30 --output table || true
fi

echo "Done."
