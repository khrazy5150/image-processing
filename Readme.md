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

## Deploying — read this first

`sharp` is a native module: it resolves a platform-specific binary at install time. Building on macOS
packages `@img/sharp-darwin-x64`, which cannot load on Lambda. Every function here shares `CodeUri: src/`,
so a bad build takes down uploads, processing AND resizing at once — as happened on 2026-09-06.

Nothing in the normal loop catches it: `sam build` exits 0, and `npm test` passes because the tests
deliberately avoid loading sharp (a Linux binary will not load on a dev machine, which is exactly why the
crop geometry lives in `src/lib/crop.js` with no sharp import). The only evidence is inside the package.

```bash
sam build --use-container --parallel   # resolve deps in the RUNTIME image, not your laptop
npm run verify:build                   # refuses any package lacking sharp-linux-x64
sam deploy --no-confirm-changeset
```

`npm run verify:build` exits 1 and names the offending functions, so it can gate a deploy. Run it between
build and deploy every time.

If a build has already gone out broken, the symptom is `{"message":"Internal Server Error"}` from API
Gateway (not the handler's own JSON) and `Could not load the "sharp" module` in the function's logs.

## Reprocessing an image is only half the job

Derivatives are served `cache-control: public, max-age=31536000, immutable`. Reprocessing rewrites the S3
object, but CloudFront keeps handing out the old bytes for up to a year — `immutable` tells it never to
revalidate. **Reprocessing without invalidating is invisible.**

```bash
API=https://dph4d1c6p8.execute-api.us-west-2.amazonaws.com/v3
curl -s -X POST "$API/reprocess/{imageId}" -H 'content-type: application/json' -d '{}'

# WAIT for the queue to drain, then confirm S3 differs from the CDN copy before invalidating —
# flushing too early just re-caches the old file and you have to do it twice.
aws s3api head-object --bucket images.juniorbay.net --key offers/{imageId}/medium.webp --query ContentLength
curl -sI https://images.juniorbay.com/offers/{imageId}/medium.webp | grep -i content-length

aws cloudfront create-invalidation --distribution-id E16GIH1C3GYFQE --paths '/offers/*'
```

One wildcard path stays inside the free 1,000-a-month tier; listing files individually does not.

**Verify dimensions, not status codes.** A `200` from `/reprocess` means "queued", not "produced what you
expected". On 2026-09-08 a ladder change appeared to deploy fine and every reprocess returned 200, while the
files came back at the old size — only measuring the actual pixel dimensions revealed it.

## The size ladder lives in code

`SIZES` in `src/imageProcessorApp.js` is the single source of truth. It briefly also existed as a `SizesJson`
CloudFormation parameter; that failed twice in one day. A template `Default` is ignored once a stack holds a
stored value for that parameter, and SAM's `parameter_overrides` cannot carry JSON in either the string or
the array form — it mangled the value to `[{`, after which the ladder worked only because parsing threw and
the code fell back to its constant. Changing the ladder means changing that array and deploying.

It must stay in step with `IMAGE_RENDITION_WIDTHS` in `stripe-link` — those numbers become the `w`
descriptors in every `srcset`. `stripe-link/tests/test_rendition_ladder.py` reads this file and fails on
drift, and also fails if a `SIZES_JSON` override reappears.

## Tests

```bash
npm test
```

Pure geometry only, by design — see above.
