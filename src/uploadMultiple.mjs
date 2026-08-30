// src/uploadMultiple.mjs
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

import { buildPlan, metadataForPut, MIME } from "./lib/plan.js";
import { generateId } from "./id.js";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const SOURCE_BUCKET =
  process.env.SOURCE_BUCKET_NAME ||
  process.env.SOURCE_BUCKET ||
  process.env.UPLOAD_BUCKET ||
  "";

const DEFAULT_TARGET_BUCKET =
  process.env.DEFAULT_TARGET_BUCKET ||
  "images.juniorbay.net";

const DEFAULT_BASE_PREFIX =
  process.env.DEFAULT_BASE_PREFIX ||
  process.env.UPLOAD_PREFIX ||
  "photos";

const CDN_BASE_DEFAULT = (process.env.CDN_BASE || "").replace(/\/$/, "") ||
  `https://${DEFAULT_TARGET_BUCKET}`;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const ENABLE_PUT_FALLBACK = true;
const PRESIGN_TTL_SECS = Number(process.env.PRESIGN_TTL_SECS || 900);

const PHOTOS_TABLE =
  process.env.PHOTOS_TABLE ||
  process.env.IMAGE_METADATA_TABLE_NAME ||
  "";

const MULTI_FORMATS = (process.env.MULTI_FORMATS || "avif,webp,jpg")
  .split(",")
  .map(f => f.trim().toLowerCase())
  .filter(Boolean);

const VARIANTS = ["thumb", "small", "medium", "large", "full"];

const json = (code, obj, origin) => ({
  statusCode: code,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "OPTIONS,POST",
    "access-control-allow-headers": "content-type,x-amz-date,authorization,x-amz-security-token,x-amz-content-sha256",
    "access-control-max-age": "86400",
  },
  body: JSON.stringify(obj ?? {}),
});

function allowedOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  return ALLOWED_ORIGINS.includes(origin) ? origin : "null";
}

function sanitizeFileName(name = "upload.bin") {
  return String(name).replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase() || "upload.bin";
}

function mimeForExt(ext, fallback) {
  return MIME[String(ext || "").toLowerCase()] || fallback || "application/octet-stream";
}

function normalizeBaseKey(baseKey) {
  const cleaned = String(baseKey || "").replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned ? cleaned + "/" : "";
}

function buildExpectedUrls(cdnBase, baseKey, primaryExt, originalExt) {
  const urls = {
    original: `${cdnBase}/${baseKey}original.${originalExt || primaryExt}`
  };
  VARIANTS.forEach(variant => {
    urls[variant] = {};
    MULTI_FORMATS.forEach(format => {
      urls[variant][format] = `${cdnBase}/${baseKey}${variant}.${format}`;
    });
  });
  return urls;
}

export const handler = async (event) => {
  const origin = allowedOrigin(event);

  if ((event?.httpMethod || event?.requestContext?.http?.method) === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "OPTIONS,POST",
        "access-control-allow-headers": "content-type,x-amz-date,authorization,x-amz-security-token,x-amz-content-sha256",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  try {
    if (!SOURCE_BUCKET) return json(500, { error: "SOURCE_BUCKET not configured" }, origin);

    const body = event?.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body || "", "base64").toString("utf8") || "{}")
      : JSON.parse(event?.body || "{}");

    const batchBasePrefix = body?.basePrefix;
    const batchBaseKey = body?.baseKey;
    const batchTargetBucket = body?.targetBucket || DEFAULT_TARGET_BUCKET;
    const batchForceFormat = body?.forceFormat || "";
    const batchExcludeId = body?.excludeId === true;

    let items = [];
    if (Array.isArray(body?.items) && body.items.length) {
      items = body.items.map((it) => ({
        fileName: sanitizeFileName(it?.fileName || "upload.bin"),
        contentType: String(it?.contentType || "application/octet-stream"),
        basePrefix: it?.basePrefix || batchBasePrefix,
        baseKey: it?.baseKey || batchBaseKey,
        targetBucket: it?.targetBucket || batchTargetBucket,
        forceFormat: it?.forceFormat || batchForceFormat,
        excludeId: it?.excludeId !== undefined ? it.excludeId : batchExcludeId,
      }));
    } else {
      items = [{
        fileName: sanitizeFileName(body?.fileName || "upload.bin"),
        contentType: String(body?.contentType || "application/octet-stream"),
        basePrefix: batchBasePrefix,
        baseKey: batchBaseKey,
        targetBucket: batchTargetBucket,
        forceFormat: batchForceFormat,
        excludeId: batchExcludeId,
      }];
    }

    const results = [];
    for (const it of items) {
      const {
        fileName,
        contentType,
        basePrefix,
        baseKey: customBaseKey,
        targetBucket,
        forceFormat,
        excludeId,
      } = it;

      const id = generateId();
      let finalBaseKey, sourceKey, plan;

      if (customBaseKey && excludeId) {
        finalBaseKey = normalizeBaseKey(customBaseKey);
        const extMatch = fileName.match(/\.([^.]+)$/);
        const originalExt = extMatch ? extMatch[1].toLowerCase() : "jpg";
        const primaryExt = forceFormat || "jpg";
        sourceKey = `${finalBaseKey}original.${originalExt}`;
        plan = { id, baseKey: finalBaseKey, sourceKey, originalExt, primaryExt };
      } else {
        plan = buildPlan({
          id,
          mediaType: "photo",
          basePrefix: basePrefix || DEFAULT_BASE_PREFIX,
          filename: fileName,
          mime: contentType,
          forceFormat,
        });
        finalBaseKey = plan.baseKey;
        sourceKey = plan.sourceKey;
      }

      const md = metadataForPut(plan, {
        targetBucket,
        useCase: "multiple",
      });
      md.excludeid = excludeId ? "true" : "false";
      md.custombasepath = (customBaseKey && excludeId) ? finalBaseKey : "";

      const cdnBase = targetBucket === DEFAULT_TARGET_BUCKET 
        ? CDN_BASE_DEFAULT 
        : `https://${targetBucket}`;

      const expectedUrls = buildExpectedUrls(
        cdnBase,
        finalBaseKey,
        plan.primaryExt,
        plan.originalExt
      );

      const post = await createPresignedPost(s3, {
        Bucket: SOURCE_BUCKET,
        Key: sourceKey,
        Fields: {
          key: sourceKey,
          bucket: SOURCE_BUCKET,
          "Content-Type": mimeForExt(plan.originalExt, contentType),
          "x-amz-meta-id": id,
          "x-amz-meta-basekey": finalBaseKey,
          "x-amz-meta-baseprefix": md.baseprefix || "",
          "x-amz-meta-primaryext": plan.primaryExt,
          "x-amz-meta-targetbucket": targetBucket,
          "x-amz-meta-excludeid": md.excludeid,
          "x-amz-meta-custombasepath": md.custombasepath,
        },
        Conditions: [
          ["content-length-range", 0, MAX_UPLOAD_BYTES],
          ["eq", "$key", sourceKey],
          ["eq", "$bucket", SOURCE_BUCKET],
          ["eq", "$Content-Type", mimeForExt(plan.originalExt, contentType)],
        ],
        Expires: PRESIGN_TTL_SECS,
      });

      let putUrl = null;
      if (ENABLE_PUT_FALLBACK) {
        putUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: SOURCE_BUCKET,
            Key: sourceKey,
            ContentType: mimeForExt(plan.originalExt, contentType),
            Metadata: md,
          }),
          { expiresIn: PRESIGN_TTL_SECS }
        );
      }

      // 🔸 NEW: write a "pending" row using PK=id, SK=epochSeconds
      if (PHOTOS_TABLE) {
        const nowEpoch = Math.floor(Date.now() / 1000);
        const nowIso = new Date(nowEpoch * 1000).toISOString();

        const item = {
          PK: { S: id },
          SK: { S: String(nowEpoch).padStart(10, '0') },
          id: { S: id },
          status: { S: "pending" },
          bucket: { S: targetBucket },
          baseKey: { S: finalBaseKey },
          contentType: { S: mimeForExt(plan.originalExt, contentType) },
          urls: { S: JSON.stringify(expectedUrls) },
          sourceBucket: { S: SOURCE_BUCKET },
          sourceKey: { S: sourceKey },
          updatedAt: { S: nowIso },
        };
        try {
          await ddb.send(new PutItemCommand({ TableName: PHOTOS_TABLE, Item: item }));
        } catch (e) {
          console.error("DDB put (pending) failed:", e);
        }
      }

      results.push({
        id,
        fileName,
        status: "pending",
        baseKey: finalBaseKey,
        targetBucket,
        cdnBase,
        excludeId,
        urls: expectedUrls,
        upload: {
          url: post.url,
          fields: post.fields,
          putUrl,
        },
        source: { bucket: SOURCE_BUCKET, key: sourceKey },
      });
    }

    return json(200, items.length === 1 ? results[0] : { items: results }, origin);

  } catch (err) {
    console.error("uploadMultiple error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, allowedOrigin(event));
  }
};
