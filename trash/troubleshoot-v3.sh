echo "Verify the full S3 notification config"
SRC_BUCKET=image-processor-source-150544707159-image-processing-stack
aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json | jq .

echo "*********************************"
echo "Check if the SQS queue uses KMS encryption"
REGION=us-west-2
QUEUE_NAME=image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e
QURL=$(aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query QueueUrl --output text)
aws sqs get-queue-attributes \
  --queue-url "$QURL" --region "$REGION" \
  --attribute-names KmsMasterKeyId SqsManagedSseEnabled

echo "*********************************"
echo "Check bucket notification configuration "
aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json | jq .

echo "*********************************"
echo "Make absolutely sure the SQS policy allows S3"
aws sqs get-queue-attributes --queue-url "$QURL" --region "$REGION" --attribute-names Policy | jq -r .Attributes.Policy | jq .

