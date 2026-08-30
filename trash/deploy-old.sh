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
AUTO_RECOVER_ROLLBACK="${AUTO_RECOVER_ROLLBACK:-0}"  # 1 = auto delete/redeploy on rollback/delete_failed
CLEAN="${CLEAN:-0}"
SHOW_EVENTS="${SHOW_EVENTS:-0}"        # 1 = print last 30 stack events on failures

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
  -a, --arch ARCH                Lambda arch: x86_64 | arm64 (default: auto from template.yaml)
  -t, --target TARGET_BUCKET     Target S3 bucket for resized outputs (default: $TARGET_BUCKET)
  -b, --base SOURCE_BUCKET_BASE  Base name for source bucket (default: $SOURCE_BUCKET_BASE)
  -p, --profile AWS_PROFILE      AWS profile for CLI/SAM
  --clean                        Remove .aws-sam and src/node_modules before build
  -R, --auto-recover-rollback    Auto-delete stuck stacks (ROLLBACK_* / DELETE_FAILED) and redeploy
  --show-events                  Print last 30 stack events on failures (no pager)
  -h, --help                     Show help
EOF
}

##### HELPERS (define BEFORE use) #############################################################
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }; }
aws_cmd() {  # always disable pager; include profile if set
  if [[ -n "$PROFILE" ]]; then
    echo "aws --profile $PROFILE --no-cli-pager"
  else
    echo "aws --no-cli-pager"
  fi
}
detect_arch_from_template() {
  local found
  found="$(awk '
    /Resources:/ {res=1}
    res && /Architectures:/ {a=1; next}
    a && /- *x86_64/ {print "x86_64"; exit}
    a && /- *arm64/  {print "arm64";  exit}
  ' "$TPL" || true)"
  [[ -n "$found" ]] && echo "$found" || echo "x86_64"
}
docker_platform_from_arch() { case "$1" in x86_64) echo "linux/amd64";; arm64) echo "linux/arm64";; *) echo "linux/amd64";; esac; }
get_stack_status() {
  local status rc
  set +e
  status="$($(aws_cmd) cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
            --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"
  rc=$?
  set -e
  if [[ $rc -ne 0 || -z "$status" || "$status" == "None" ]]; then echo "STACK_NOT_FOUND"; else echo "$status"; fi
}
print_stack_events() {
  [[ "$SHOW_EVENTS" -eq 1 ]] || return 0
  echo "Recent stack events for $STACK_NAME:"
  $(aws_cmd) cloudformation describe-stack-events \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'StackEvents[0:30].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' \
    --output table || true
}
is_blocking_state() {
  case "$1" in
    ROLLBACK_COMPLETE|ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE|UPDATE_ROLLBACK_FAILED|DELETE_FAILED|DELETE_IN_PROGRESS) return 0 ;;
    *) return 1 ;;
  esac
}
list_stack_buckets() {
  $(aws_cmd) cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
    --output text 2>/dev/null || true
}
empty_bucket_versions() {
  local B="$1" tmp COUNT DM_COUNT
  while :; do
    COUNT="$($(aws_cmd) s3api list-object-versions --bucket "$B" --query 'length(Versions)' --output text 2>/dev/null || echo 0)"
    [[ "$COUNT" == "None" || "$COUNT" == "null" || -z "$COUNT" ]] && COUNT=0
    [[ "$COUNT" -eq 0 ]] && break
    tmp="$(mktemp)"
    $(aws_cmd) s3api list-object-versions --bucket "$B" \
      --query 'Versions[].{Key:Key,VersionId:VersionId}' --output json > "$tmp" || echo "[]" > "$tmp"
    if grep -qiE '^(null|none)$' "$tmp"; then rm -f "$tmp"; break; fi
    echo "{\"Objects\": $(cat "$tmp"), \"Quiet\": true}" > "$tmp.del"
    $(aws_cmd) s3api delete-objects --bucket "$B" --delete "file://$tmp.del" || true
    rm -f "$tmp" "$tmp.del"
  done
  while :; do
    DM_COUNT="$($(aws_cmd) s3api list-object-versions --bucket "$B" --query 'length(DeleteMarkers)' --output text 2>/dev/null || echo 0)"
    [[ "$DM_COUNT" == "None" || "$DM_COUNT" == "null" || -z "$DM_COUNT" ]] && DM_COUNT=0
    [[ "$DM_COUNT" -eq 0 ]] && break
    tmp="$(mktemp)"
    $(aws_cmd) s3api list-object-versions --bucket "$B" \
      --query 'DeleteMarkers[].{Key:Key,VersionId:VersionId}' --output json > "$tmp" || echo "[]" > "$tmp"
    if grep -qiE '^(null|none)$' "$tmp"; then rm -f "$tmp"; break; fi
    echo "{\"Objects\": $(cat "$tmp"), \"Quiet\": true}" > "$tmp.del"
    $(aws_cmd) s3api delete-objects --bucket "$B" --delete "file://$tmp.del" || true
    rm -f "$tmp" "$tmp.del"
  done
}
empty_bucket_all() {
  local B="$1"
  echo "Emptying bucket: $B ..."
  $(aws_cmd) s3 rm "s3://$B" --recursive --region "$REGION" || true
  empty_bucket_versions "$B"
}
empty_buckets_for_stack() {
  echo "Attempting to empty S3 buckets from stack $STACK_NAME ..."
  local buckets acct derived
  buckets="$(list_stack_buckets)"
  if [[ -z "$buckets" ]]; then
    acct="$($(aws_cmd) sts get-caller-identity --query Account --output text)"
    derived="${SOURCE_BUCKET_BASE}-${acct}-${STACK_NAME}"
    echo "Could not list buckets from stack; trying derived source bucket: $derived"
    buckets="$derived"
  fi
  for b in $buckets; do empty_bucket_all "$b"; done
}
delete_stack_and_wait() {
  echo "Deleting stuck stack $STACK_NAME ..."
  $(aws_cmd) cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" || true
  echo "Waiting for stack deletion to complete..."
  set +e
  $(aws_cmd) cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "Delete waiter failed (likely non-empty S3 bucket). Emptying buckets and retrying..."
    empty_buckets_for_stack
    echo "Retrying delete..."
    $(aws_cmd) cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" || true
    set +e
    $(aws_cmd) cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
      echo "Warning: stack deletion still failed. Check retained resources or bucket policies that block deletes."
      return 1
    fi
  fi
  echo "Stack deleted."
  return 0
}
wait_for_stack_complete() {
  local name="$1" region="$2" status=""
  echo "Waiting for CloudFormation stack to complete..."
  while :; do
    status="$($(aws_cmd) cloudformation describe-stacks --stack-name "$name" --region "$region" \
              --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "")"
    case "$status" in
      CREATE_COMPLETE|UPDATE_COMPLETE) echo "Stack status: $status"; return 0 ;;
      *_IN_PROGRESS) printf "."; sleep 6 ;;
      ROLLBACK_COMPLETE|ROLLBACK_FAILED|UPDATE_ROLLBACK_COMPLETE|UPDATE_ROLLBACK_FAILED|DELETE_FAILED)
        echo; echo "Stack entered a failure state: $status"; return 1 ;;
      ""|STACK_NOT_FOUND|None) echo; echo "Unable to read stack status (yet). Retrying..."; sleep 4 ;;
      *) echo; echo "Unexpected stack status: $status"; return 1 ;;
    esac
  done
}
###############################################################################################

##### ARG PARSE (after helpers are defined) ##################################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--stack) STACK_NAME="${2:-}"; shift 2 ;;
    -r|--region) REGION="${2:-}"; shift 2 ;;
    -a|--arch) ARCH="${2:-}"; shift 2 ;;
    -t|--target) TARGET_BUCKET="${2:-}"; shift 2 ;;
    -b|--base) SOURCE_BUCKET_BASE="${2:-}"; shift 2 ;;
    -p|--profile) PROFILE="${2:-}"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -R|--auto-recover-rollback) AUTO_RECOVER_ROLLBACK=1; shift ;;
    --show-events) SHOW_EVENTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Guard: stack name must not be empty
if [[ -z "${STACK_NAME:-}" ]]; then
  echo "ERROR: --stack STACK_NAME is required."; usage; exit 2;
fi

##### PREFLIGHT ##########################################################################
require_cmd docker
require_cmd node
require_cmd npm
require_cmd "$(aws_cmd | awk '{print $1}')"
require_cmd sam

# hand AWS_PROFILE to SAM subcommands
if [[ -n "$PROFILE" ]]; then export AWS_PROFILE="$PROFILE"; fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not running. Please start Docker Desktop and re-run."
  exit 1
fi
[[ -f "$TPL" ]] || { echo "template.yaml not found at $TPL"; exit 1; }
[[ -d "$SRC_DIR" ]] || { echo "src/ folder not found at $SRC_DIR"; exit 1; }

if [[ -z "$ARCH" ]]; then ARCH="$(detect_arch_from_template)"; fi
DOCKER_PLATFORM="$(docker_platform_from_arch "$ARCH")"
echo "Effective: stack=$STACK_NAME region=$REGION profile=${PROFILE:-<default>} arch=$ARCH docker=$DOCKER_PLATFORM"
echo "Pulling build image: $BUILD_IMAGE"
docker pull --platform "$DOCKER_PLATFORM" "$BUILD_IMAGE" >/dev/null

if [[ "$CLEAN" -eq 1 ]]; then
  echo "Cleaning build artifacts..."
  rm -rf "$ROOT_DIR/.aws-sam" "$SRC_DIR/node_modules" "$SRC_DIR/package-lock.json"
fi

echo "Verifying AWS identity..."
$(aws_cmd) sts get-caller-identity --region "$REGION" >/dev/null

# Install deps in the build image (for sharp on AL2023)
echo "Installing node modules inside build image..."
docker run --rm --platform "$DOCKER_PLATFORM" -v "$SRC_DIR":/var/task -w /var/task "$BUILD_IMAGE" \
  bash -lc '
    set -euo pipefail
    if [[ ! -f package.json ]]; then npm init -y >/dev/null; fi
    if [[ -f package-lock.json ]]; then npm ci; else npm i; fi
    node -e "try{require(\"sharp\");process.exit(0)}catch(e){process.exit(1)}" || npm i sharp@^0.33.3
    node -e "require(\"sharp\");console.log(\"sharp ready\")"
  '

# Build with SAM (container)
echo "Building with SAM..."
if [[ "$(uname -m)" == "arm64" && "$ARCH" == "x86_64" ]]; then export DOCKER_DEFAULT_PLATFORM=linux/amd64; fi
sam build --use-container

# Pre-deploy: clear blocking states
CURRENT_STATUS="$(get_stack_status)"
if is_blocking_state "$CURRENT_STATUS"; then
  echo "Detected blocking stack state: $CURRENT_STATUS"
  if [[ "$AUTO_RECOVER_ROLLBACK" -eq 1 ]]; then
    delete_stack_and_wait || true
  else
    echo "Re-run with -R/--auto-recover-rollback to auto-delete the stuck stack."; exit 2
  fi
fi

##### DEPLOY + WAIT ######################################################################
echo "Deploying stack: $STACK_NAME ..."
PARAMS=(
  "--stack-name" "$STACK_NAME"
  "--capabilities" "CAPABILITY_IAM"
  "--region" "$REGION"
  "--parameter-overrides" "TargetBucketName=$TARGET_BUCKET" "SourceBucketName=$SOURCE_BUCKET_BASE"
  "--no-confirm-changeset"
)
set +e
sam deploy "${PARAMS[@]}"
DEPLOY_RC=$?
set -e

if [[ $DEPLOY_RC -ne 0 ]]; then
  echo "sam deploy failed with exit code $DEPLOY_RC"
  STATUS_AFTER="$(get_stack_status)"; print_stack_events
  if is_blocking_state "$STATUS_AFTER"; then
    echo "Stack is in blocking state: $STATUS_AFTER"
    if [[ "$AUTO_RECOVER_ROLLBACK" -eq 1 ]]; then
      delete_stack_and_wait || true
      echo "Retrying deployment..."
      set +e; sam deploy "${PARAMS[@]}"; RETRY_RC=$?; set -e
      if [[ $RETRY_RC -ne 0 ]]; then
        echo "Redeploy after recovery failed (exit $RETRY_RC)."; print_stack_events; exit $RETRY_RC
      fi
    else
      echo "Re-run with -R/--auto-recover-rollback to auto-delete and redeploy."; exit $DEPLOY_RC
    fi
  else
    echo "Stack not in rollback/delete_failed; investigate with:"
    echo "$(aws_cmd) cloudformation describe-stack-events --stack-name $STACK_NAME --region $REGION --output table --query 'StackEvents[0:30].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]'"
    exit $DEPLOY_RC
  fi
fi

wait_for_stack_complete "$STACK_NAME" "$REGION" || { print_stack_events; exit 1; }

##### SUCCESS: OUTPUTS + SMOKE TEST ######################################################
echo
echo "Stack outputs:"
$(aws_cmd) cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table || true

SRC_BUCKET="$($(aws_cmd) cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucketNameOutput'].OutputValue" --output text 2>/dev/null || true)"
if [[ -z "$SRC_BUCKET" || "$SRC_BUCKET" == "None" ]]; then
  ACCT="$($(aws_cmd) sts get-caller-identity --query Account --output text)"
  SRC_BUCKET="${SOURCE_BUCKET_BASE}-${ACCT}-${STACK_NAME}"
fi

echo
echo "Source bucket (created): $SRC_BUCKET"
TEST_FILE="/System/Library/CoreServices/DefaultDesktop.jpg"
DEST_KEY="uploads/deploy-smoke-$(date +%s).jpg"
if [[ -f "$TEST_FILE" ]]; then
  echo "Uploading smoke test image to s3://$SRC_BUCKET/$DEST_KEY ..."
  $(aws_cmd) s3 cp "$TEST_FILE" "s3://$SRC_BUCKET/$DEST_KEY" --region "$REGION"
else
  echo "Smoke test image not found at $TEST_FILE. Skipping upload."
fi

echo
echo "SQS -> Lambda mapping status:"
$(aws_cmd) lambda list-event-source-mappings --function-name ImageProcessorFunction --region "$REGION" \
  --query "EventSourceMappings[].{State:State,LastProcessingResult:LastProcessingResult,UUID:UUID}" --output table || true

echo
echo "Tailing function logs for 60s..."
$(aws_cmd) logs tail "/aws/lambda/ImageProcessorFunction" --since 2m --region "$REGION" --format detailed --follow || true

echo
echo "Recent objects in target bucket ($TARGET_BUCKET) under 'resized/' ..."
$(aws_cmd) s3 ls "s3://$TARGET_BUCKET/resized/" --recursive --region "$REGION" | tail -n 40 || true

echo
echo "Done."
