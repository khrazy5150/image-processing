// Pure crop geometry. Deliberately free of sharp and the AWS SDK so it can be tested on any machine --
// sharp ships as a platform-specific binary built for the Lambda runtime and will not load on a dev laptop.

export const FITS = new Set(["cover", "contain", "fill", "inside", "outside"]);

/**
 * A crop arrives as NORMALIZED fractions of the source: "x,y,w,h" in 0..1.
 *
 * Pixels would be bound to one rendition -- the processor emits thumb/small/medium/large/full and the
 * resize endpoint mints more -- so a pixel rect is correct against exactly one of them and silently wrong
 * against the rest. Fractions survive every rendition, and survive the source being reprocessed.
 *
 * Returns {x,y,w,h}, or {error} for a bad input, or null when no crop was asked for.
 */
export function parseCrop(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const parts = String(raw).split(",").map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return { error: "Crop must be x,y,w,h" };
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) return { error: "Crop width and height must be greater than zero" };
  // A hair over 1 is rounding in the browser, not a bad request.
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return { error: "Crop must lie within 0..1" };
  return { x, y, w, h };
}

/**
 * Source dimensions AFTER EXIF auto-orientation.
 *
 * Orientations 5-8 swap the axes, and sharp's .rotate() applies that before we extract. The rect was
 * measured by a browser against the DISPLAYED image, which is the rotated one, so the dimensions we scale
 * it against must be post-rotation too. Get this wrong and every portrait phone photo crops the wrong
 * region -- while every landscape test image passes.
 */
export function orientedSize(metadata) {
  const swapped = Number(metadata?.orientation || 0) >= 5;
  return {
    width: swapped ? metadata?.height : metadata?.width,
    height: swapped ? metadata?.width : metadata?.height,
  };
}

/**
 * Normalized rect -> integer pixel rect, clamped inside the image.
 *
 * sharp.extract() THROWS on an out-of-bounds rect rather than clamping, and browser rounding will
 * eventually produce one a pixel over the edge. Clamping is the difference between a correct image and a
 * 500 on a request that was essentially right.
 */
export function cropToPixels(crop, source) {
  const maxLeft = Math.max(source.width - 1, 0);
  const maxTop = Math.max(source.height - 1, 0);
  const left = Math.min(Math.max(Math.round(crop.x * source.width), 0), maxLeft);
  const top = Math.min(Math.max(Math.round(crop.y * source.height), 0), maxTop);
  const width = Math.max(1, Math.min(Math.round(crop.w * source.width), source.width - left));
  const height = Math.max(1, Math.min(Math.round(crop.h * source.height), source.height - top));
  return { left, top, width, height };
}

/**
 * A cache-key fragment naming the WHOLE transform.
 *
 * The key used to carry only the output dimensions, so two different crops -- or two different fits -- at
 * one output size wrote to the same object, and `max-age=31536000, immutable` then kept whichever landed
 * last correct for a year. Silent, durable, and invisible in testing.
 */
export function transformSuffix(fit, cropPixels, createHash) {
  const canonical = JSON.stringify({ fit, crop: cropPixels || null });
  return createHash("sha1").update(canonical).digest("hex").slice(0, 10);
}
