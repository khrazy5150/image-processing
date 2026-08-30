// src/reprocessImage.js
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, HeadObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const sqs = new SQSClient({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || "";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";
const QUEUE_URL = process.env.QUEUE_URL || "";

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
    if (!METADATA_TABLE || !SOURCE_BUCKET || !QUEUE_URL) {
      return json(500, { error: "Missing configuration", message: "METADATA_TABLE, SOURCE_BUCKET, or QUEUE_URL not set" }, origin);
    }

    const id = event?.pathParameters?.id || "";
    if (!id) return json(400, { error: "Missing id parameter" }, origin);

    const body = event?.body ? JSON.parse(event.body) : {};
    const customSizes = body.sizes;
    const newBaseKey = body.baseKey;
    const newTargetBucket = body.targetBucket;
    const formats = body.formats;

    // 🔸 latest version
    const q = await ddb.send(new QueryCommand({
      TableName: METADATA_TABLE,
      KeyConditionExpression: "PK = :id",
      ExpressionAttributeValues: { ":id": { S: id } },
      ScanIndexForward: false,
      Limit: 1,
    }));
    if (!q.Items || !q.Items.length) {
      return json(404, { error: "Image not found", id, message: "No record exists for this ID" }, origin);
    }
    const item = unmarshall(q.Items[0]);
    const originalBaseKey = item.baseKey || "";
    const originalBucket = item.bucket || TARGET_BUCKET_DEFAULT;

    const possibleSourceKeys = [
      `${originalBaseKey}original.jpg`,
      `${originalBaseKey}original.png`,
      `${originalBaseKey}original.webp`,
      `${originalBaseKey}original.tiff`,
      `${originalBaseKey}original.pdf`,
    ];

    let foundSourceKey = null;
    let originalContentType = null;
    for (const key of possibleSourceKeys) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: SOURCE_BUCKET, Key: key }));
        foundSourceKey = key;
        originalContentType = head.ContentType;
        break;
      } catch {}
    }
    if (!foundSourceKey) {
      return json(404, { error: "Original not found", message: "Original file not found in source bucket.", id, searchedKeys: possibleSourceKeys }, origin);
    }

    const targetBaseKey = newBaseKey || originalBaseKey;
    const targetBucket = newTargetBucket || originalBucket;
    let reprocessSourceKey = foundSourceKey;

    if (newBaseKey && newBaseKey !== originalBaseKey) {
      const newSourceKey = `${targetBaseKey}original${foundSourceKey.substring(foundSourceKey.lastIndexOf('.'))}`;
      await s3.send(new CopyObjectCommand({
        Bucket: SOURCE_BUCKET,
        CopySource: encodeURIComponent(`${SOURCE_BUCKET}/${foundSourceKey}`),
        Key: newSourceKey,
        Metadata: {
          id,
          basekey: targetBaseKey,
          targetbucket: targetBucket,
          reprocessed: "true",
          originalid: id,
        },
        MetadataDirective: "REPLACE",
      }));
      reprocessSourceKey = newSourceKey;
    }

    const message = {
      Records: [{
        s3: { bucket: { name: SOURCE_BUCKET }, object: { key: reprocessSourceKey } },
      }],
      reprocessing: { originalId: id, customSizes: customSizes || null, formats: formats || null },
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) }));

    return json(200, {
      success: true, id,
      message: "Image queued for reprocessing",
      source: { bucket: SOURCE_BUCKET, key: reprocessSourceKey },
      target: { bucket: targetBucket, baseKey: targetBaseKey },
      customOptions: { sizes: customSizes || "default", formats: formats || "default" },
    }, origin);

  } catch (err) {
    console.error("reprocessImage error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};
