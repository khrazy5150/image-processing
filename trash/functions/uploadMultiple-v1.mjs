// src/uploadMultiple.mjs — Node.js 20.x (ESM)
// POST /upload/multiple (HttpApi v3)
// - Server generates short Base62 id (./id.js)
// - Canonical paths via ./lib/plan.js (single source of truth)
// - Stamps x-amz-meta-* on ORIGINAL object
// - Returns presigned POST (preferred) + PUT fallback

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

import { buildPlan, metadataForPut, MIME } from "./lib/plan.js"; // shared logic
import { generateId } from "./id.js"; // short base62 ids

const s3 = new S3Client({});

// ---- Env ----
const SOURCE_BUCKET =
  process.env.SOURCE_BUCKET ||
  process.env.SOURCE_BUCKET_NAME ||
  process.env.UPLOAD_BUCKET ||
  "";

const DEFAULT_TARGET_BUCKET = process.env.DEFAULT_TARGET_BUCKET || "images.juniorbay.net";
const DEFAULT_BASE_PREFIX   = process.env.DEFAULT_BASE_PREFIX   || "uploads/web";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://127.0.0.1:5500,http://localhost:5500,https://images.juniorbay.net")
  .split(",").map(s => s.trim()).filter(Boolean);

const MAX_UPLOAD_BYTES   = Number(process.env.MAX_UPLOAD_BYTES   || 100 * 1024 * 1024);
const PRESIGN_TTL_SECS   = Number(process.env.PRESIGN_TTL_SECS   || 900);
const ENABLE_PUT_FALLBACK = true;

// ---- small helpers ----
const cors = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "OPTIONS,POST",
  "access-control-allow-headers": "content-type,x-amz-date,authorization,x-amz-security-token,x-amz-content-sha256",
  "access-control-max-age": "86400",
});
const json = (code, obj, origin) => ({
  statusCode: code,
  headers: { "content-type": "application/json", ...cors(origin) },
  body: JSON.stringify(obj ?? {}),
});
const allowedOrigin = (evt) => {
  const o = evt?.headers?.origin || evt?.headers?.Origin || "";
  if (!o) return "*";
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  return ALLOWED_ORIGINS.includes(o) ? o : "null";
};
const filenameFromKey = (k="") => (String(k).split("/").pop() || "upload.bin");
const sanitize = (n="upload.bin") => (String(n).replace(/\s+/g,"-").replace(/[^a-zA-Z0-9._-]/g,"").toLowerCase() || "upload.bin");
const mimeForExt = (ext, fb) => MIME[String(ext||"").toLowerCase()] || fb || "application/octet-stream";

// ---- core ----
async function presignOne({ fileName, contentType, basePrefix, targetBucket, forceFormat }) {
  const id = generateId(); // short Base62 (time-ordered) :contentReference[oaicite:3]{index=3}
  const plan = buildPlan({
    id,
    mediaType: /^video\//i.test(contentType) ? "video" : "photo",
    basePrefix,
    filename: fileName,
    mime: contentType,
    forceFormat, // optional 'png'|'jpg'|'webp'|'avif' etc.
  }); // canonical baseKey/sourceKey, primary/originalExt, etc. :contentReference[oaicite:4]{index=4}

  // metadata the processor trusts (read via HeadObject)
  const md = metadataForPut(plan, {
    targetBucket,
    useCase: "multiple",
  }); // lower-cased keys; includes id/basekey/baseprefix/primaryext :contentReference[oaicite:5]{index=5}

  // Presigned POST (preferred)
  const post = await createPresignedPost(s3, {
    Bucket: SOURCE_BUCKET,
    Key: plan.sourceKey, // e.g. uploads/web/<id>/original.jpg
    Fields: {
      bucket: SOURCE_BUCKET,
      key: plan.sourceKey,
      "Content-Type": mimeForExt(plan.originalExt, contentType),
      "x-amz-meta-id": md.id,
      "x-amz-meta-basekey": md.basekey,
      "x-amz-meta-baseprefix": md.baseprefix,
      "x-amz-meta-primaryext": md.primaryext,
      "x-amz-meta-targetbucket": targetBucket,
    },
    Conditions: [
      ["content-length-range", 0, MAX_UPLOAD_BYTES],
      ["eq", "$key", plan.sourceKey],
      ["eq", "$bucket", SOURCE_BUCKET],
      ["eq", "$Content-Type", mimeForExt(plan.originalExt, contentType)],
    ],
    Expires: PRESIGN_TTL_SECS,
  });

  // Optional PUT fallback (client must send x-amz-meta-* headers for metadata to persist)
  let putUrl = null;
  if (ENABLE_PUT_FALLBACK) {
    putUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: plan.sourceKey,
        ContentType: mimeForExt(plan.originalExt, contentType),
        Metadata: md,
      }),
      { expiresIn: PRESIGN_TTL_SECS }
    );
  }

  return {
    id,
    fileName,
    url: post.url,
    fields: post.fields,
    putUrl,
    baseKey: plan.baseKey,
    source: { bucket: SOURCE_BUCKET, key: plan.sourceKey },
    targetBucket,
  };
}

export const handler = async (event) => {
  const origin = allowedOrigin(event);
  const method = (event?.httpMethod || event?.requestContext?.http?.method || "GET").toUpperCase();

  if (method === "OPTIONS") return { statusCode: 200, headers: cors(origin), body: "" };
  if (method !== "POST")  return json(405, { error: "method_not_allowed" }, origin);
  if (!SOURCE_BUCKET)     return json(500, { error: "SOURCE_BUCKET not configured" }, origin);

  try {
    const body = event?.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body || "", "base64").toString("utf8") || "{}")
      : JSON.parse(event?.body || "{}");

    // Accept batch {items:[...]} or legacy single {key,contentType}
    let reqItems = [];
    if (Array.isArray(body?.items) && body.items.length) {
      reqItems = body.items.map(it => ({
        fileName: sanitize(it?.fileName || filenameFromKey(it?.key)),
        contentType: String(it?.contentType || "application/octet-stream"),
        basePrefix: body?.basePrefix || DEFAULT_BASE_PREFIX,
        targetBucket: body?.targetBucket || DEFAULT_TARGET_BUCKET,
        forceFormat: body?.forceFormat || "",
      }));
    } else {
      reqItems = [{
        fileName: sanitize(filenameFromKey(body?.key)),
        contentType: String(body?.contentType || "application/octet-stream"),
        basePrefix: body?.basePrefix || DEFAULT_BASE_PREFIX,
        targetBucket: body?.targetBucket || DEFAULT_TARGET_BUCKET,
        forceFormat: body?.forceFormat || "",
      }];
    }

    if (Number(body?.sizeBytes || 0) > MAX_UPLOAD_BYTES) {
      return json(413, { error: "file_too_large", max: MAX_UPLOAD_BYTES }, origin);
    }

    const results = [];
    for (const it of reqItems) results.push(await presignOne(it));
    return json(200, (results.length === 1) ? results[0] : { items: results }, origin);

  } catch (err) {
    console.error("uploadMultiple error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};
