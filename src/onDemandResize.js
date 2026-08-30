// src/onDemandResize.js
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || "";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");
const CACHE_CONTROL = process.env.CACHE_CONTROL || "public, max-age=31536000, immutable";

const MIME = { jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", avif:"image/avif", png:"image/png" };

const json = (code, obj, origin = "*") => ({
  statusCode: code,
  headers: { "content-type": "application/json", "access-control-allow-origin": origin },
  body: JSON.stringify(obj),
});

function allowedOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!origin || allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : "null";
}

function unmarshall(item) {
  if (!item) return null;
  const obj = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) obj[key] = value.S;
    else if (value.N !== undefined) obj[key] = Number(value.N);
    else obj[key] = value;
  }
  return obj;
}

const streamToBuffer = async (r) => { const chunks=[]; for await (const c of r) chunks.push(c); return Buffer.concat(chunks); };

function getFormatOptions(fmt) {
  switch (fmt) {
    case "jpg":
    case "jpeg": return { quality: 85, progressive: true, mozjpeg: true };
    case "webp": return { quality: 85, effort: 4 };
    case "avif": return { quality: 80, effort: 4 };
    case "png":  return { compressionLevel: 9, adaptiveFiltering: true };
    default: return {};
  }
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
      },
      body: "",
    };
  }

  try {
    if (!METADATA_TABLE || !SOURCE_BUCKET) {
      return json(500, { error: "Missing configuration", message: "METADATA_TABLE or SOURCE_BUCKET not set" }, origin);
    }

    const id = event?.pathParameters?.id || "";
    const dimensions = event?.pathParameters?.dimensions || "";
    if (!id || !dimensions) return json(400, { error: "Missing parameters", message: "Format: /resize/{id}/{width}x{height}" }, origin);

    const match = dimensions.match(/^(\d+)x(\d+)$/);
    if (!match) return json(400, { error: "Invalid dimensions", message: "Use {width}x{height}" }, origin);

    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (width < 1 || width > 10000 || height < 1 || height > 10000)
      return json(400, { error: "Invalid dimensions", message: "Width/height must be between 1 and 10000" }, origin);

    const qs = event?.queryStringParameters || {};
    const requestedFormat = (qs.format || "").toLowerCase();
    const fit = qs.fit || "inside";

    let formats;
    if (requestedFormat) {
      if (!["jpeg","jpg","webp","avif","png"].includes(requestedFormat))
        return json(400, { error: "Invalid format", message: "Supported: jpeg, jpg, webp, avif, png" }, origin);
      formats = [requestedFormat === "jpeg" ? "jpg" : requestedFormat];
    } else {
      formats = ["avif", "webp", "jpg"];
    }

    // 🔸 latest version
    const q = await ddb.send(new QueryCommand({
      TableName: METADATA_TABLE,
      KeyConditionExpression: "PK = :id",
      ExpressionAttributeValues: { ":id": { S: id } },
      ScanIndexForward: false,
      Limit: 1,
    }));
    if (!q.Items || !q.Items.length) return json(404, { error: "Image not found", id, message: "No record exists for this ID" }, origin);

    const item = unmarshall(q.Items[0]);
    const baseKey = item.baseKey || "";
    const targetBucket = item.bucket || TARGET_BUCKET_DEFAULT;

    const possibleSourceKeys = [
      `${baseKey}original.jpg`,
      `${baseKey}original.png`,
      `${baseKey}original.webp`,
      `${baseKey}original.tiff`,
    ];

    let foundSourceKey = null;
    for (const key of possibleSourceKeys) {
      try { await s3.send(new HeadObjectCommand({ Bucket: SOURCE_BUCKET, Key: key })); foundSourceKey = key; break; }
      catch {}
    }
    if (!foundSourceKey) return json(404, { error: "Original not found", message: "Original file not found in source bucket" }, origin);

    const getRes = await s3.send(new GetObjectCommand({ Bucket: SOURCE_BUCKET, Key: foundSourceKey }));
    const srcBuf = await streamToBuffer(getRes.Body);

    const results = [];
    const urls = {};

    for (const format of formats) {
      const sharpFmt = format === "jpg" ? "jpeg" : format;
      const { data, info } = await sharp(srcBuf, { failOn: "none" })
        .rotate()
        .resize({ width, height, fit, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
        .toFormat(sharpFmt, getFormatOptions(format))
        .toBuffer({ resolveWithObject: true });

      const destKey = `${baseKey}custom_${width}x${height}.${format}`;
      await s3.send(new PutObjectCommand({
        Bucket: targetBucket, Key: destKey, Body: data,
        ContentType: MIME[format] || "image/jpeg",
        CacheControl: CACHE_CONTROL,
        Metadata: { id, basekey: baseKey, custom: "true", dimensions: `${width}x${height}`, fit,
          width: String(info.width), height: String(info.height),
        },
      }));

      const url = CDN_BASE ? `${CDN_BASE}/${destKey}` : `https://${targetBucket}.s3.amazonaws.com/${destKey}`;
      results.push({ format, width: info.width, height: info.height, bytes: data.length, url });
      urls[format] = url;
    }

    return json(200, { id, dimensions: `${width}x${height}`, fit, formats: results.map(r=>r.format), urls, variants: results }, origin);

  } catch (err) {
    console.error("onDemandResize error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};
