// src/createUpload.js
// POST /upload — returns presigned URL(s)  (export: handler)
// POST /upload/bytes — writes raw body to SOURCE bucket  (export: bytes)

import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildPlan, metadataForPut, expectedUrls, MIME } from "./lib/plan.js";
import { generateId } from "./id.js";

const s3 = new S3Client({});
const SOURCE_BUCKET = process.env.SOURCE_BUCKET; // required
const DEFAULT_TARGET_BUCKET = process.env.DEFAULT_TARGET_BUCKET || "images.juniorbay.net";
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || "photos";
const CDN_BASE = (process.env.CDN_BASE || "").replace(/\/$/, "");

// sizing/presign knobs
const PART_SIZE = Number(process.env.PART_SIZE || 10 * 1024 * 1024);
const SINGLE_PUT_MAX = Number(process.env.SINGLE_PUT_MAX || 9 * 1024 * 1024);

const json = (code, obj) => ({
  statusCode: code,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});
const trim = (s) => String(s || "").replace(/^\/+/, "").replace(/\/+$/, "");
const publicBase = (evt) => {
  const host = evt?.headers?.["x-forwarded-host"] || evt?.headers?.host || "";
  const proto = (evt?.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const stage = evt?.requestContext?.stage ? `/${evt.requestContext.stage}` : "";
  return `${proto}://${host}${stage}`;
};
const mimeFor = (ext, fallback) => MIME[String(ext || "").toLowerCase()] || fallback || "application/octet-stream";

/** --------- 1) PRESIGNED FLOW (POST /upload)  --------- */
export const handler = async (event) => {
  try {
    if (!SOURCE_BUCKET) return json(500, { error: "SOURCE_BUCKET not configured" });

    const body = event?.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body || "", "base64").toString("utf8") || "{}")
      : JSON.parse(event?.body || "{}");

    const {
      mediaType = "photo",
      fileName = "upload.bin",
      mime = "application/octet-stream",
      sizeBytes = 0,
      targetBucket = DEFAULT_TARGET_BUCKET,
      basePrefix,
      forceFormat = "",
      ownerUserId = null,
      useCase = "general",
    } = body || {};

    const id = generateId();
    const plan = buildPlan({
      id,
      mediaType,
      basePrefix: basePrefix ?? DEFAULT_BASE_PREFIX,
      filename: fileName,
      mime,
      forceFormat,
      // layout: use DEFAULT_LAYOUT env in plan.js
    });

    const Metadata = metadataForPut(plan, {
      targetBucket,
      ownerUserId: ownerUserId || "USER#anonymous",
      useCase,
    });

    // single PUT vs multipart
    if (sizeBytes > 0 && sizeBytes <= SINGLE_PUT_MAX) {
      const putCmd = new PutObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: plan.sourceKey,
        ContentType: mimeFor(plan.originalExt, mime),
        Metadata,
      });
      const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: 900 });
      return json(200, {
        id,
        mediaType,
        targetBucket,
        baseKey: plan.baseKey,
        source: { bucket: SOURCE_BUCKET, key: plan.sourceKey },
        upload: { mode: "single", putUrl, contentType: mimeFor(plan.originalExt, mime) },
        expectedUrls: CDN_BASE
          ? expectedUrls({
              cdnBase: CDN_BASE,
              baseKey: plan.baseKey,
              primaryExt: plan.primaryExt,
              originalExt: plan.originalExt,
            })
          : undefined,
      });
    }

    // multipart presigned
    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: SOURCE_BUCKET,
        Key: plan.sourceKey,
        ContentType: mimeFor(plan.originalExt, mime),
        Metadata,
      })
    );
    const uploadId = create.UploadId;
    const parts = sizeBytes > 0 ? Math.ceil(sizeBytes / PART_SIZE) : 3;
    const partUrls = [];
    for (let partNumber = 1; partNumber <= parts; partNumber++) {
      const up = new UploadPartCommand({
        Bucket: SOURCE_BUCKET,
        Key: plan.sourceKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(s3, up, { expiresIn: 900 });
      partUrls.push({ partNumber, url });
    }

    return json(200, {
      id,
      mediaType,
      targetBucket,
      baseKey: plan.baseKey,
      source: { bucket: SOURCE_BUCKET, key: plan.sourceKey },
      upload: {
        mode: "multipart",
        uploadId,
        partSize: PART_SIZE,
        partUrls,
        completeUrl: `${publicBase(event)}/v3/upload/complete`,
      },
      expectedUrls: CDN_BASE
        ? expectedUrls({
            cdnBase: CDN_BASE,
            baseKey: plan.baseKey,
            primaryExt: plan.primaryExt,
            originalExt: plan.originalExt,
          })
        : undefined,
    });
  } catch (err) {
    console.error("createUpload.handler error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) });
  }
};

/** --------- 2) BYTES FLOW (POST /upload/bytes)  --------- */
export const bytes = async (event) => {
  try {
    if (!SOURCE_BUCKET) return json(500, { error: "SOURCE_BUCKET not configured" });

    const ct =
      event?.headers?.["content-type"] ||
      event?.headers?.["Content-Type"] ||
      "application/octet-stream";

    // query params for small hints
    const qs = event?.queryStringParameters || {};
    const mediaType = (qs.mediaType || "photo").toLowerCase();
    const fileName = qs.fileName || "upload.bin";
    const forceFormat = (qs.forceFormat || "").toLowerCase();
    const useCase = qs.useCase || "bytes";
    const targetBucket = DEFAULT_TARGET_BUCKET;

    // decode body
    const bodyBuf = Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8");

    const id = generateId();
    const plan = buildPlan({
      id,
      mediaType,
      basePrefix: DEFAULT_BASE_PREFIX,
      filename: fileName,
      mime: ct,
      forceFormat,
    });

    const md = metadataForPut(plan, {
      targetBucket,
      useCase,
    });

    await s3.send(
      new PutObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: plan.sourceKey,
        Body: bodyBuf,
        ContentType: ct || MIME[plan.originalExt] || "application/octet-stream",
        Metadata: md,
      })
    );

    return json(200, {
      id,
      mediaType,
      targetBucket,
      baseKey: plan.baseKey,
      source: { bucket: SOURCE_BUCKET, key: plan.sourceKey },
      expectedUrls: CDN_BASE
        ? expectedUrls({
            cdnBase: CDN_BASE,
            baseKey: plan.baseKey,
            primaryExt: plan.primaryExt,
            originalExt: plan.originalExt,
          })
        : undefined,
    });
  } catch (err) {
    console.error("createUpload.bytes error:", err);
    return json(500, { error: "internal_error", message: String(err?.message || err) });
  }
};
