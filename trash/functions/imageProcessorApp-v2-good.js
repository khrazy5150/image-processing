// src/imageProcessorApp.js
// SQS-triggered Lambda: consumes S3:ObjectCreated events, copies original, writes resized variants
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

// ---- config (env) ----
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || process.env.TARGET_BUCKET || "images.juniorbay.net";
const METADATA_TABLE = process.env.IMAGE_METADATA_TABLE_NAME || ""; // optional
const PRIMARY_EXT = (process.env.PRIMARY_EXT || "jpg").toLowerCase().replace("jpeg", "jpg");
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || "photos";
const OUTPUT_PREFIX = (process.env.OUTPUT_PREFIX || "").replace(/^\/+|\/+$/g, ""); // optional sub-prefix (unused if you prefer baseKey only)
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const DEFAULT_SIZES = [
  { name: "thumb", width: 200, height: 200, fit: "cover" },
  { name: "small", width: 480, height: 480, fit: "inside" },
  { name: "medium", width: 800, height: 800, fit: "inside" },
  { name: "large", width: 1600, height: 1600, fit: "inside" },
  { name: "full", width: 2560, height: 2560, fit: "inside" },
];
let SIZES;
try {
  SIZES = JSON.parse(process.env.SIZES_JSON || "[]");
  if (!Array.isArray(SIZES) || SIZES.length === 0) SIZES = DEFAULT_SIZES;
} catch {
  SIZES = DEFAULT_SIZES;
}

// ---- utilities ----
const log = (...a) => (LOG_LEVEL !== "silent" ? console.log(...a) : null);
const isImageLike = (ct = "") => /image\/(jpeg|jpg|png|tiff|webp|avif)/i.test(ct);
const isPDF = (ct = "", key = "") => /pdf/i.test(ct) || /\.pdf$/i.test(key);
const isPNG = (ct = "", key = "") => /png/i.test(ct) || /\.png$/i.test(key);
const isTIFF = (ct = "", key = "") => /tiff?/i.test(ct) || /\.tiff?$/i.test(key);
const trim = (s) => String(s || "").replace(/^\/+/, "").replace(/\/+$/, "");
const streamToBuffer = async (readable) => {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// ---- main handler ----
export const handler = async (event) => {
  // SQS delivers messages; each message body is an S3 event JSON string
  const results = [];
  for (const rec of event.Records || []) {
    try {
      const message = JSON.parse(rec.body || "{}");
      const s3Records = Array.isArray(message.Records) ? message.Records : [];
      for (const s3r of s3Records) {
        const srcBucket = s3r?.s3?.bucket?.name;
        const srcKey = decodeURIComponent((s3r?.s3?.object?.key || "").replace(/\+/g, " "));
        if (!srcBucket || !srcKey) continue;
        results.push(await processOne(srcBucket, srcKey));
      }
    } catch (err) {
      console.error("SQS message parse/processing error:", err);
      throw err; // rethrow so Lambda/SQS retries
    }
  }
  return { ok: true, results };
};

// ---- processor ----
async function processOne(srcBucket, srcKey) {
  log(`Processing ${srcBucket}/${srcKey}`);
  const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const meta = normalizeMeta(head.Metadata || {});
  const contentType = head.ContentType || "";

  // Plan from metadata (preferred) or fallback to legacy derivation
  const plan = planFromHead({
    head,
    srcKey,
    defaults: { basePrefix: DEFAULT_BASE_PREFIX, primaryExt: PRIMARY_EXT },
  });
  const id = meta.id || plan.id || generateId();
  const baseKey = plan.baseKey || `${trim(plan.basePrefix || DEFAULT_BASE_PREFIX)}/${id}/`;
  const primaryExt = (plan.primaryExt || PRIMARY_EXT).replace("jpeg", "jpg");
  const targetBucket = meta.targetbucket || TARGET_BUCKET_DEFAULT;

  const preserveOriginalExt = isTIFF(contentType, srcKey)
    ? "tiff"
    : isPNG(contentType, srcKey)
    ? "png"
    : isPDF(contentType, srcKey)
    ? "pdf"
    : null;

  // 1) Copy or fetch original
  // If you want original also in the target bucket, copy it as original.<ext>
  const destOriginalKey = `${baseKey}original.${preserveOriginalExt || primaryExt}`;
  await copyOriginal(srcBucket, srcKey, targetBucket, destOriginalKey, contentType);

  // If not an image Sharp can handle (e.g., PDF), stop after copying original
  if (!isImageLike(contentType) || preserveOriginalExt === "pdf") {
    log(`Non-image or pdf; copied original only to s3://${targetBucket}/${destOriginalKey}`);
    await maybeWriteMetadata(targetBucket, baseKey, id, contentType, { variants: [] });
    return { id, baseKey, targetBucket, variants: [] };
  }

  // 2) Read original bytes and build derivatives with Sharp
  const getRes = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const srcBuf = await streamToBuffer(getRes.Body);

  const variants = await Promise.all(
    SIZES.map(async (s) => {
      const img = sharp(srcBuf, { failOn: "none" }).rotate(); // auto-orient
      const resized = await img
        .resize({ width: s.width, height: s.height, fit: s.fit || "inside", withoutEnlargement: true })
        .toFormat(primaryExt === "jpg" ? "jpeg" : primaryExt)
        .toBuffer();

      const destKey = `${baseKey}${s.name}.${primaryExt}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: destKey,
          Body: resized,
          ContentType: MIME[primaryExt] || "image/jpeg",
          Metadata: {
            // small helpful metadata (optional)
            id,
            basekey: baseKey,
            sourcebucket: srcBucket,
            sourcekey: srcKey,
            variant: s.name,
            width: String(s.width),
            height: String(s.height),
            fit: String(s.fit || "inside"),
          },
        })
      );
      log(`Wrote s3://${targetBucket}/${destKey}`);
      return { name: s.name, key: destKey, size: resized.length };
    })
  );

  await maybeWriteMetadata(targetBucket, baseKey, id, contentType, { variants });

  return { id, baseKey, targetBucket, variants };
}

// ---- helpers ----
async function copyOriginal(srcBucket, srcKey, dstBucket, dstKey, contentType) {
  // Copy preserves original bytes without double download; falls back to Get/Put if needed
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
          pk: { S: pk },
          sk: { S: "v#0" },
          id: { S: id },
          baseKey: { S: baseKey },
          bucket: { S: bucket },
          contentType: { S: contentType || "" },
          updatedAt: { S: now },
          variants: { S: JSON.stringify(extra.variants || []) },
        },
      })
    );
  } catch (err) {
    console.warn("DynamoDB PutItem failed (non-fatal):", err?.message || err);
  }
}
