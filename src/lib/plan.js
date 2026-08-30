// src/lib/plan.js
// Single source of truth for where files live & what they're called.

const DEFAULTS = {
  // Map mediaType -> basePrefix; override with PLAN_PREFIX_MAP_JSON if you like.
  prefixMap: JSON.parse(process.env.PLAN_PREFIX_MAP_JSON || '{}'),
  layout: (process.env.DEFAULT_LAYOUT || 'flat').toLowerCase(), // 'flat' or 'dated'
  photoPrimary: (process.env.PRIMARY_EXT || 'jpg').toLowerCase(),
  videoPrimary: (process.env.PRIMARY_VIDEO_EXT || 'mp4').toLowerCase()
};

export const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif',
  png: 'image/png', tiff: 'image/tiff', tif: 'image/tiff',
  pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime'
};

const PRESERVE_FOR = new Set(['png', 'pdf', 'tif', 'tiff']); // originals we don't re-encode (images)

const trim = (s) => String(s || '').replace(/^\/+/, '').replace(/\/+$/, '');
const yyyyMM = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const normExt = (e) => String(e || '').toLowerCase().replace('jpeg', 'jpg');

function pickPrefix(mediaType, basePrefixOverride) {
  if (basePrefixOverride) return trim(basePrefixOverride);
  const map = { photo: 'photos', video: 'videos', ...DEFAULTS.prefixMap };
  return trim(map[String(mediaType || 'photo').toLowerCase()] || 'uploads');
}

function pickPrimaryExt(mediaType, forceFormat) {
  if (forceFormat) return normExt(forceFormat);
  return mediaType === 'video' ? DEFAULTS.videoPrimary : DEFAULTS.photoPrimary;
}

function extFromFilenameOrMime(filename, mime) {
  const nameExt = normExt((filename || '').split('.').pop() || '');
  if (nameExt) return nameExt;
  const guess = (mime || '').toLowerCase();
  if (/jpe?g/.test(guess)) return 'jpg';
  if (/png/.test(guess)) return 'png';
  if (/tiff?/.test(guess)) return 'tiff';
  if (/pdf/.test(guess)) return 'pdf';
  if (/mp4/.test(guess)) return 'mp4';
  if (/quicktime|mov/.test(guess)) return 'mov';
  return 'bin';
}

/**
 * Build a storage plan for a new upload.
 * @returns { id, mediaType, basePrefix, baseKey, primaryExt, originalExt, sourceKey }
 */
export function buildPlan({
  id,
  mediaType = 'photo',
  basePrefix,          // optional override; otherwise derived from mediaType
  createdAt = Date.now(),
  filename = 'upload.bin',
  mime = 'application/octet-stream',
  forceFormat = '',    // force primary ext (e.g., 'jpg', 'webp', 'avif', 'mp4')
  layout = DEFAULTS.layout   // 'flat' | 'dated'
}) {
  const prefix = pickPrefix(mediaType, basePrefix);
  const primaryExt = pickPrimaryExt(mediaType, forceFormat);
  const srcExt = extFromFilenameOrMime(filename, mime);
  const originalExt = PRESERVE_FOR.has(srcExt) ? srcExt : primaryExt;

  const baseKey = layout === 'dated'
    ? `${prefix}/${yyyyMM(createdAt)}/${id}/`
    : `${prefix}/${id}/`;

  const sourceKey = `${baseKey}original.${originalExt}`;

  return { id, mediaType, basePrefix: prefix, baseKey, primaryExt, originalExt, sourceKey };
}

/**
 * Make S3 user-metadata to stamp onto the original object (so the processor can trust it).
 * Always lower-case keys—they come back lower-cased from HeadObject.
 */
export function metadataForPut(plan, extras = {}) {
  const md = {
    id: plan.id,
    basekey: plan.baseKey,
    baseprefix: plan.basePrefix,
    primaryext: plan.primaryExt
  };
  for (const [k, v] of Object.entries(extras)) {
    if (v == null) continue;
    md[String(k).toLowerCase()] = String(v);
  }
  return md;
}

/**
 * Reconstruct a plan from object metadata (preferred) or from the S3 key shape.
 * Pass the srcKey (s3://bucket/<srcKey>) so we can fallback if metadata is missing.
 */
export function planFromHead({ head, srcKey, defaults = {} }) {
  const meta = Object.fromEntries(
    Object.entries(head?.Metadata || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
  );
  const id = meta.id || (srcKey?.split('/').slice(-2, -1)[0]) || '';
  const baseKey = meta.basekey || (srcKey ? srcKey.replace(/[^/]+$/, '') : '');
  const primaryExt = normExt(meta.primaryext || defaults.primaryExt || DEFAULTS.photoPrimary);
  const basePrefix = trim(meta.baseprefix || defaults.basePrefix || 'photos');
  return { id, baseKey, primaryExt, basePrefix };
}

/**
 * Build public URLs (for photos; videos may differ downstream).
 */
export function expectedUrls({ cdnBase, baseKey, primaryExt, originalExt }) {
  const root = String(cdnBase || '').replace(/\/$/, '');
  return {
    original: `${root}/${baseKey}original.${originalExt || primaryExt}`,
    full:     `${root}/${baseKey}full.${primaryExt}`,
    large:    `${root}/${baseKey}large.${primaryExt}`,
    medium:   `${root}/${baseKey}medium.${primaryExt}`,
    small:    `${root}/${baseKey}small.${primaryExt}`,
    thumb:    `${root}/${baseKey}thumb.${primaryExt}`
  };
}
