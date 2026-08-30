// src/deleteImage.js
// DELETE /delete/{id} - Delete all processed images and optionally the original

import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const METADATA_TABLE = process.env.PHOTOS_TABLE || process.env.IMAGE_METADATA_TABLE_NAME || "";
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const TARGET_BUCKET_DEFAULT = process.env.TARGET_BUCKET_DEFAULT || "images.juniorbay.net";

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

  // Handle preflight
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
    if (!METADATA_TABLE) {
      return json(500, { error: "METADATA_TABLE not configured" }, origin);
    }

    // Extract ID from path: /delete/{id}
    const id = event?.pathParameters?.id || "";
    if (!id) {
      return json(400, { error: "Missing id parameter" }, origin);
    }

    // Optional: deleteOriginal flag from query params
    const deleteOriginal = event?.queryStringParameters?.deleteOriginal === "true";

    // 1. Fetch record from DynamoDB
    const getResult = await ddb.send(
      new GetItemCommand({
        TableName: METADATA_TABLE,
        Key: {
          PK: { S: id },
          SK: { S: "v#0" },
        },
      })
    );

    if (!getResult.Item) {
      return json(404, { 
        error: "Image not found", 
        id,
        message: "No record exists for this ID"
      }, origin);
    }

    const item = unmarshall(getResult.Item);
    const baseKey = item.baseKey || "";
    const bucket = item.bucket || TARGET_BUCKET_DEFAULT;

    if (!baseKey) {
      return json(400, { 
        error: "Invalid record", 
        message: "Record has no baseKey"
      }, origin);
    }

    console.log(`Deleting image ${id} from s3://${bucket}/${baseKey}`);

    // 2. List all objects under baseKey in target bucket
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: baseKey,
      })
    );

    const objectsToDelete = listResult.Contents || [];
    
    if (objectsToDelete.length === 0) {
      console.warn(`No objects found in s3://${bucket}/${baseKey}`);
    } else {
      // 3. Delete all processed images (variants + original in target bucket)
      const deleteParams = {
        Bucket: bucket,
        Delete: {
          Objects: objectsToDelete.map(obj => ({ Key: obj.Key })),
          Quiet: true,
        },
      };

      const deleteResult = await s3.send(new DeleteObjectsCommand(deleteParams));
      
      if (deleteResult.Errors && deleteResult.Errors.length > 0) {
        console.error("Some objects failed to delete:", deleteResult.Errors);
      }

      console.log(`Deleted ${objectsToDelete.length} objects from target bucket`);
    }

    // 4. Optionally delete original from source bucket
    let sourceDeleted = false;
    if (deleteOriginal && SOURCE_BUCKET) {
      try {
        const sourceListResult = await s3.send(
          new ListObjectsV2Command({
            Bucket: SOURCE_BUCKET,
            Prefix: baseKey,
          })
        );

        const sourceObjects = sourceListResult.Contents || [];
        
        if (sourceObjects.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: SOURCE_BUCKET,
              Delete: {
                Objects: sourceObjects.map(obj => ({ Key: obj.Key })),
                Quiet: true,
              },
            })
          );
          sourceDeleted = true;
          console.log(`Deleted ${sourceObjects.length} objects from source bucket`);
        }
      } catch (err) {
        console.error("Failed to delete from source bucket:", err);
        // Continue anyway - don't fail the whole operation
      }
    }

    // 5. Delete DynamoDB record
    await ddb.send(
      new DeleteItemCommand({
        TableName: METADATA_TABLE,
        Key: {
          PK: { S: id },
          SK: { S: "v#0" },
        },
      })
    );

    console.log(`Deleted DynamoDB record for ${id}`);

    return json(200, {
      success: true,
      id,
      baseKey,
      bucket,
      deletedCount: objectsToDelete.length,
      sourceDeleted,
      message: `Successfully deleted image ${id}${sourceDeleted ? " (including original)" : ""}`
    }, origin);

  } catch (err) {
    console.error("deleteImage error:", err);
    return json(500, { 
      error: "internal_error", 
      message: String(err?.message || err) 
    }, origin);
  }
};