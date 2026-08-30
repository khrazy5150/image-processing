// src/getStatus.js
// GET /upload/status/{id} - Check processing status and get URLs

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");

const json = (code, obj, origin = "*") => ({
  statusCode: code,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "OPTIONS,GET",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  },
  body: JSON.stringify(obj),
});

function allowedOrigin(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  if (!origin || allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : "*";
}

function unmarshall(item) {
  if (!item) return null;
  const obj = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) obj[key] = value.S;
    else if (value.N !== undefined) obj[key] = Number(value.N);
    else if (value.BOOL !== undefined) obj[key] = value.BOOL;
    else if (value.NULL !== undefined) obj[key] = null;
    else obj[key] = value;
  }
  return obj;
}

export const handler = async (event) => {
  const origin = allowedOrigin(event);

  // Handle preflight
  if ((event?.httpMethod || event?.requestContext?.http?.method) === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "OPTIONS,GET",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  try {
    if (!METADATA_TABLE) {
      return json(500, { error: "METADATA_TABLE not configured" }, origin);
    }

    // Extract ID from path: /upload/status/{id}
    const id = event?.pathParameters?.id || "";
    if (!id) {
      return json(400, { error: "Missing id parameter" }, origin);
    }

    // Scan DynamoDB for this ID (inefficient but works for low volume)
    // For production, you'd want a GSI on the id attribute
    const scanResult = await ddb.send(
      new ScanCommand({
        TableName: METADATA_TABLE,
        FilterExpression: "id = :id",
        ExpressionAttributeValues: {
          ":id": { S: id },
        },
        Limit: 1,
      })
    );

    let item = null;
    if (scanResult.Items && scanResult.Items.length > 0) {
      item = unmarshall(scanResult.Items[0]);
    }

    // If found in DDB, return the data
    if (item) {
      let variants = [];
      let urls = {};
      try {
        if (item.variants) variants = JSON.parse(item.variants);
        if (item.urls) urls = JSON.parse(item.urls);
      } catch (err) {
        console.error("Failed to parse JSON fields:", err);
      }

      const response = {
        id: item.id || id,
        status: item.status || "complete",
        bucket: item.bucket,
        baseKey: item.baseKey,
        contentType: item.contentType,
        urls,
        variants: variants.map(v => ({
          name: v.name,
          format: v.format,
          url: v.url,
          width: v.width,
          height: v.height,
          bytes: v.bytes,
          upscaled: v.upscaled || false,
        })),
        source: item.sourceWidth && item.sourceHeight ? {
          width: item.sourceWidth,
          height: item.sourceHeight,
          format: item.sourceFormat,
        } : undefined,
        updatedAt: item.updatedAt,
        error: item.error,
      };

      return json(200, response, origin);
    }

    // Not in DDB yet - check if source files exist (still processing)
    const bucket = TARGET_BUCKET_DEFAULT;
    const possiblePaths = [
      `photos/${id}/small.jpg`,
      `photos/${id}/thumb.jpg`,
      `uploads/web/${id}/small.jpg`,
      `uploads/web/${id}/thumb.jpg`,
    ];

    for (const key of possiblePaths) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        // Found a processed file, but not in DDB yet
        // This means processing completed but DDB write might have failed
        // Build URLs from what we know
        const baseKey = key.substring(0, key.lastIndexOf('/') + 1);
        const urls = buildUrlsFromBaseKey(baseKey);
        
        return json(200, {
          id,
          status: "complete",
          bucket,
          baseKey,
          urls,
          message: "Processing complete (metadata sync pending)"
        }, origin);
      } catch (err) {
        // File doesn't exist, continue
      }
    }

    // Check source bucket for recently uploaded file
    const sourcePaths = [
      `photos/${id}/original.jpg`,
      `photos/${id}/original.png`,
      `photos/${id}/original.tiff`,
      `uploads/web/${id}/original.jpg`,
    ];

    for (const key of sourcePaths) {
      try {
        await s3.send(new HeadObjectCommand({ 
          Bucket: process.env.SOURCE_BUCKET || bucket, 
          Key: key 
        }));
        // Source exists but no processed files yet
        return json(200, {
          id,
          status: "processing",
          message: "Image is being processed",
        }, origin);
      } catch (err) {
        // Continue
      }
    }

    return json(404, { 
      error: "Image not found", 
      id,
      message: "No record found in database or storage"
    }, origin);

  } catch (err) {
    console.error("getStatus error:", err);
    return json(500, { 
      error: "internal_error", 
      message: String(err?.message || err) 
    }, origin);
  }
};

function buildUrlsFromBaseKey(baseKey) {
  const variants = ['thumb', 'small', 'medium', 'large', 'full'];
  const formats = ['avif', 'webp', 'jpg'];
  const urls = {};
  
  variants.forEach(variant => {
    urls[variant] = {};
    formats.forEach(format => {
      urls[variant][format] = `${CDN_BASE}/${baseKey}${variant}.${format}`;
    });
  });
  
  // Add original
  urls.original = `${CDN_BASE}/${baseKey}original.jpg`;
  
  return urls;
}