ACCOUNT_ID=150544707159
REGION=us-west-2
SRC_BUCKET=image-processor-source-150544707159-image-processing-stack
QUEUE_NAME=image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e

QURL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query QueueUrl --output text)

# See current policy (if any)
aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names Policy --region "$REGION"

# If it's empty or missing the S3 allow, apply this:
cat > sqs-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowS3SendMessage",
    "Effect": "Allow",
    "Principal": { "Service": "s3.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:$REGION:$ACCOUNT_ID:$QUEUE_NAME",
    "Condition": {
      "ArnEquals":   { "aws:SourceArn": "arn:aws:s3:::$SRC_BUCKET" },
      "StringEquals":{ "aws:SourceAccount": "$ACCOUNT_ID" }
    }
  }]
}
JSON

# SQS needs the policy as a STRING value in the attributes map:
POLICY=$(jq -c . sqs-policy.json)
aws sqs set-queue-attributes --queue-url "$QURL" --region "$REGION" --attributes Policy="$POLICY"
