echo "Confirm bucket notifies Que..."
SRC_BUCKET=image-processor-source-150544707159-image-processing-stack
aws s3api get-bucket-notification-configuration --bucket "$SRC_BUCKET" --output json | jq .

echo "***********************************"
echo "Confirm Lambda is subscribed to this queue"
REGION=us-west-2
PROCESS_FN=ImageProcessorFunction  # change if different
aws lambda list-event-source-mappings \
  --function-name "$PROCESS_FN" --region "$REGION" \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,Enabled:Enabled,EventSourceArn:EventSourceArn,StateTransitionReason:StateTransitionReason}'

echo "***********************************"
echo "See if messages are arriving (and/or stuck)"
QURL=$(aws sqs get-queue-url --queue-name image-processing-stack-ImageProcessingQueue-oWJmp7YwqC0e --region "$REGION" --query QueueUrl --output text)
aws sqs get-queue-attributes \
  --queue-url "$QURL" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

echo "***********************************"
echo "Peek at one message (without consuming it)"
MSG=$(aws sqs receive-message --queue-url "$QURL" --region "$REGION" \
  --max-number-of-messages 1 --visibility-timeout 0 --wait-time-seconds 0 \
  --query 'Messages[0]' --output json)
echo "$MSG" | jq -r '.Body' | jq -r '.Records[0].s3.object.key'

