// src/imageProcessorApp.js
// Enhanced with multi-format output, TIFF handling, and COMPLETE metadata updates
// Now aligns DDB keys with UploadMultiple: PK=PHOTO#<id>, SK=META#v1

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

// ----- env / config -----
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const TARGET_BUCKET_DEFAULT =
  process.env.TARGET_BUCKET_DEFAULT || process.env.TARGET_BUCKET || "images.juniorbay.net";

const METADATA_TABLE =
  process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";

const PRIMARY_EXT = (process.env.PRIMARY_EXT || "jpg").toLowerCase().replace("jpeg", "jpg");
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || "photos";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const CACHE_CONTROL = process.env.CACHE_CONTROL || undefined;
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");

const ALLOW_UPSCALE = process.env.ALLOW_UPSCALE === "1";
const UPSCALE_MAX = Number(process.env.UPSCALE_MAX || "2");

// NEW: Multi-format support
const MULTI_FORMATS = (process.env.MULTI_FORMATS || "")
  .split(",")
  .map(f => f.trim().toLowerCase().replace("jpeg", "jpg"))
  .filter(f => ["avif", "webp", "jpg", "png"].includes(f));

// NEW: Preserve original for these formats
const PRESERVE_SOURCE_FOR = (process.env.PRESERVE_SOURCE_FOR || "png,pdf,tiff")
  .split(",")
  .map(f => f.trim().toLowerCase());

// NEW: TIFF dimension limit
const MAX_TIFF_DIM = Number(process.env.MAX_TIFF_DIM || 3000);

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

// ----- utils -----
const log = (...a) => (LOG_LEVEL !== "silent" ? console.log(...a) : null);
const warn = (...a) => (LOG_LEVEL !== "silent" ? console.warn(...a) : null);
const trim = (s) => String(s || "").replace(/^\/+/, "").replace(/\/+$/, "");

const isImageLike = (ct = "", key = "") =>
  /image\/(jpeg|jpg|png|tiff|webp|avif|heic|bmp)/i.test(ct) ||
  /\.(jpe?g|png|tiff?|webp|avif|heic|bmp)$/i.test(key);

const isPDF  = (ct = "", key = "") => /pdf/i.test(ct)  || /\.pdf$/i.test(key);
const isPNG  = (ct = "", key = "") => /png/i.test(ct)  || /\.png$/i.test(key);
const isTIFF = (ct = "", key = "") => /tiff?/i.test(ct) || /\.tiff?$/i.test(key);

const streamToBuffer = async (readable) => {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
};

function* iterS3Objects(msg) {
  if (msg?.Records && Array.isArray(msg.Records)) {
    for (const r of msg.Records) {
      const b = r?.s3?.bucket?.name;
      const k = r?.s3?.object?.key;
      if (b && k) yield { bucket: b, key: decodeURIComponent(String(k).replace(/\+/g, " ")) };
    }
    return;
  }
  if (msg?.source === "aws.s3" && typeof msg["detail-type"] === "string") {
    const dt = msg["detail-type"];
    if (dt.startsWith("Object Created")) {
      const b = msg?.detail?.bucket?.name;
      const k = msg?.detail?.object?.key;
      if (b && k) yield { bucket: b, key: decodeURIComponent(String(k)) };
    }
    return;
  }
  if (Array.isArray(msg)) {
    for (const m of msg) yield* iterS3Objects(m);
  }
}

// ----- Lambda handler (SQS trigger) -----
export const handler = async (event) => {
  if (!event?.Records) return {};
  const failures = [];

  log("ENV:", {
    TARGET_BUCKET_DEFAULT,
    METADATA_TABLE,
    PRIMARY_EXT,
    MULTI_FORMATS: MULTI_FORMATS.length ? MULTI_FORMATS.join(",") : "none",
    PRESERVE_SOURCE_FOR: PRESERVE_SOURCE_FOR.join(","),
    MAX_TIFF_DIM,
    ALLOW_UPSCALE,
    UPSCALE_MAX,
  });

  for (const rec of event.Records) {
    try {
      const body = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;

      let found = false;
      for (const { bucket, key } of iterS3Objects(body)) {
        found = true;
        await processOne(bucket, key);
      }
      if (!found) {
        log("No S3 objects in message; body keys:", Object.keys(body || {}));
      }
    } catch (err) {
      console.error("Record failed:", err);
      failures.push({ itemIdentifier: rec.messageId });
    }
  }

  return failures.length ? { batchItemFailures: failures } : {};
};

// ----- main worker -----
async function processOne(srcBucket, srcKey) {
  log(`Processing s3://${srcBucket}/${srcKey}`);

  const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const meta = normalizeMeta(head.Metadata || {});
  const contentType = head.ContentType || "";

  const plan = planFromHead({
    head,
    srcKey,
    defaults: { basePrefix: DEFAULT_BASE_PREFIX, primaryExt: PRIMARY_EXT },
  });

  const id = meta.id || plan.id || generateId();
  const excludeId = meta.excludeid === "true";
  const customBasePath = meta.custombasepath || "";
  
  // Use custom path if excludeId is true, otherwise standard path with ID
  const baseKey = (excludeId && customBasePath) 
    ? customBasePath
    : (plan.baseKey || `${trim(plan.basePrefix || DEFAULT_BASE_PREFIX)}/${id}/`);
    
  const primaryExt = (plan.primaryExt || PRIMARY_EXT).replace("jpeg", "jpg");
  const targetBucket = meta.targetbucket || TARGET_BUCKET_DEFAULT;

  // Determine if we should preserve original extension
  const srcExtLower = srcKey.split(".").pop()?.toLowerCase() || "";
  const shouldPreserve = PRESERVE_SOURCE_FOR.some(fmt => 
    srcExtLower === fmt || contentType.toLowerCase().includes(fmt)
  );
  
  const preserveOriginalExt = shouldPreserve ? srcExtLower : null;

  // 1) Copy original
  const destOriginalKey = `${baseKey}original.${preserveOriginalExt || primaryExt}`;
  await copyOriginal(srcBucket, srcKey, targetBucket, destOriginalKey, contentType);
  const originalEtag = await verifyWrite(targetBucket, destOriginalKey, "original");

  // Build original URL
  const originalUrl = CDN_BASE 
    ? `${CDN_BASE}/${destOriginalKey}`
    : `https://${targetBucket}.s3.amazonaws.com/${destOriginalKey}`;

  // Stop here if PDF or not image-like
  if (isPDF(contentType, srcKey) || !isImageLike(contentType, srcKey)) {
    log(`Copied original only (no derivatives) → s3://${targetBucket}/${destOriginalKey}`);
    await writeMetadataCompat(id, targetBucket, baseKey, contentType, {
      variants: [],
      urls: { original: originalUrl },
      status: "complete",
    });
    return;
  }

  // 2) Fetch and process image
  const getRes = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const srcBuf = await streamToBuffer(getRes.Body);

  let metaIn;
  try {
    metaIn = await sharp(srcBuf).metadata();
  } catch (err) {
    warn(`Sharp metadata failed for ${srcKey}:`, err.message);
    await writeMetadataCompat(id, targetBucket, baseKey, contentType, {
      variants: [],
      urls: { original: originalUrl },
      status: "error",
      error: "Failed to read image metadata",
    });
    return;
  }

  const srcWidth = metaIn.width || 0;
  const srcHeight = metaIn.height || 0;
  const long = Math.max(srcWidth, srcHeight);

  // TIFF dimension check
  if (isTIFF(contentType, srcKey) && long > MAX_TIFF_DIM) {
    warn(`TIFF exceeds MAX_TIFF_DIM (${long} > ${MAX_TIFF_DIM}): ${srcKey}`);
    await writeMetadataCompat(id, targetBucket, baseKey, contentType, {
      variants: [],
      urls: { original: originalUrl },
      status: "error",
      error: `TIFF dimensions too large: ${srcWidth}x${srcHeight} (max ${MAX_TIFF_DIM})`,
    });
    return;
  }

  // Build size ladder
  const ladder = SIZES
    .filter((s) => s.name !== "thumb")
    .map((s) => ({
      name: s.name,
      target: Math.max(Number(s.width) || 0, Number(s.height) || 0),
      fit: s.fit || "inside",
    }))
    .sort((a, b) => a.target - b.target);

  const effective = [];
  let lastPx = 0;
  for (const t of ladder) {
    const cap = Math.round(long * UPSCALE_MAX);
    const eff = ALLOW_UPSCALE ? Math.min(t.target, cap) : Math.min(t.target, long);
    if (!eff || eff === lastPx) continue;
    effective.push({ name: t.name, px: eff, fit: t.fit });
    lastPx = eff;
  }
  effective.push({ name: "thumb", px: 200, fit: "cover" });

  // Determine output formats
  const formats = MULTI_FORMATS.length > 0 ? MULTI_FORMATS : [primaryExt];

  // Generate variants
  const outputs = [];
  const urls = { original: originalUrl };

  for (const s of effective) {
    const needsUpscale = s.px > long;
    const resizeOpts = {
      width: s.px,
      height: s.px,
      fit: s.fit,
      withoutEnlargement: !needsUpscale,
      kernel: sharp.kernel.lanczos3,
    };
    if (s.fit === "cover") resizeOpts.position = "attention";

    for (const fmt of formats) {
      try {
        let pipe = sharp(srcBuf, { failOn: "none" }).rotate().resize(resizeOpts);
        if (needsUpscale) pipe = pipe.sharpen({ sigma: 0.3 });

        const sharpFmt = fmt === "jpg" ? "jpeg" : fmt;
        const { data, info } = await pipe.toFormat(sharpFmt, getFormatOptions(fmt))
          .toBuffer({ resolveWithObject: true });

        const destKey = `${baseKey}${s.name}.${fmt}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: targetBucket,
            Key: destKey,
            Body: data,
            ContentType: MIME[fmt] || "image/jpeg",
            CacheControl: CACHE_CONTROL,
            Metadata: {
              id,
              basekey: baseKey,
              sourcebucket: srcBucket,
              sourcekey: srcKey,
              variant: s.name,
              format: fmt,
              width: String(info.width || s.px),
              height: String(info.height || s.px),
              fit: String(s.fit),
              upscaled: needsUpscale ? "1" : "0",
              upscale_max: String(UPSCALE_MAX),
            },
          })
        );

        const etag = await verifyWrite(targetBucket, destKey, `${s.name}.${fmt}`);
        const url = CDN_BASE 
          ? `${CDN_BASE}/${destKey}`
          : `https://${targetBucket}.s3.amazonaws.com/${destKey}`;

        log(
          `Wrote s3://${targetBucket}/${destKey} (${info.width}x${info.height}${
            needsUpscale ? ", upscaled" : ""
          })${etag ? ` ETag=${etag}` : ""}`
        );

        outputs.push({
          name: s.name,
          format: fmt,
          key: destKey,
          url,
          width: info.width,
          height: info.height,
          bytes: data.length,
          upscaled: needsUpscale,
          etag,
        });

        // Build URL structure
        if (!urls[s.name]) urls[s.name] = {};
        urls[s.name][fmt] = url;
      } catch (err) {
        warn(`Failed to generate ${s.name}.${fmt}:`, err.message);
      }
    }
  }

  await writeMetadataCompat(id, targetBucket, baseKey, contentType, {
    variants: outputs,
    urls,
    status: "complete",
    sourceWidth: srcWidth,
    sourceHeight: srcHeight,
    sourceFormat: metaIn.format,
  });
}

// ----- helpers -----
function getFormatOptions(fmt) {
  switch (fmt) {
    case "jpg":
      return { quality: 85, progressive: true, mozjpeg: true };
    case "webp":
      return { quality: 85, effort: 4 };
    case "avif":
      return { quality: 80, effort: 4 };
    case "png":
      return { compressionLevel: 9, adaptiveFiltering: true };
    default:
      return {};
  }
}

async function copyOriginal(srcBucket, srcKey, dstBucket, dstKey, contentType) {
  const CopySource = encodeURIComponent(`${srcBucket}/${srcKey}`);
  await s3.send(
    new CopyObjectCommand({
      Bucket: dstBucket,
      Key: dstKey,
      CopySource,
      ContentType: contentType || guessContentTypeFromKey(srcKey),
      CacheControl: CACHE_CONTROL,
      MetadataDirective: "REPLACE",
      Metadata: { copiedfrom: `${srcBucket}/${srcKey}` },
    })
  );
}

async function verifyWrite(bucket, key, label) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ETag || "";
  } catch (e) {
    warn(`WARN: ${label} not head-able: s3://${bucket}/${key} (${e?.name || e})`);
    return "";
  }
}

function guessContentTypeFromKey(key = "") {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function normalizeMeta(m = {}) {
  const out = {};
  for (const [k, v] of Object.entries(m)) out[String(k).toLowerCase()] = String(v);
  return out;
}

// 🚩 Unified metadata writer that updates the same item created by presign step
async function writeMetadataCompat(id, bucket, baseKey, contentType, extra = {}) {
  if (!METADATA_TABLE) return;
  try {
    const now = new Date().toISOString();
    await ddb.send(
      new PutItemCommand({
        TableName: METADATA_TABLE,
        Item: {
          // 🔄 Match pending-row keys from UploadMultipleFunction
          PK:          { S: `PHOTO#${id}` },
          SK:          { S: "META#v1" },

          // Common attributes
          id:          { S: id },
          baseKey:     { S: baseKey },
          bucket:      { S: bucket },
          contentType: { S: contentType || "" },
          status:      { S: extra.status || "complete" },
          updatedAt:   { S: now },
          variants:    { S: JSON.stringify(extra.variants || []) },
          urls:        { S: JSON.stringify(extra.urls || {}) },

          ...(extra.error ? { error: { S: String(extra.error) } } : {}),
          ...(extra.sourceWidth ? { sourceWidth: { N: String(extra.sourceWidth) } } : {}),
          ...(extra.sourceHeight ? { sourceHeight: { N: String(extra.sourceHeight) } } : {}),
          ...(extra.sourceFormat ? { sourceFormat: { S: String(extra.sourceFormat) } } : {}),
        },
      })
    );
  } catch (err) {
    warn("DynamoDB PutItem failed (non-fatal):", err?.message || err);
  }
}