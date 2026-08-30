#!/usr/bin/env bash
set -Eeuo pipefail

REGION=us-west-2
ACCOUNT_ID=150544707159
SRC_BUCKET=image-processor-source-150544707159-image-processing-stack
QUEUE_NAME=image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e

echo "Check bucket notification configuration"
aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json | jq .

echo "*********************************"
echo "Put a tiny test object to trigger S3->SQS"
echo "ping $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | aws s3 cp - "s3://$SRC_BUCKET/uploads/test-ping.txt" --region "$REGION" >/dev/null

# give S3 a moment to enqueue
sleep 3

QURL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query QueueUrl --output text)

echo "*********************************"
echo "Queue depth after put-object"
aws sqs get-queue-attributes \
  --queue-url "$QURL" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

echo "*********************************"
echo "Peek at one message body (if any)"
aws sqs receive-message \
  --queue-url "$QURL" --region "$REGION" \
  --max-number-of-messages 1 \
  --visibility-timeout 0 \
  --wait-time-seconds 0 \
  --query 'Messages[0].Body' --output text | jq . 2>/dev/null || echo "null"
