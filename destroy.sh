#!/usr/bin/env bash
set -euo pipefail

# Safe destroy helper. It will:
#  * Empty the SOURCE bucket completely
#  * Delete ONLY the specified prefix in TARGET bucket (default: photos/ and resized/)
#  * Optionally delete the NEW DynamoDB table
#  * Delete the CloudFormation stack
#
# Usage:
#   ./destroy.sh --stack image-processing-stack --region us-west-2 \
#                --source-bucket image-processor-source-150544707159-image-processing-stack \
#                --target-bucket images.juniorbay.net \
#                --target-prefix resized/ \
#                --table image_processing_metadata \
#                --i-understand-the-risks

STACK=""; REGION=""; SRC_BUCKET=""; TGT_BUCKET=""; TGT_PREFIX="photos/"; TABLE=""; CONFIRM=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --source-bucket) SRC_BUCKET="$2"; shift 2;;
    --target-bucket) TGT_BUCKET="$2"; shift 2;;
    --target-prefix) TGT_PREFIX="$2"; shift 2;;
    --table) TABLE="$2"; shift 2;;
    --i-understand-the-risks) CONFIRM=1; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ $CONFIRM -ne 1 ]]; then
  echo "Refusing to run without --i-understand-the-risks"; exit 1
fi
if [[ -z "$REGION" || -z "$STACK" ]]; then echo "--stack and --region required"; exit 1; fi

# Empty SOURCE bucket (all keys)
if [[ -n "$SRC_BUCKET" ]]; then
  echo "Emptying source bucket: s3://$SRC_BUCKET"
  aws s3 rm "s3://$SRC_BUCKET" --recursive --region "$REGION" || true
fi

# Prune ONLY the target prefix (do NOT delete whole bucket!)
if [[ -n "$TGT_BUCKET" && -n "$TGT_PREFIX" ]]; then
  echo "Pruning target prefix: s3://$TGT_BUCKET/$TGT_PREFIX"
  aws s3 rm "s3://$TGT_BUCKET/$TGT_PREFIX" --recursive --region "$REGION" || true
fi

# Optional: delete new table
if [[ -n "$TABLE" ]]; then
  echo "Deleting DynamoDB table: $TABLE"
  aws dynamodb delete-table --table-name "$TABLE" --region "$REGION" || true
  echo "Waiting for table deletion..."
  aws dynamodb wait table-not-exists --table-name "$TABLE" --region "$REGION" || true
fi

# Delete stack (leaves target bucket intact)
aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
echo "Waiting for stack delete..."
aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
echo "Done."