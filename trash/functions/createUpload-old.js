import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { generateId } from './id.js';

const s3 = new S3Client({});

const SOURCE_BUCKET = process.env.SOURCE_BUCKET;
const DEFAULT_TARGET_BUCKET = process.env.DEFAULT_TARGET_BUCKET || 'images.juniorbay.net';
const DEFAULT_BASE_PREFIX = process.env.DEFAULT_BASE_PREFIX || 'photos';
const PART_SIZE = Number(process.env.PART_SIZE || 10 * 1024 * 1024);
const SINGLE_PUT_MAX = Number(process.env.SINGLE_PUT_MAX || 9 * 1024 * 1024);

// One-step inline upload limits (keep small to avoid API GW/Lambda payload limits)
const INLINE_UPLOAD_MAX = Number(process.env.INLINE_UPLOAD_MAX || 6 * 1024 * 1024); // ~6MB
const CDN_BASE = (process.env.CDN_BASE || '').replace(/\/$/, ''); // optional convenience in response

// ---- Two-phase: init (presigned single or multipart) ---------------------------------------
export const handler = async (event) => {
  const body = event?.isBase64Encoded
    ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8'))
    : JSON.parse(event.body || '{}');

  const {
    mediaType = 'photo',
    fileName = 'upload.bin',
    mime = 'application/octet-stream',
    sizeBytes = 0,
    useCase = 'general',
    ownerUserId = null,
    targetBucket = DEFAULT_TARGET_BUCKET,
    basePrefix = DEFAULT_BASE_PREFIX,
    forceFormat = ''
  } = body;

  if (!SOURCE_BUCKET) return json(500, { error: 'SOURCE_BUCKET not configured' });

  const id = generateId();
  const createdAt = Date.now();
  const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
  const yyyy = new Date(createdAt).getUTCFullYear();
  const mm = String(new Date(createdAt).getUTCMonth() + 1).padStart(2, '0');
  const baseKey = `${trim(basePrefix)}/${yyyy}/${mm}/${id}/`;
  const key = `${baseKey}original.${ext}`;

  const Metadata = {
    id,
    useCase,
    ownerUserId: ownerUserId || 'USER#anonymous',
    targetBucket,
    basePrefix,
    forceFormat
  };

  // Small: single PUT
  if (sizeBytes && sizeBytes <= SINGLE_PUT_MAX) {
    const putCmd = new PutObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: key,
      ContentType: mime,
      Metadata
    });
    const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: 900 });
    return json(200, {
      id,
      mediaType,
      targetBucket,
      baseKey,
      upload: { mode: 'single', putUrl, contentType: mime }
    });
  }

  // Larger: multipart
  const create = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: SOURCE_BUCKET,
      Key: key,
      ContentType: mime,
      Metadata
    })
  );
  const uploadId = create.UploadId;
  const numParts = sizeBytes ? Math.ceil(sizeBytes / PART_SIZE) : 0;
  const partUrls = [];
  const pregen = Math.min(numParts || 0, 30);
  for (let partNumber = 1; partNumber <= pregen; partNumber++) {
    const upCmd = new UploadPartCommand({
      Bucket: SOURCE_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber
    });
    const url = await getSignedUrl(s3, upCmd, { expiresIn: 900 });
    partUrls.push({ partNumber, url });
  }
  const abortCmd = new AbortMultipartUploadCommand({
    Bucket: SOURCE_BUCKET,
    Key: key,
    UploadId: uploadId
  });
  const abortUrl = await getSignedUrl(s3, abortCmd, { expiresIn: 900 });

  return json(200, {
    id,
    mediaType,
    targetBucket,
    baseKey,
    upload: {
      mode: 'multipart',
      uploadId,
      partSize: PART_SIZE,
      partUrls,
      abortUrl,
      completeUrl: `${publicBase(event)}/v3/upload/complete`
    }
  });
};

// ---- Two-phase: complete multipart ----------------------------------------------------------
export const complete = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const { key, uploadId, parts } = body; // parts = [{ PartNumber, ETag }]
  if (!key || !uploadId || !Array.isArray(parts) || !parts.length) {
    return json(400, { error: 'key, uploadId, parts required' });
  }
  const cmd = new CompleteMultipartUploadCommand({
    Bucket: SOURCE_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts }
  });
  const res = await s3.send(cmd);
  return json(200, { ok: true, location: res.Location, etag: res.ETag });
};

// ---- One-step: inline bytes upload (small files only) ---------------------------------------
export const bytes = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const headers = event.headers || {};
    const headerCT =
      headers['content-type'] ||
      headers['Content-Type'] ||
      headers['CONTENT-TYPE'] ||
      'application/octet-stream';

    const {
      mediaType = 'photo',
      fileName = 'upload.bin',
      mime = headerCT,
      useCase = 'general',
      ownerUserId = 'USER#anonymous',
      targetBucket = DEFAULT_TARGET_BUCKET,
      basePrefix = DEFAULT_BASE_PREFIX,
      forceFormat = ''
    } = qs;

    if (!SOURCE_BUCKET) return json(500, { error: 'SOURCE_BUCKET not configured' });
    if (!event.body) return json(400, { error: 'empty body' });

    const bodyBuf = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'binary');

    if (bodyBuf.length > INLINE_UPLOAD_MAX) {
      return json(413, {
        error: `file too large for inline upload (>${INLINE_UPLOAD_MAX} bytes). Use /v3/upload for presigned/multipart.`
      });
    }

    const id = generateId();
    const createdAt = Date.now();
    const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
    const yyyy = new Date(createdAt).getUTCFullYear();
    const mm = String(new Date(createdAt).getUTCMonth() + 1).padStart(2, '0');
    //const baseKey = `${trim(basePrefix)}/${yyyy}/${mm}/${id}/`;
    const baseKey = `${trim(basePrefix)}/${id}/`;
    const key = `${baseKey}original.${ext}`;

    const Metadata = {
      id,
      useCase,
      ownerUserId,
      targetBucket,
      basePrefix,
      forceFormat
    };

    // Put directly to SOURCE bucket. Processor picks it up via S3->SQS.
    await s3.send(
      new PutObjectCommand({
        Bucket: SOURCE_BUCKET,
        Key: key,
        Body: bodyBuf,
        ContentType: mime,
        Metadata
      })
    );

    // Convenience: expected public URLs after processing
    const primaryExt = (forceFormat || 'jpg').replace('jpeg', 'jpg');
    const expected = CDN_BASE
      ? {
          original: `${CDN_BASE}/${baseKey}original.${ext}`,
          full: `${CDN_BASE}/${baseKey}full.${primaryExt}`,
          large: `${CDN_BASE}/${baseKey}large.${primaryExt}`,
          medium: `${CDN_BASE}/${baseKey}medium.${primaryExt}`,
          small: `${CDN_BASE}/${baseKey}small.${primaryExt}`,
          thumb: `${CDN_BASE}/${baseKey}thumb.${primaryExt}`
        }
      : undefined;

    return json(200, {
      id,
      mediaType,
      baseKey,
      targetBucket,
      source: { bucket: SOURCE_BUCKET, key },
      expectedUrls: expected
    });
  } catch (e) {
    return json(400, { error: e.message });
  }
};

// ---- helpers --------------------------------------------------------------------------------
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj)
});
const trim = (s) => String(s).replace(/^\/+/, '').replace(/\/+$/, '');
function publicBase(event) {
  const proto = (event.headers?.['x-forwarded-proto'] || 'https').toLowerCase();
  const host = event.headers?.host || '';
  const stage = event.requestContext?.stage ? `/${event.requestContext.stage}` : '';
  return `${proto}://${host}${stage}`;
}
