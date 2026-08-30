// src/uploadFromUrl.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { generateId } from "./id.js";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});

const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const DEFAULT_TARGET_BUCKET = process.env.DEFAULT_TARGET_BUCKET || "images.juniorbay.net";
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || "photos";
const QUEUE_URL = process.env.QUEUE_URL || "";
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "") || `https://${DEFAULT_TARGET_BUCKET}`;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024);
const PHOTOS_TABLE = process.env.PHOTOS_TABLE || "";

const MULTI_FORMATS = (process.env.MULTI_FORMATS || "avif,webp,jpg")
  .split(",").map(f => f.trim().toLowerCase()).filter(Boolean);

const VARIANTS = ["thumb", "small", "medium", "large", "full"];

const json = (code, obj, origin = "*") => ({
  statusCode: code,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "OPTIONS,POST",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
  },
  body: JSON.stringify(obj),
});

function allowedOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!origin || allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : "null";
}

function normalizeBaseKey(baseKey) {
  const cleaned = String(baseKey || "").replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned ? cleaned + "/" : "";
}

function buildExpectedUrls(cdnBase, baseKey) {
  const urls = { original: `${cdnBase}/${baseKey}original.jpg` };
  VARIANTS.forEach(variant => {
    urls[variant] = {};
    MULTI_FORMATS.forEach(format => {
      urls[variant][format] = `${cdnBase}/${baseKey}${variant}.${format}`;
    });
  });
  return urls;
}

function guessExtensionFromUrl(url, contentType) {
  const urlMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  if (urlMatch) {
    const ext = urlMatch[1].toLowerCase();
    if (['jpg','jpeg','png','webp','avif','tiff','gif','bmp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  if (contentType) {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('avif')) return 'avif';
    if (contentType.includes('tiff')) return 'tiff';
  }
  return 'jpg';
}

export const handler = async (event) => {
  const origin = allowedOrigin(event);

  if ((event?.httpMethod || event?.requestContext?.http?.method) === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "OPTIONS,POST",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  try {
    if (!SOURCE_BUCKET || !QUEUE_URL) {
      return json(500, { error: "Missing configuration", message: "SOURCE_BUCKET or QUEUE_URL not set" }, origin);
    }

    const body = event?.body ? JSON.parse(event.body) : {};
    const imageUrl = body.url || body.imageUrl;
    if (!imageUrl) return json(400, { error: "Missing url", message: "Request body must include 'url' field" }, origin);

    let parsedUrl;
    try {
      parsedUrl = new URL(imageUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return json(400, { error: "Invalid URL", message: "Only HTTP and HTTPS URLs are supported" }, origin);
      }
    } catch {
      return json(400, { error: "Invalid URL", message: "Provided URL is not valid" }, origin);
    }

    const basePrefix = body.basePrefix || DEFAULT_BASE_PREFIX;
    const customBaseKey = body.baseKey;
    const excludeId = body.excludeId === true;
    const targetBucket = body.targetBucket || DEFAULT_TARGET_BUCKET;
    const fileName = body.fileName || parsedUrl.pathname.split('/').pop() || 'image';

    const id = generateId();

    const fetchResponse = await fetch(imageUrl, { headers: { 'User-Agent': 'ImageProcessingBot/1.0' } });
    if (!fetchResponse.ok) {
      return json(400, { error: "Failed to fetch image", message: `HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`, url: imageUrl }, origin);
    }

    const contentType = fetchResponse.headers.get('content-type') || 'application/octet-stream';
    const contentLength = parseInt(fetchResponse.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_FILE_SIZE) {
      return json(400, { error: "File too large", message: `File size ${contentLength} bytes exceeds maximum ${MAX_FILE_SIZE} bytes` }, origin);
    }

    const arrayBuffer = await fetchResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    if (imageBuffer.length > MAX_FILE_SIZE) {
      return json(400, { error: "File too large", message: `File size ${imageBuffer.length} bytes exceeds maximum ${MAX_FILE_SIZE} bytes` }, origin);
    }

    const originalExt = guessExtensionFromUrl(imageUrl, contentType);

    let finalBaseKey;
    if (customBaseKey && excludeId) finalBaseKey = normalizeBaseKey(customBaseKey);
    else if (customBaseKey) finalBaseKey = normalizeBaseKey(customBaseKey) + id + '/';
    else finalBaseKey = `${basePrefix.replace(/\/$/, '')}/${id}/`;

    const sourceKey = `${finalBaseKey}original.${originalExt}`;

    await s3.send(new PutObjectCommand({
      Bucket: SOURCE_BUCKET, Key: sourceKey, Body: imageBuffer, ContentType: contentType,
      Metadata: {
        id, basekey: finalBaseKey, baseprefix: basePrefix, primaryext: 'jpg',
        targetbucket: targetBucket, excludeid: excludeId ? "true" : "false",
        custombasepath: (customBaseKey && excludeId) ? finalBaseKey : "",
        sourceurl: imageUrl, filename: fileName,
      },
    }));

    const message = { Records: [{ s3: { bucket: { name: SOURCE_BUCKET }, object: { key: sourceKey } } }] };
    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) }));

    const cdnBase = targetBucket === DEFAULT_TARGET_BUCKET ? CDN_BASE : `https://${targetBucket}`;
    const expectedUrls = buildExpectedUrls(cdnBase, finalBaseKey);

    // 🔸 NEW: write “pending” row with PK=id, SK=epochSeconds
    if (PHOTOS_TABLE) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const nowIso = new Date(nowEpoch * 1000).toISOString();
      try {
        await ddb.send(new PutItemCommand({
          TableName: PHOTOS_TABLE,
          Item: {
            PK: { S: id },
            SK: { S: String(nowEpoch).padStart(10, '0') },
            id: { S: id },
            status: { S: "pending" },
            bucket: { S: targetBucket },
            baseKey: { S: finalBaseKey },
            contentType: { S: contentType },
            urls: { S: JSON.stringify(expectedUrls) },
            sourceBucket: { S: SOURCE_BUCKET },
            sourceKey: { S: sourceKey },
            updatedAt: { S: nowIso },
          },
        }));
      } catch (e) {
        console.error("DDB put (pending) failed:", e);
      }
    }

    return json(200, {
      success: true, id, fileName, sourceUrl: imageUrl,
      status: "processing",
      baseKey: finalBaseKey, targetBucket, cdnBase, excludeId,
      urls: expectedUrls,
      source: { bucket: SOURCE_BUCKET, key: sourceKey },
      size: imageBuffer.length,
    }, origin);

  } catch (err) {
    console.error("uploadFromUrl error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};
