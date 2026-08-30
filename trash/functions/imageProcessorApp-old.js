// v2 processor: single DynamoDB item per photo, static derivatives, short IDs

import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, CopyObjectCommand
} from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import sharp from "sharp";
import { encode as blurhashEncode } from "blurhash";
import { Readable } from "stream";
import { generateId } from "./id.js";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.PHOTOS_TABLE;
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT;
const PRIMARY_EXT = (process.env.PRIMARY_EXT || "jpg").toLowerCase();
const MULTI_FORMATS = (process.env.MULTI_FORMATS || "avif,webp,jpg").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
const PRESERVE_SOURCE_FOR = (process.env.PRESERVE_SOURCE_FOR || "png,pdf").split(",").map(s=>s.trim().toLowerCase());
const MAX_TIFF_DIM = Number(process.env.MAX_TIFF_DIM || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const PUBLIC_READ_ACL = (process.env.PUBLIC_READ_ACL || "false").toLowerCase() === "true";
const CACHE_CONTROL = process.env.CACHE_CONTROL || "public, max-age=31536000, immutable";
const DISABLE_BLURHASH = (process.env.DISABLE_BLURHASH || "false").toLowerCase() === "true";

let SIZES = [
  { name: "full",  width: 2560, height: 2560, fit: "inside" },
  { name: "large", width: 1920, height: 1920, fit: "inside" },
  { name: "medium",width: 1080, height: 1080, fit: "inside" },
  { name: "small", width: 640,  height: 640,  fit: "inside" },
  { name: "thumb", width: 200,  height: 200,  fit: "cover" }
];
try { if (process.env.SIZES_JSON) { const p = JSON.parse(process.env.SIZES_JSON); if (Array.isArray(p) && p.length) SIZES = p; } } catch {}

const log = (...a)=> (LOG_LEVEL!=="silent") && console.log(...a);
const error = (...a)=> console.error(...a);

const streamToBuffer = async (stream) => new Promise((resolve,reject)=>{
  const chunks=[]; const rs = stream instanceof Readable ? stream : Readable.from(stream);
  rs.on("data",c=>chunks.push(c)); rs.on("end",()=>resolve(Buffer.concat(chunks))); rs.on("error",reject);
});

const MIME = { jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", avif:"image/avif", png:"image/png", tiff:"image/tiff", pdf:"application/pdf" };

const detect = ({ contentType = "", key = "" }) => {
  const ct = String(contentType).toLowerCase();
  const k = String(key).toLowerCase();
  const has = (re) => new RegExp(re).test(k) || ct.includes(re.replace(/\\/g, ""));
  return {
    isPDF: has("pdf"),
    isPNG: has("\\.png$"),
    isJPEG: has("\\.jpe?g$"),
    isWEBP: has("\\.webp$"),
    isAVIF: has("\\.avif$"),
    isTIFF: has("\\.(tif|tiff)$")
  };
};

export const handler = async (event) => {
  const records = event?.Records || [];
  const failures = [];
  for (const r of records) {
    try {
      const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
      const s3recs = body?.Records || [];
      for (const s3r of s3recs) {
        const bucket = s3r?.s3?.bucket?.name;
        const key = decodeURIComponent(s3r?.s3?.object?.key || "");
        if (!bucket || !key) continue;
        await processOne(bucket, key);
      }
    } catch (e) {
      error("Record failed:", e);
      failures.push({ itemIdentifier: r.messageId });
    }
  }
  if (failures.length) return { batchItemFailures: failures };
};

async function processOne(srcBucket, srcKey) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const contentType = head.ContentType || '';
  const meta = normalizeMeta(head.Metadata || {});
  const { isPDF, isPNG, isTIFF } = detect({ contentType, key: srcKey });

  const get = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const buf = await streamToBuffer(get.Body);

  // Auto-orient per EXIF
  const sharp0 = sharp(buf, { failOn: 'none', /*unlimited: true*/ });
  const smeta = await sharp0.metadata();

  // Short id
  const id = meta.id || generateId();
  const createdAt = Date.now();

  // Target bucket + baseKey
  const targetBucket = meta.targetbucket || TARGET_BUCKET_DEFAULT;
  const basePrefix = trim(meta.baseprefix || 'photos');
  //const baseKey = `${basePrefix}/${yyyyMM(createdAt)}/${id}/`;
  const baseKey = `${basePrefix}/${id}/`;

  // Preserve original for PNG/PDF/TIFF
  const preserveExt = isTIFF ? 'tiff' : isPNG ? 'png' : isPDF ? 'pdf' : null;
  const primaryExt = (meta.forceformat || PRIMARY_EXT).replace('jpeg','jpg');

  // Copy or normalize original
  if (preserveExt) {
    await s3.send(new CopyObjectCommand({
      Bucket: targetBucket,
      Key: `${baseKey}original.${preserveExt}`,
      CopySource: `/${srcBucket}/${encodeURIComponent(srcKey)}`,
      ContentType: MIME[preserveExt],
      MetadataDirective: 'REPLACE',
      ...(PUBLIC_READ_ACL ? { ACL: 'public-read' } : {}),
      CacheControl: CACHE_CONTROL
    }));
  } else {
    const out = await sharp(buf).rotate().toFormat(primaryExt === 'jpg' ? 'jpeg' : primaryExt).toBuffer();
    await s3.send(new PutObjectCommand({
      Bucket: targetBucket,
      Key: `${baseKey}original.${primaryExt}`,
      Body: out,
      ContentType: MIME[primaryExt],
      ...(PUBLIC_READ_ACL ? { ACL: 'public-read' } : {}),
      CacheControl: CACHE_CONTROL
    }));
  }

  // Derivatives (skip for PDFs)
  const urls = {};
  if (!isPDF) {
    for (const { name, width, height, fit } of SIZES) {
      const out = await sharp(buf).rotate().resize({ width, height, fit, withoutEnlargement: true })
        .toFormat(primaryExt === 'jpg' ? 'jpeg' : primaryExt).toBuffer();
      const key = `${baseKey}${name}.${primaryExt}`;
      await s3.send(new PutObjectCommand({
        Bucket: targetBucket,
        Key: key,
        Body: out,
        ContentType: MIME[primaryExt],
        ...(PUBLIC_READ_ACL ? { ACL: 'public-read' } : {}),
        CacheControl: CACHE_CONTROL
      }));
      urls[name] = `${CDN_BASE}/${key}`;
    }
  }
  urls.original = `${CDN_BASE}/${baseKey}original.${preserveExt || primaryExt}`;

  // Average color (safe for images; skip PDFs)
  let color = "#000000";
  try {
    if (!isPDF) {
      const stats = await sharp(buf).rotate().toColourspace("srgb").stats();
      const [r,g,b] = stats.channels.length >= 3
        ? [stats.channels[0].mean, stats.channels[1].mean, stats.channels[2].mean]
        : [stats.channels[0].mean, stats.channels[0].mean, stats.channels[0].mean];
      color = toHex(r, g, b);
    }
  } catch (e) {
    console.warn("Color stats failed, defaulting to #000000:", e?.message || e);
  }

  // BlurHash (force 3ch sRGB, drop alpha; skip PDFs)
let blurHash = null;
if (!DISABLE_BLURHASH && !isPDF) {
try {
    // Create a simple, reliable preview using JPEG as intermediate format
    const jpegPreview = await sharp(buf)
    .rotate()
    .resize(32, 32, { fit: "fill" }) // Force exact 32x32
    .jpeg({ quality: 80, force: true }) // Ensure output is JPEG (RGB)
    .toBuffer();

    // Now process the JPEG to get raw RGB data
    const preview = await sharp(jpegPreview)
    .raw()
    .toBuffer({ resolveWithObject: true });
    
    // Validate dimensions and data match
    const { width, height, channels } = preview.info;
    const expectedLength = width * height * channels;

    console.log("BlurHash preview info:", {
    width,
    height,
    channels,
    dataLength: preview.data.length,
    expectedLength
    });

    if (channels === 3 && preview.data.length === expectedLength) {
    // Ensure the data is a standard array of integers before creating Uint8ClampedArray
    const pixelData = Array.from(preview.data);
    blurHash = blurhashEncode(
        new Uint8ClampedArray(pixelData),
        width,
        height,
        4,  // componentsX
        3   // componentsY
    );
    console.log("BlurHash generated successfully for dimensions:", width, "x", height);
    } else {
    console.warn("BlurHash skipped - data validation failed:", {
        channels,
        width,
        height,
        actualDataLength: preview.data.length,
        expectedDataLength: expectedLength
    });
    blurHash = null;
    }
} catch (e) {
    console.warn("BlurHash computation failed, skipping:", e?.message || e);
    blurHash = null; // non-fatal
}
}

  // EXIF disabled (module not installed)
  const exif = null;

  const item = {
    PK: `PHOTO#${id}`,
    SK: 'PHOTO',
    type: 'photo',

    id,
    ownerUserId: meta.owneruserid || 'USER#anonymous',
    useCase: meta.usecase || 'general',

    bucket: targetBucket,
    baseKey,
    fileExt: primaryExt,
    mime: MIME[primaryExt] || contentType || 'application/octet-stream',
    createdAt,

    width: smeta.width || null,
    height: smeta.height || null,
    bytes: head.ContentLength || buf.length || null,

    color,
    blurHash,
    exif: exif || null,
    description: meta.description || null,
    tags: meta.tags ? String(meta.tags).split(',').map(s=>s.trim()).filter(Boolean) : [],

    urls,
    links: { self: null, html: null, download: null },

    likes: 0, views: 0, downloads: 0,

    GSI1PK: (meta.owneruserid ? `USER#${String(meta.owneruserid).replace(/^USER#/, '')}` : 'USER#anonymous'),
    GSI1SK: `CREATED#${String(createdAt).padStart(13,'0')}#${id}`,

    GSI2PK: `USECASE#${meta.usecase || 'general'}`,
    GSI2SK: `CREATED#${String(createdAt).padStart(13,'0')}#${id}`,

    GSI3PK: 'PHOTO',
    GSI3SK: `LIKES#0000000000#${id}`
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
  log(`Wrote item PHOTO#${id}`);
}

function normalizeMeta(m) { const o={}; for (const [k,v] of Object.entries(m)) o[String(k).toLowerCase()] = String(v); return o; }
function trim(s){ return String(s).replace(/^\/+/, '').replace(/\/+$/, ''); }
function yyyyMM(ts){ const d=new Date(ts); return `${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function toHex(r,g,b){ const h = [r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''); return `#${h}`; }