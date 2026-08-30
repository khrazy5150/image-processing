# JuniorBay Image Pipeline v2

This deploys:
- **DynamoDB (single item per photo)** with GSIs
- **S3 source bucket** + **SQS** + **Lambda (Sharp)** generating static derivatives
- **Minimal upload-init API** for pre-signed uploads (no custom domain yet)

## Deploy

```bash
sam build && sam deploy \
  --stack-name image-processing-stack-v2 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    SourceBucketName=image-processor-source \
    TargetBucketName=images.juniorbay.net \
    ImageMetadataTableName=image_processing_metadata_v2 \
    CdnBase=https://images.juniorbay.net
```

After deploy, note the output `UploadApiUrl` (e.g. `https://abc123.execute-api.us-west-2.amazonaws.com/v3`).

## Upload a small image (single PUT) with curl

1) **Request a signed URL**

```bash
API_URL="https://abc123.execute-api.us-west-2.amazonaws.com/v3" # replace with UploadApiUrl
curl -s -X POST "$API_URL/upload" \
  -H 'content-type: application/json' \
  -d '{
    "mediaType":"photo",
    "fileName":"cat.jpg",
    "mime":"image/jpeg",
    "sizeBytes": 800000,
    "useCase":"general",
    "ownerUserId":"USER#demo",
    "targetBucket":"images.juniorbay.net",
    "basePrefix":"photos",
    "forceFormat":""
  }' | tee /tmp/init.json
```

2) **Upload the file**

```bash
PUT_URL=$(jq -r '.upload.putUrl' /tmp/init.json)
CONTENT_TYPE=$(jq -r '.upload.contentType' /tmp/init.json)

curl -X PUT "$PUT_URL" \
  -H "content-type: $CONTENT_TYPE" \
  --data-binary @./cat.jpg
```

3) **Wait a few seconds** for S3→SQS→Lambda. Your image derivatives will appear under:
```
s3://images.juniorbay.net/photos/YYYY/MM/<id>/{original,full,large,medium,small,thumb}.jpg
```

The DynamoDB item is keyed by `PK=PHOTO#<id>, SK=PHOTO`.

## Notes
- By default the processor saves URLs using `CdnBase` (e.g., `https://images.juniorbay.net`).
- You can override per-upload behavior by setting S3 object metadata via the upload-init API (already handled).
- PNG/PDF (and TIFF) originals are preserved; others are normalized to JPG by default.
