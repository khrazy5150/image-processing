#!/usr/bin/env bash
set -Eeuo pipefail

REGION=us-west-2
ACCOUNT_ID=150544707159
SRC_BUCKET=image-processor-source-150544707159-image-processing-stack
QUEUE_ARN=arn:aws:sqs:us-west-2:${ACCOUNT_ID}:image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e

echo "Apply a clean bucket notification (explicit, minimal)"
# Re-post a minimal, known-good config (all create events, no filter)
cat > /tmp/s3-notif.json <<JSON
{
  "QueueConfigurations": [
    {
      "Id": "on-upload-any-prefix",
      "QueueArn": "${QUEUE_ARN}",
      "Events": ["s3:ObjectCreated:*"]
    }
  ]
}
JSON

aws s3api put-bucket-notification-configuration \
  --bucket "$SRC_BUCKET" \
  --notification-configuration file:///tmp/s3-notif.json

aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json | jq .


echo "*********************************"
echo "Assert the SQS resource policy (canonical)"
QUEUE_NAME=image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e
QURL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query QueueUrl --output text)

cat > sqs-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowS3SendMessageFromSourceBucket",
    "Effect": "Allow",
    "Principal": { "Service": "s3.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}",
    "Condition": {
      "ArnEquals":    { "aws:SourceArn": "arn:aws:s3:::${SRC_BUCKET}" },
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" }
    }
  }]
}
JSON

POLICY=$(jq -c . sqs-policy.json)
aws sqs set-queue-attributes \
  --queue-url "$QURL" \
  --region "$REGION" \
  --attributes "{\"Policy\":$(jq -Rs . sqs-policy.json)}"

# Show final policy (human-readable)
aws sqs get-queue-attributes --queue-url "$QURL" --region "$REGION" --attribute-names Policy | jq -r .Attributes.Policy | jq .

echo "*********************************"
echo "Smoke test S3→SQS with a tiny object"
# Put a small object (portable; no temp file needed)
echo "ping $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | aws s3 cp - "s3://${SRC_BUCKET}/uploads/test-ping.txt" --region "$REGION" >/dev/null

# Give S3 a couple seconds to deliver
sleep 4

# Queue depth
aws sqs get-queue-attributes \
  --queue-url "$QURL" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Peek one message (if any)
aws sqs receive-message \
  --queue-url "$QURL" --region "$REGION" \
  --max-number-of-messages 1 \
  --visibility-timeout 0 \
  --wait-time-seconds 0 \
  --query 'Messages[0].Body' --output text | jq . 2>/dev/null || echo "null"

echo "*********************************"
echo "(Isolation) Wire a temporary debug queue and prove delivery"
# Create a throwaway queue
DBG_QNAME="s3-events-debug-$(date +%s)"
DBG_QURL=$(aws sqs create-queue --queue-name "$DBG_QNAME" --region "$REGION" --query QueueUrl --output text)
DBG_QARN=$(aws sqs get-queue-attributes --queue-url "$DBG_QURL" --region "$REGION" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Allow S3 to send to this queue
cat > /tmp/sqs-debug-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowS3SendMessageFromSourceBucket",
    "Effect": "Allow",
    "Principal": { "Service": "s3.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "${DBG_QARN}",
    "Condition": {
      "ArnEquals":    { "aws:SourceArn": "arn:aws:s3:::${SRC_BUCKET}" },
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" }
    }
  }]
}
JSON

aws sqs set-queue-attributes \
  --queue-url "$DBG_QURL" \
  --region "$REGION" \
  --attributes "{\"Policy\":$(jq -Rs . /tmp/sqs-debug-policy.json)}"


# Add this queue as a SECOND notification target (do not remove the existing one)
CURR=$(aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json)
echo "$CURR" | jq --arg arn "$DBG_QARN" '
  .QueueConfigurations += [{
    Id: "debug-" + (now|tostring),
    QueueArn: $arn,
    Events: ["s3:ObjectCreated:*"]
  }]
' > /tmp/s3-notif-with-debug.json

aws s3api put-bucket-notification-configuration \
  --bucket "$SRC_BUCKET" \
  --notification-configuration file:///tmp/s3-notif-with-debug.json

# Trigger again
echo "ping $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | aws s3 cp - "s3://${SRC_BUCKET}/uploads/test-ping-2.txt" --region "$REGION" >/dev/null
sleep 4

# Check the DEBUG queue
aws sqs get-queue-attributes --queue-url "$DBG_QURL" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws sqs receive-message --queue-url "$DBG_QURL" --region "$REGION" \
  --max-number-of-messages 1 --visibility-timeout 0 --wait-time-seconds 0 \
  --query 'Messages[0].Body' --output text | jq .
