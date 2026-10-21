// src/deleteImage.js
import { DynamoDBClient, QueryCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";
// WITHOUT THIS, DELETING AN IMAGE DOES NOT TAKE IT DOWN. Variants are served with
// `cache-control: public, max-age=31536000, immutable`, which is correct for content-addressed URLs
// and means an edge keeps serving a deleted object for up to a YEAR. Worse, the only objects that are
// cached are the ones somebody actually loaded -- so deletion appeared to work for every image nobody
// had looked at, and silently failed for every image that was live on a page. Measured 2026-10-20:
// origin 403, edge 200 from cache, age 47s, on an object deleted a minute earlier.
const CDN_DISTRIBUTION_ID = process.env.CDN_DISTRIBUTION_ID || "";

const json = (code, obj, origin = "*") => ({
  statusCode: code,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "OPTIONS,DELETE",
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
    else if (value.BOOL !== undefined) obj[key] = value.BOOL;
    else if (value.NULL !== undefined) obj[key] = null;
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
        "access-control-allow-methods": "OPTIONS,DELETE",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-max-age": "86400",
      },
      body: "",
    };
  }

  try {
    if (!METADATA_TABLE) return json(500, { error: "METADATA_TABLE not configured" }, origin);

    const id = event?.pathParameters?.id || "";
    if (!id) return json(400, { error: "Missing id parameter" }, origin);

    const deleteOriginal = event?.queryStringParameters?.deleteOriginal === "true";

    // 🔸 Query all versions so we can delete them; latest row provides baseKey/bucket
    const q = await ddb.send(new QueryCommand({
      TableName: METADATA_TABLE,
      KeyConditionExpression: "PK = :id",
      ExpressionAttributeValues: { ":id": { S: id } },
      ScanIndexForward: false, // latest first
    }));

    if (!q.Items || q.Items.length === 0) {
      return json(404, { error: "Image not found", id, message: "No record exists for this ID" }, origin);
    }

    const latest = unmarshall(q.Items[0]);
    const baseKey = latest.baseKey || "";
    const bucket = latest.bucket || TARGET_BUCKET_DEFAULT;

    if (!baseKey) {
      return json(400, { error: "Invalid record", message: "Record has no baseKey" }, origin);
    }

    // 1) delete all objects in target bucket under baseKey
    const listResult = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: baseKey }));
    const objectsToDelete = listResult.Contents || [];
    if (objectsToDelete.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objectsToDelete.map(o => ({ Key: o.Key })), Quiet: true },
      }));
    }

    // 2) optionally delete originals from source
    let sourceDeleted = false;
    if (deleteOriginal && SOURCE_BUCKET) {
      try {
        const srcList = await s3.send(new ListObjectsV2Command({ Bucket: SOURCE_BUCKET, Prefix: baseKey }));
        const srcObjs = srcList.Contents || [];
        if (srcObjs.length > 0) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: SOURCE_BUCKET,
            Delete: { Objects: srcObjs.map(o => ({ Key: o.Key })), Quiet: true },
          }));
          sourceDeleted = true;
        }
      } catch (e) {
        console.error("Failed to delete from source bucket:", e);
      }
    }

    // 3) delete ALL versions in DDB
    for (const it of q.Items) {
      const PK = id;
      const SK = it.SK.N ? Number(it.SK.N) : it.SK.S; // tolerate old shapes
      await ddb.send(new DeleteItemCommand({
        TableName: METADATA_TABLE,
        Key: {
          PK: { S: PK },
          SK: typeof SK === "number" ? { N: String(SK) } : { S: String(SK) },
        },
      }));
    }

    // 4) drop it from the CDN. The bytes are already gone; this is what makes it UNREACHABLE.
    //    Failure here does not fail the delete -- the objects really are deleted and the caller must
    //    not be told otherwise -- but it is REPORTED rather than swallowed, because the difference
    //    between "deleted" and "deleted and no longer being served" is the entire point of a takedown.
    let cdnInvalidated = false;
    let cdnError = "";
    if (CDN_DISTRIBUTION_ID) {
      try {
        await cloudfront.send(new CreateInvalidationCommand({
          DistributionId: CDN_DISTRIBUTION_ID,
          InvalidationBatch: {
            // One wildcard covers every variant and format of this image: thumb/small/medium/large/
            // full across avif/webp/jpg plus the original. Listing them individually would be a dozen
            // paths against the 1000-a-month free allowance, and would miss any variant added later.
            Paths: { Quantity: 1, Items: [`/${baseKey}*`] },
            CallerReference: `delete-${id}-${Date.now()}`,
          },
        }));
        cdnInvalidated = true;
      } catch (e) {
        console.error("CDN invalidation failed; image is deleted but may still be served:", e);
        cdnError = String(e?.message || e);
      }
    } else {
      cdnError = "CDN_DISTRIBUTION_ID is not configured";
    }

    return json(200, {
      success: true,
      id, baseKey, bucket,
      deletedCount: objectsToDelete.length,
      sourceDeleted,
      cdnInvalidated,
      ...(cdnError ? { cdnError } : {}),
      message: `Deleted image ${id}${sourceDeleted ? " (including original)" : ""}`
        + (cdnInvalidated ? "" : " — NOT yet purged from the CDN"),
    }, origin);

  } catch (err) {
    console.error("deleteImage error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) }, origin);
  }
};
