API_ID=dph4d1c6p8
STAGE=v3
REGION=us-west-2
PROFILE=default
LOG_GROUP="/aws/apigw/${API_ID}-${STAGE}"

# 1) Create (idempotent) and fetch the log group ARN
aws --profile "$PROFILE" --region "$REGION" logs create-log-group \
  --log-group-name "$LOG_GROUP" || true

LOG_ARN=$(aws --profile "$PROFILE" --region "$REGION" logs describe-log-groups \
  --log-group-name-prefix "$LOG_GROUP" \
  --query 'logGroups[0].arn' --output text)

# 2) Build the access-log-settings JSON safely with jq (no shell escaping headaches)
FMT='{"requestId":"$context.requestId","routeKey":"$context.routeKey","path":"$context.path","status":"$context.status","integrationStatus":"$context.integrationStatus","integrationErrorMessage":"$context.integrationErrorMessage","errorMessage":"$context.error.message"}'

jq -n --arg dest "$LOG_ARN" --arg fmt "$FMT" \
  '{DestinationArn:$dest, Format:$fmt}' > /tmp/access-log-settings.json

# 3) Apply to the stage
aws --profile "$PROFILE" --region "$REGION" apigatewayv2 update-stage \
  --api-id "$API_ID" --stage-name "$STAGE" \
  --access-log-settings file:///tmp/access-log-settings.json

# 4) Tail API Gateway access logs
aws --profile "$PROFILE" --region "$REGION" logs tail "$LOG_GROUP" --since 10m --format detailed --follow
