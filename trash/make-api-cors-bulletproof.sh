#!/usr/bin/env bash
set -Eeuo pipefail

REST_API_ID="di9pnp77pj"
STAGE="prod"
DOMAIN="source.juniorbay.net"
BASE_PATH="upload"
RESOURCE_PATH="/multiple"

echo "Finding resource id…"
RID="$(aws apigateway get-resources --rest-api-id "$REST_API_ID" \
  --query "items[?path==\`$RESOURCE_PATH\`].id" --output text)"
echo "RID=$RID"

# 1) Recreate OPTIONS like the version that previously worked (200)
#    - Force Content-Type to application/json
#    - Provide templates for common content-types (and none)
aws apigateway delete-method --rest-api-id "$REST_API_ID" --resource-id "$RID" --http-method OPTIONS >/dev/null 2>&1 || true

aws apigateway put-method \
  --rest-api-id "$REST_API_ID" --resource-id "$RID" \
  --http-method OPTIONS --authorization-type "NONE" >/dev/null

cat > req-params.json <<'JSON'
{ "integration.request.header.Content-Type": "'application/json'" }
JSON

cat > req-templates.json <<'JSON'
{
  "application/json": "{\"statusCode\":200}",
  "text/plain": "{\"statusCode\":200}",
  "application/x-www-form-urlencoded": "{\"statusCode\":200}"
}
JSON

aws apigateway put-integration \
  --rest-api-id "$REST_API_ID" --resource-id "$RID" \
  --http-method OPTIONS --type MOCK \
  --request-parameters file://req-params.json \
  --request-templates file://req-templates.json >/dev/null

# Method response: expose headers
aws apigateway put-method-response \
  --rest-api-id "$REST_API_ID" --resource-id "$RID" \
  --http-method OPTIONS --status-code 200 \
  --response-models '{"application/json":"Empty"}' \
  --response-parameters \
"method.response.header.Access-Control-Allow-Origin=true,method.response.header.Access-Control-Allow-Methods=true,method.response.header.Access-Control-Allow-Headers=true,method.response.header.Access-Control-Max-Age=true" >/dev/null

# Integration response: set concrete header values (this combo previously worked for you)
cat > resp-params.json <<'JSON'
{
  "method.response.header.Access-Control-Allow-Origin": "'*'",
  "method.response.header.Access-Control-Allow-Methods": "'OPTIONS,POST'",
  "method.response.header.Access-Control-Allow-Headers": "'content-type,x-amz-date,authorization,x-amz-security-token,x-amz-content-sha256'",
  "method.response.header.Access-Control-Max-Age": "'86400'"
}
JSON

aws apigateway put-integration-response \
  --rest-api-id "$REST_API_ID" --resource-id "$RID" \
  --http-method OPTIONS --status-code 200 \
  --response-templates '{"application/json":""}' \
  --response-parameters file://resp-params.json >/dev/null

# 2) (Optional) Skip GatewayResponses for now since your account rejected the mapping expression.
#    They’re just for nicer 4xx/5xx — not required for success.

# 3) Refresh mapping (upload -> prod), then redeploy
aws apigateway update-base-path-mapping \
  --domain-name "$DOMAIN" --base-path "$BASE_PATH" \
  --patch-operations op=replace,path=/stage,value="$STAGE" >/dev/null || true

aws apigateway create-deployment --rest-api-id "$REST_API_ID" --stage-name "$STAGE" >/dev/null

# 4) Test with the same headers your browser sends
echo "---- execute-api ----"
curl -i -X OPTIONS "https://$REST_API_ID.execute-api.us-west-2.amazonaws.com/$STAGE${RESOURCE_PATH}" \
  -H "Origin: http://127.0.0.1:5500" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"

echo
echo "---- custom domain ----"
curl -i -X OPTIONS "https://$DOMAIN/$BASE_PATH${RESOURCE_PATH}" \
  -H "Origin: http://127.0.0.1:5500" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"

echo
echo "---- test-invoke-method (server-side log) ----"
aws apigateway test-invoke-method \
  --rest-api-id "$REST_API_ID" --resource-id "$RID" --http-method OPTIONS \
  --headers 'Origin=http://127.0.0.1:5500,Access-Control-Request-Method=POST,Access-Control-Request-Headers=content-type' \
  --query '{status:status,headers:headers,log:log}'
