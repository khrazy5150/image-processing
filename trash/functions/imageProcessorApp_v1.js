// imageProcessorApp.js — Node.js 20, AWS SDK v3
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import sharp from "sharp";
import { Readable } from "stream";

/** ---------- clients ---------- */
const s3 = new S3Client({});
const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** ---------- env ---------- */
const SOURCE_BUCKET_DEFAULT = process.env.SOURCE_BUCKET_DEFAULT; // created bucket name
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT;
const OUTPUT_PREFIX = (process.env.OUTPUT_PREFIX || "resized/").replace(/^\/+/, "").replace(/\/+$/, "") + "/";
const TABLE = process.env.IMAGE_METADATA_TABLE_NAME;
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

let SIZES = [
  { name: "thumb",  width: 200,  height: 200,  fit: "cover"  },
  { name: "medium", width: 800,  height: 800,  fit: "inside" },
  { name: "large",  width: 1600, height: 1600, fit: "inside" },
];

try {
  if (process.env.SIZES_JSON) {
    const parsed = JSON.parse(process.env.SIZES_JSON);
    if (Array.isArray(parsed) && parsed.length) SIZES = parsed;
  }
} catch (e) {
  console.warn("Invalid SIZES_JSON; using defaults. Error:", e?.message);
}

/** ---------- helpers ---------- */
const log   = (...a) => console.log(...a);
const error = (...a) => console.error(...a);

const streamToBuffer = async (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const rs = stream instanceof Readable ? stream : Readable.from(stream);
    rs.on("data", (c) => chunks.push(c));
    rs.on("end", () => resolve(Buffer.concat(chunks)));
    rs.on("error", reject);
  });

const isImageKey = (key = "") => /\.(jpe?g|png|webp|tiff?|gif|avif|heic|heif)$/i.test(key);

function pickOutputFormat({ contentType = "", key = "" } = {}) {
  // Normalize output to JPEG unless source is PNG (keeps transparency).
  // (HEIC/HEIF etc. become JPEG for broad browser support.)
  const lowerCT = String(contentType).toLowerCase();
  const lowerKey = String(key).toLowerCase();
  if (lowerCT.includes("png") || lowerKey.endsWith(".png")) {
    return { ext: "png", mime: "image/png" };
  }
  return { ext: "jpeg", mime: "image/jpeg" };
}

/** ---------- main ---------- */
export const handler = async (event) => {
  // SQS event → body contains S3 event
  if (!event || !event.Records) return;

  const failures = [];

  for (const rec of event.Records) {
    try {
      const body = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body;
      const s3Records = body?.Records || [];
      for (const s3rec of s3Records) {
        const bucket = s3rec?.s3?.bucket?.name || SOURCE_BUCKET_DEFAULT;
        const key = decodeURIComponent(s3rec?.s3?.object?.key || "");

        if (!bucket || !key) {
          log("Skipping record with missing bucket/key");
          continue;
        }
        if (!isImageKey(key)) {
          log(`Skipping non-image key: ${key}`);
          continue;
        }

        await processOne(bucket, key);
      }
    } catch (e) {
      error("Record failed:", e);
      failures.push({ itemIdentifier: rec.messageId });
    }
  }

  // Tell Lambda/SQS about per-message failures (partial batch response)
  if (failures.length) {
    return { batchItemFailures: failures };
  }
};

async function processOne(srcBucket, srcKey) {
  const tgtBucket = TARGET_BUCKET_DEFAULT;
  if (!tgtBucket) throw new Error("TARGET_BUCKET_DEFAULT not set");

  log(`Processing: s3://${srcBucket}/${srcKey}`);

  // HEAD (cheap) to get content type and ensure object exists
  let contentType = "image/jpeg";
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    if (head.ContentType) contentType = head.ContentType;
  } catch (e) {
    // If HEAD fails (permissions), still attempt GET below.
    log("HEAD failed (not fatal):", e?.name || e?.code || e?.message);
  }

  // GET original
  const getResp = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
  const originalBuf = await streamToBuffer(getResp.Body);

  // Log EXIF orientation for visibility (undefined means none)
  try {
    const meta = await sharp(originalBuf).metadata();
    if (LOG_LEVEL !== "silent") log("EXIF orientation:", meta?.orientation ?? "n/a");
  } catch {
    /* ignore metadata failures */
  }

  // Decide output format (png keeps transparency, else jpeg)
  const { ext: normalizedExt, mime: outMime } = pickOutputFormat({ contentType, key: srcKey });

  // Keep the original path, but prefix with OUTPUT_PREFIX + size name
  for (const spec of SIZES) {
    const { name, width, height, fit = "inside" } = spec;

    // Auto-apply EXIF orientation, don't upscale, encode, and reset orientation to 1
    let pipeline = sharp(originalBuf)
      .rotate() // <-- normalize orientation from EXIF
      .resize({ width, height, fit, withoutEnlargement: true })
      .withMetadata({ orientation: 1 });

    if (normalizedExt === "png") {
      pipeline = pipeline.png({ compressionLevel: 9 });
    } else {
      pipeline = pipeline.jpeg({ quality: 80, mozjpeg: true, progressive: true });
    }

    const resized = await pipeline.toBuffer();

    const destKey = `${OUTPUT_PREFIX}${name}/${srcKey.replace(/^\/+/, "")}`;
    log(`Writing ${name} -> s3://${tgtBucket}/${destKey}`);

    await s3.send(
      new PutObjectCommand({
        Bucket: tgtBucket,
        Key: destKey,
        Body: resized,
        ContentType: outMime,
        Metadata: {
          "src-bucket": srcBucket,
          "src-key": srcKey,
          width: String(width),
          height: String(height),
          fit: String(fit),
        },
      })
    );

    // Optional metadata write
    if (TABLE) {
      const now = new Date().toISOString();
      await ddbDoc.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            pk: `image#${srcBucket}/${srcKey}`,
            sk: `size#${name}`,
            targetBucket: tgtBucket,
            targetKey: destKey,
            width,
            height,
            fit,
            outMime: outMime,
            createdAt: now,
          },
        })
      );
    }
  }

  log(`Done: s3://${srcBucket}/${srcKey}`);
}
