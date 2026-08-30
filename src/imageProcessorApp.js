// src/imageProcessorApp.js - OPTIMIZED VERSION
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import sharp from "sharp";
import { planFromHead, MIME } from "./lib/plan.js";
import { generateId } from "./id.js";

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

// Modified: Process only jpg and webp by default (AVIF is too slow)
const MULTI_FORMATS = (process.env.MULTI_FORMATS || "webp,jpg")
  .split(",").map(f => f.trim().toLowerCase().replace("jpeg", "jpg"))
  .filter(f => ["avif", "webp", "jpg", "png"].includes(f));

const PRESERVE_SOURCE_FOR = (process.env.PRESERVE_SOURCE_FOR || "png,pdf,tiff")
  .split(",").map(f => f.trim().toLowerCase());

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
  if (!Array.isArray(SIZES) || !SIZES.length) SIZES = DEFAULT_SIZES; 
}
catch { SIZES = DEFAULT_SIZES; }

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const trim = (s) => String(s || "").replace(/^\/+/, "").replace(/\/+$/, "");

const isImageLike = (ct = "", key = "") =>
  /image\/(jpeg|jpg|png|tiff|webp|avif|heic|bmp)/i.test(ct) ||
  /\.(jpe?g|png|tiff?|webp|avif|heic|bmp)$/i.test(key);

const isPDF  = (ct = "", key = "") => /pdf/i.test(ct)  || /\.pdf$/i.test(key);
const isTIFF = (ct = "", key = "") => /tiff?/i.test(ct) || /\.tiff?$/i.test(key);

const streamToBuffer = async (r) => { 
  const chunks=[]; 
  for await (const c of r) chunks.push(c); 
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

export const handler = async (event) => {
  log("=== IMAGE PROCESSOR STARTED ===");
  log("Timeout:", process.env.AWS_LAMBDA_FUNCTION_TIMEOUT || "unknown");
  log("Memory:", process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || "unknown");
  log("Formats to process:", MULTI_FORMATS);
  
  if (!event?.Records) return {};
  
  const failures = [];
  for (const rec of event.Records) {
    try {
      const body = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
      let found = false;
      for (const { bucket, key } of iterS3Objects(body)) {
        found = true;
        await processOne(bucket, key);
      }
      if (!found) log("No S3 objects found in message");
    } catch (err) {
      console.error(`Record failed:`, err);
      failures.push({ itemIdentifier: rec.messageId });
    }
  }
  
  return failures.length ? { batchItemFailures: failures } : {};
};

async function processOne(srcBucket, srcKey) {
  log(`Processing ${srcBucket}/${srcKey}`);
  const startTime = Date.now();
  
  try {
    // Get metadata
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

    const baseKey = (excludeId && customBasePath)
      ? customBasePath
      : (plan.baseKey || `${trim(plan.basePrefix || DEFAULT_BASE_PREFIX)}/${id}/`);

    const primaryExt = (plan.primaryExt || PRIMARY_EXT).replace("jpeg", "jpg");
    const targetBucket = meta.targetbucket || TARGET_BUCKET_DEFAULT;

    log(`ID: ${id}, BaseKey: ${baseKey}`);

    // Write initial "processing" status
    const nowEpoch = Math.floor(Date.now() / 1000);
    const epochKey = String(nowEpoch).padStart(10, '0');
    await writeStatus(id, epochKey, "processing", {});

    // Copy original
    const srcExtLower = srcKey.split(".").pop()?.toLowerCase() || "";
    // Non-images are copied through untouched, so their extension must survive: rewriting it to the
    // (photo) primaryExt stored mp4/webm bytes as original.jpg. PRESERVE_SOURCE_FOR remains for
    // images we deliberately keep in their source format.
    const isNonImage = isPDF(contentType, srcKey) || !isImageLike(contentType, srcKey);
    const preserve = isNonImage || PRESERVE_SOURCE_FOR.includes(srcExtLower);
    const destOriginalKey = `${baseKey}original.${preserve ? srcExtLower : primaryExt}`;
    
    await copyOriginal(srcBucket, srcKey, targetBucket, destOriginalKey, contentType);
    const originalUrl = CDN_BASE ? `${CDN_BASE}/${destOriginalKey}` : `https://${targetBucket}.s3.amazonaws.com/${destOriginalKey}`;

    // Initialize URLs with original
    const urls = { original: originalUrl };

    // Non-image files
    if (isNonImage) {
      await writeVersionRow(id, targetBucket, baseKey, contentType, {
        variants: [],
        urls,
        status: "complete",
      });
      return;
    }

    // Download and check image
    const getRes = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    const srcBuf = await streamToBuffer(getRes.Body);
    log(`Downloaded ${srcBuf.length} bytes`);

    let metaIn;
    try { 
      metaIn = await sharp(srcBuf).metadata(); 
      log(`Image: ${metaIn.width}x${metaIn.height} ${metaIn.format}`);
    }
    catch (err) {
      await writeVersionRow(id, targetBucket, baseKey, contentType, {
        variants: [],
        urls,
        status: "error",
        error: "Failed to read image metadata",
      });
      return;
    }

    const srcWidth = metaIn.width || 0;
    const srcHeight = metaIn.height || 0;
    const long = Math.max(srcWidth, srcHeight);

    // Check TIFF limits
    if (isTIFF(contentType, srcKey) && long > MAX_TIFF_DIM) {
      await writeVersionRow(id, targetBucket, baseKey, contentType, {
        variants: [],
        urls,
        status: "error",
        error: `TIFF too large: ${srcWidth}x${srcHeight}`,
      });
      return;
    }

    // Build size ladder
    const ladder = SIZES
      .filter((s) => s.name !== "thumb")
      .map((s) => ({ 
        name: s.name, 
        target: Math.max(Number(s.width)||0, Number(s.height)||0), 
        fit: s.fit || "inside" 
      }))
      .sort((a,b)=>a.target-b.target);

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

    const formats = MULTI_FORMATS.length ? MULTI_FORMATS : [primaryExt];
    const outputs = [];
    let processedCount = 0;
    const totalVariants = effective.length * formats.length;

    log(`Processing ${totalVariants} variants (${effective.length} sizes × ${formats.length} formats)`);

    // Process each variant and update DynamoDB incrementally
    for (const s of effective) {
      const needsUpscale = s.px > long;
      const resizeOpts = {
        width: s.px, height: s.px, fit: s.fit,
        withoutEnlargement: !needsUpscale, kernel: sharp.kernel.lanczos3,
      };
      if (s.fit === "cover") resizeOpts.position = "attention";

      for (const fmt of formats) {
        processedCount++;
        const progress = `[${processedCount}/${totalVariants}]`;
        
        try {
          const variantStart = Date.now();
          
          // Skip full-size AVIF (too slow)
          if (fmt === "avif" && s.name === "full") {
            log(`${progress} Skipping full.avif (too slow)`);
            continue;
          }
          
          let pipe = sharp(srcBuf, { failOn: "none" }).rotate().resize(resizeOpts);
          if (needsUpscale) pipe = pipe.sharpen({ sigma: 0.3 });
          
          const sharpFmt = fmt === "jpg" ? "jpeg" : fmt;
          const formatOptions = getOptimizedFormatOptions(fmt, s.name);
          
          const { data, info } = await pipe
            .toFormat(sharpFmt, formatOptions)
            .toBuffer({ resolveWithObject: true });

          const destKey = `${baseKey}${s.name}.${fmt}`;
          
          await s3.send(new PutObjectCommand({
            Bucket: targetBucket,
            Key: destKey,
            Body: data,
            ContentType: MIME[fmt] || "image/jpeg",
            CacheControl: CACHE_CONTROL,
            Metadata: {
              id, basekey: baseKey,
              variant: s.name, format: fmt,
              width: String(info.width), height: String(info.height),
            },
          }));

          const url = CDN_BASE ? `${CDN_BASE}/${destKey}` : `https://${targetBucket}.s3.amazonaws.com/${destKey}`;
          outputs.push({ 
            name: s.name, format: fmt, key: destKey, url, 
            width: info.width, height: info.height, bytes: data.length 
          });

          if (!urls[s.name]) urls[s.name] = {};
          urls[s.name][fmt] = url;
          
          const variantTime = ((Date.now() - variantStart) / 1000).toFixed(1);
          log(`${progress} ✓ ${s.name}.${fmt} (${variantTime}s, ${(data.length/1024).toFixed(0)}KB)`);
          
          // Update DynamoDB every 5 variants to show progress
          if (processedCount % 5 === 0) {
            await updateStatus(id, epochKey, "processing", urls, outputs);
          }
          
        } catch (err) {
          warn(`${progress} ✗ Failed ${s.name}.${fmt}: ${err.message}`);
        }
      }
    }

    // Write final complete status
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✓ Complete in ${totalTime}s`);
    
    await writeVersionRow(id, targetBucket, baseKey, contentType, {
      variants: outputs,
      urls,
      status: "complete",
      sourceWidth: srcWidth,
      sourceHeight: srcHeight,
      sourceFormat: metaIn.format || "",
    });
    
  } catch (err) {
    console.error("Error in processOne:", err);
    throw err;
  }
}

// Optimized format options for faster processing
function getOptimizedFormatOptions(fmt, sizeName) {
  // Use lower quality for larger sizes to speed up processing
  const isLarge = sizeName === "large" || sizeName === "full";
  
  switch (fmt) {
    case "jpg": 
      return { 
        quality: isLarge ? 80 : 85, 
        progressive: true, 
        mozjpeg: true 
      };
    case "webp": 
      return { 
        quality: isLarge ? 80 : 85, 
        effort: 2  // Reduced from 4 for faster processing
      };
    case "avif": 
      return { 
        quality: isLarge ? 75 : 80, 
        effort: 1,  // Minimum effort for much faster processing
        speed: 8    // Maximum speed (0-8 scale, 8 is fastest)
      };
    case "png": 
      return { 
        compressionLevel: 6  // Reduced from 9
      };
    default: 
      return {};
  }
}

async function copyOriginal(srcBucket, srcKey, dstBucket, dstKey, contentType) {
  const CopySource = encodeURIComponent(`${srcBucket}/${srcKey}`);
  await s3.send(new CopyObjectCommand({
    Bucket: dstBucket,
    Key: dstKey,
    CopySource,
    ContentType: contentType || guessContentTypeFromKey(srcKey),
    CacheControl: CACHE_CONTROL,
    MetadataDirective: "REPLACE",
    Metadata: { copiedfrom: `${srcBucket}/${srcKey}` },
  }));
}

function guessContentTypeFromKey(key = "") {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function normalizeMeta(m = {}) { 
  const out = {}; 
  for (const [k,v] of Object.entries(m)) {
    out[String(k).toLowerCase()] = String(v);
  }
  return out; 
}

// Write initial status
async function writeStatus(id, epochKey, status, urls) {
  if (!METADATA_TABLE) return;
  
  try {
    await ddb.send(new PutItemCommand({
      TableName: METADATA_TABLE,
      Item: {
        PK: { S: id },
        SK: { S: epochKey },
        status: { S: status },
        urls: { S: JSON.stringify(urls || {}) },
        updatedAt: { S: new Date().toISOString() }
      }
    }));
  } catch (err) {
    warn(`Status write failed: ${err.message}`);
  }
}

// Update status with partial results
async function updateStatus(id, epochKey, status, urls, variants) {
  if (!METADATA_TABLE) return;
  
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: METADATA_TABLE,
      Key: {
        PK: { S: id },
        SK: { S: epochKey }
      },
      UpdateExpression: "SET #status = :status, urls = :urls, variants = :variants, updatedAt = :now",
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":status": { S: status },
        ":urls": { S: JSON.stringify(urls || {}) },
        ":variants": { S: JSON.stringify(variants || []) },
        ":now": { S: new Date().toISOString() }
      }
    }));
  } catch (err) {
    warn(`Status update failed: ${err.message}`);
  }
}

// Write final version row
async function writeVersionRow(id, bucket, baseKey, contentType, extra = {}) {
  if (!METADATA_TABLE) return;
  
  try {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const nowIso = new Date(nowEpoch * 1000).toISOString();
    
    await ddb.send(new PutItemCommand({
      TableName: METADATA_TABLE,
      Item: {
        PK:          { S: id },
        SK:          { S: String(nowEpoch).padStart(10, '0') },
        id:          { S: id },
        baseKey:     { S: baseKey },
        bucket:      { S: bucket },
        contentType: { S: contentType || "" },
        status:      { S: extra.status || "complete" },
        updatedAt:   { S: nowIso },
        variants:    { S: JSON.stringify(extra.variants || []) },
        urls:        { S: JSON.stringify(extra.urls || {}) },
        ...(extra.error ? { error: { S: String(extra.error) } } : {}),
        ...(extra.sourceWidth ? { sourceWidth: { N: String(extra.sourceWidth) } } : {}),
        ...(extra.sourceHeight ? { sourceHeight: { N: String(extra.sourceHeight) } } : {}),
        ...(extra.sourceFormat ? { sourceFormat: { S: String(extra.sourceFormat) } } : {}),
      },
    }));
  } catch (err) {
    console.error("DynamoDB write failed:", err);
  }
}