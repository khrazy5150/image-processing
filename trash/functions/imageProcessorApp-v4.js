// src/imageProcessorApp.js
// SQS-triggered Lambda: consumes S3:ObjectCreated events (classic S3 notification OR S3→EventBridge),
// copies original, writes resized variants, and (optionally) writes a record to DynamoDB.
//
// - Preserves orientation (sharp.rotate()).
// - Preserves original for PNG/TIFF/PDF (no derivatives for PDF).
// - Supports controlled upscaling (ALLOW_UPSCALE=1) capped by UPSCALE_MAX (e.g., "2").
// - Writes actual output width/height to S3 user metadata for each variant.

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import sharp from "sharp";
import { planFromHead, MIME } from "./lib/plan.js";
import { generateId } from "./id.js";

// ---------- config (env) ----------
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TARGET_BUCKET_DEFAULT =
  process.env.TARGET_BUCKET_DEFAULT || process.env.TARGET_BUCKET || "images.juniorbay.net";

// Support either env var name for the table
const METADATA_TABLE =
  process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";

const PRIMARY_EXT = (process.env.PRIMARY_EXT || "jpg").toLowerCase().replace("jpeg", "jpg");
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || "photos";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const ALLOW_UPSCALE = process.env.ALLOW_UPSCALE === "1";
const UPSCALE_MAX = Number(process.env.UPSCALE_MAX || "2"); // max 2x by default

// Size presets: override by setting SIZES_JSON env to a JSON array.
const DEFAULT_SIZES = [
  { name: "thumb",  width:  200, height:  200, fit: "cover"  },
  { name: "small",  width:  640, height:  640, fit: "inside" },
  { name: "medium", width: 1080, height: 1080, fit: "inside" },
  { name: "large",  width: 1920, height: 1920, fit: "inside" },
  { name: "full",   width: 2560, height: 2560, fit: "inside" },
];

let SIZES;
try {
  SIZES = JSON.parse(process.env.SIZES_JSON || "[]");
  if (!Array.isArray(SIZES) || SIZES.length === 0) SIZES = DEFAULT_SIZES;
} catch {
  SIZES = DEFAULT_SIZES;
}

// ---------- small utils ----------
const log = (...a) => (LOG_LEVEL !== "silent" ? console.log(...a) : null);
const trim = (s) => String(s || "").replace(/^\/+/, "").replace(/\/+$/, "");

const isImageLike = (ct = "", key = "") =>
  /image\/(jpeg|jpg|png|tiff|webp|avif)/i.test(ct) ||
  /\.(jpe?g|png|tiff?|webp|avif)$/i.test(key);

const isPDF  = (ct = "", key = "") => /pdf/i.test(ct)  || /\.pdf$/i.test(key);
const isPNG  = (ct = "", key = "") => /png/i.test(ct)  || /\.png$/i.test(key);
const isTIFF = (ct = "", key = "") => /tiff?/i.test(ct) || /\.tiff?$/i.test(key);

const streamToBuffer = async (readable) => {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// ---------- NEW: unify S3 object extraction from message bodies ----------
function* iterS3Objects(msg) {
  // 1) Classic S3 Notification envelope (Records array)
  if (msg?.Records && Array.isArray(msg.Records)) {
    for (const r of msg.Records) {
      const b = r?.s3?.bucket?.name;
      const k = r?.s3?.object?.key;
      if (b && k) yield { bucket: b, key: decodeURIComponent(String(k).replace(/\+/g, " ")) };
    }
    return;
  }
  // 2) EventBridge S3 event (single object in 'detail')
  if (msg?.source === "aws.s3" && typeof msg["detail-type"] === "string") {
    const dt = msg["detail-type"];
    if (dt.startsWith("Object Created")) {
      const b = msg?.detail?.bucket?.name;
      const k = msg?.detail?.object?.key;
      if (b && k) yield { bucket: b, key: decodeURIComponent(String(k)) };
    }
    return;
  }
  // 3) If the body happens to be an array, recurse
  if (Array.isArray(msg)) {
    for (const m of msg) yield* iterS3Objects(m);
  }
}

// ---------- Lambda handler (SQS trigger) ----------
export const handler = async (event) => {
  if (!event?.Records) return {};
  const failures = [];
  const results  = [];

  for (const rec of event.Records) {
    try {
      const body = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;

      let found = false;
      for (const { bucket, key } of iterS3Objects(body)) {
        found = true;
        results.push(await processOne(bucket, key));
      }
      if (!found) {
        console.log("No S3 objects in message; body keys:", Object.keys(body || {}));
      }
    } catch (err) {
      console.error("Record failed:", err);
      failures.push({ itemIdentifier: rec.messageId });
    }
  }

  // Partial-batch failure contract for SQS → Lambda
  return failures.length ? { batchItemFailures: failures } : { ok: true, results };
};

// ---------- main worker ----------
async function processOne(srcBucket, srcKey) {
  log(`Processing s3://${srcBucket}/${srcKey}`);

  // Head the object to get metadata/content-type
  const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const meta = normalizeMeta(head.Metadata || {});
  const contentType = head.ContentType || "";

  // Build/restore plan (single source of truth) from metadata; fallback for legacy uploads
  const plan = planFromHead({
    head,
    srcKey,
    defaults: { basePrefix: DEFAULT_BASE_PREFIX, primaryExt: PRIMARY_EXT },
  });

  const id = meta.id || plan.id || generateId();
  const baseKey = plan.baseKey || `${trim(plan.basePrefix || DEFAULT_BASE_PREFIX)}/${id}/`;
  const primaryExt = (plan.primaryExt || PRIMARY_EXT).replace("jpeg", "jpg");
  const targetBucket = meta.targetbucket || TARGET_BUCKET_DEFAULT;

  // Determine if we should preserve original extension
  const preserveOriginalExt = isTIFF(contentType, srcKey)
    ? "tiff"
    : isPNG(contentType, srcKey)
    ? "png"
    : isPDF(contentType, srcKey)
    ? "pdf"
    : null;

  // 1) Copy original into target bucket as original.<ext>
  const destOriginalKey = `${baseKey}original.${preserveOriginalExt || primaryExt}`;
  await copyOriginal(srcBucket, srcKey, targetBucket, destOriginalKey, contentType);

  // Stop after copying original if not image-like OR is a PDF (sharp can’t render PDFs natively)
  if (!isImageLike(contentType, srcKey) || preserveOriginalExt === "pdf") {
    log(`Copied original only (no derivatives) → s3://${targetBucket}/${destOriginalKey}`);
    await maybeWriteMetadata(targetBucket, baseKey, id, contentType, { variants: [] });
    return { id, baseKey, targetBucket, variants: [] };
  }

  // 2) Fetch original bytes and produce derivatives with sharp
  const getRes = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const srcBuf = await streamToBuffer(getRes.Body);

  // 2a) Inspect original
  const metaIn = await sharp(srcBuf).metadata();
  const long = Math.max(metaIn.width || 0, metaIn.height || 0);

  // Build a long-edge ladder from presets (ignore "thumb"; we add it last)
  const ladder = SIZES
    .filter((s) => s.name !== "thumb")
    .map((s) => ({
      name: s.name,
      target: Math.max(Number(s.width) || 0, Number(s.height) || 0),
      fit: s.fit || "inside",
    }))
    .sort((a, b) => a.target - b.target);

  // Compute effective targets with cap & dedup
  const effective = [];
  let lastPx = 0;
  for (const t of ladder) {
    const cap = Math.round(long * UPSCALE_MAX);
    const desired = t.target;
    const eff = ALLOW_UPSCALE ? Math.min(desired, cap) : Math.min(desired, long);
    if (!eff || eff === lastPx) continue; // skip zero/duplicates
    effective.push({ name: t.name, px: eff, fit: t.fit });
    lastPx = eff;
  }
  // Always include thumb (square cover)
  effective.push({ name: "thumb", px: 200, fit: "cover" });

  // 2b) Generate variants
  const outputs = [];
  for (const s of effective) {
    const needsUpscale = s.px > long;

    // Square target for cover; same long-edge cap for inside
    const resizeOpts = {
      width: s.px,
      height: s.px,
      fit: s.fit,                      // 'cover' or 'inside'
      withoutEnlargement: !needsUpscale,
      kernel: sharp.kernel.lanczos3,
    };
    if (s.fit === "cover") {
      resizeOpts.position = "attention"; // smart crop focus for thumbs
    }

    let pipe = sharp(srcBuf, { failOn: "none" }).rotate().resize(resizeOpts);
    if (needsUpscale) pipe = pipe.sharpen({ sigma: 0.3 }); // subtle sharpen after upscale

    const fmt = primaryExt === "jpg" ? "jpeg" : primaryExt;
    const { data, info } = await pipe.toFormat(fmt).toBuffer({ resolveWithObject: true });

    const destKey = `${baseKey}${s.name}.${primaryExt}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: targetBucket,
        Key: destKey,
        Body: data,
        ContentType: MIME[primaryExt] || "image/jpeg",
        Metadata: {
          id,
          basekey: baseKey,
          sourcebucket: srcBucket,
          sourcekey: srcKey,
          variant: s.name,
          width: String(info.width || s.px),
          height: String(info.height || s.px),
          fit: String(s.fit),
          upscaled: needsUpscale ? "1" : "0",
          upscale_max: String(UPSCALE_MAX),
        },
      })
    );

    log(
      `Wrote s3://${targetBucket}/${destKey} (${info.width}x${info.height}${
        needsUpscale ? ", upscaled" : ""
      })`
    );
    outputs.push({
      name: s.name,
      key: destKey,
      width: info.width,
      height: info.height,
      bytes: data.length,
      upscaled: needsUpscale,
    });
  }

  await maybeWriteMetadata(targetBucket, baseKey, id, contentType, { variants: outputs });
  return { id, baseKey, targetBucket, variants: outputs };
}

// ---------- helpers ----------
async function copyOriginal(srcBucket, srcKey, dstBucket, dstKey, contentType) {
  // Copy preserves bytes without downloading; replace metadata so content-type is set
  const Source = encodeURIComponent(`${srcBucket}/${srcKey}`);
  await s3.send(
    new CopyObjectCommand({
      Bucket: dstBucket,
      Key: dstKey,
      CopySource: Source,
      ContentType: contentType || guessContentTypeFromKey(srcKey),
      MetadataDirective: "REPLACE",
      Metadata: { copiedfrom: `${srcBucket}/${srcKey}` },
    })
  );
}

function guessContentTypeFromKey(key = "") {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function normalizeMeta(m = {}) {
  const out = {};
  for (const [k, v] of Object.entries(m)) out[String(k).toLowerCase()] = String(v);
  return out;
}

async function maybeWriteMetadata(bucket, baseKey, id, contentType, extra = {}) {
  if (!METADATA_TABLE) return;
  try {
    const pk = `image#${bucket}/${baseKey}${id}`;
    const now = new Date().toISOString();
    await ddb.send(
      new PutItemCommand({
        TableName: METADATA_TABLE,
        Item: {
          pk:          { S: pk },
          sk:          { S: "v#0" },
          id:          { S: id },
          baseKey:     { S: baseKey },
          bucket:      { S: bucket },
          contentType: { S: contentType || "" },
          updatedAt:   { S: now },
          variants:    { S: JSON.stringify(extra.variants || []) },
        },
      })
    );
  } catch (err) {
    console.warn("DynamoDB PutItem failed (non-fatal):", err?.message || err);
  }
}
