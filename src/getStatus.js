// src/getStatus.js
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");

const json = (code, obj, origin = "*") => ({
  statusCode: code,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "OPTIONS,GET",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  },
  body: JSON.stringify(obj),
});

function allowedOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!origin || allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : "*";
}

function unmarshall(item) {
  if (!item) return null;
  const obj = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) obj[key] = value.S;
    else if (value.N !== undefined) obj[key] = Number(value.N);
    else if (value.BOOL !== undefined) obj[key] = value.BOOL;
    else if (value.NULL !== undefined) obj[key] = null;
    else obj[key] = value;
  }
  return obj;
}

export const handler = async (event) => {
  const origin = allowedOrigin(event);

  if ((event?.httpMethod || event?.requestContext?.http?.method) === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "OPTIONS,GET",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  try {
    if (!METADATA_TABLE) return json(500, { error: "METADATA_TABLE not configured" }, origin);

    const id = event?.pathParameters?.id || "";
    if (!id) return json(400, { error: "Missing id parameter" }, origin);

    // 🔸 Query for the most-recent version (SK descending)
    const q = await ddb.send(new QueryCommand({
      TableName: METADATA_TABLE,
      KeyConditionExpression: "PK = :id",
      ExpressionAttributeValues: { ":id": { S: id } },
      ScanIndexForward: false,
      Limit: 1,
    }));

    let item = null;
    if (q.Items && q.Items.length > 0) item = unmarshall(q.Items[0]);

    if (item) {
      let variants = [];
      let urls = {};
      try {
        if (item.variants) variants = JSON.parse(item.variants);
        if (item.urls) urls = JSON.parse(item.urls);
      } catch (err) {
        console.error("Failed to parse JSON fields:", err);
      }

      const response = {
        id: item.id || id,
        status: item.status || "complete",
        bucket: item.bucket,
        baseKey: item.baseKey,
        contentType: item.contentType,
        urls,
        variants: (variants || []).map(v => ({
          name: v.name, format: v.format, url: v.url,
          width: v.width, height: v.height, bytes: v.bytes, upscaled: v.upscaled || false,
        })),
        source: (item.sourceWidth && item.sourceHeight) ? {
          width: item.sourceWidth, height: item.sourceHeight, format: item.sourceFormat,
        } : undefined,
        updatedAt: item.updatedAt,
        error: item.error,
      };

      return json(200, response, origin);
    }

    // Fallbacks (unchanged, for robustness)
    const bucket = TARGET_BUCKET_DEFAULT;
    const possiblePaths = [
      `photos/${id}/small.jpg`,
      `photos/${id}/thumb.jpg`,
      `uploads/web/${id}/small.jpg`,
      `uploads/web/${id}/thumb.jpg`,
    ];

    for (const key of possiblePaths) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const baseKey = key.substring(0, key.lastIndexOf('/') + 1);
        const urls = buildUrlsFromBaseKey(baseKey);
        return json(200, {
          id, status: "complete", bucket, baseKey, urls,
          message: "Processing complete (metadata sync pending)"
        }, origin);
      } catch {}
    }

    const sourcePaths = [
      `photos/${id}/original.jpg`,
      `photos/${id}/original.png`,
      `photos/${id}/original.tiff`,
      `uploads/web/${id}/original.jpg`,
    ];
    for (const key of sourcePaths) {
      try {
        await s3.send(new HeadObjectCommand({ 
          Bucket: process.env.SOURCE_BUCKET || bucket, 
          Key: key 
        }));
        return json(200, { id, status: "processing", message: "Image is being processed" }, origin);
      } catch {}
    }

    return json(404, { error: "Image not found", id, message: "No record found in database or storage" }, origin);

  } catch (err) {
    console.error("getStatus error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};

function buildUrlsFromBaseKey(baseKey) {
  const variants = ['thumb', 'small', 'medium', 'large', 'full'];
  const formats = ['avif', 'webp', 'jpg'];
  const urls = {};
  variants.forEach(variant => {
    urls[variant] = {};
    formats.forEach(format => {
      urls[variant][format] = `${CDN_BASE}/${baseKey}${variant}.${format}`;
    });
  });
  urls.original = `${CDN_BASE}/${baseKey}original.jpg`;
  return urls;
}
