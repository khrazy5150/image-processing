// The crop geometry behind GET /resize?crop=x,y,w,h.
//
// sharp itself is a platform-specific binary built for the Lambda runtime and will not load on a dev
// machine, which is exactly why the geometry lives in a pure module. What cannot be executed here -- the
// ORDER of .rotate() and .extract() -- is asserted against the handler source instead, because reordering
// them produces a bug that passes every landscape test image and corrupts every portrait phone photo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FITS, parseCrop, orientedSize, cropToPixels, transformSuffix } from "../src/lib/crop.js";

test("no crop parameter means no crop, not an error", () => {
  for (const raw of [undefined, null, ""]) assert.equal(parseCrop(raw), null);
});

test("a well formed crop parses", () => {
  assert.deepEqual(parseCrop("0.1,0.2,0.5,0.4"), { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
});

test("malformed crops are refused rather than guessed at", () => {
  for (const raw of ["0.1,0.2,0.5", "a,b,c,d", "0.1,0.2,0.5,0.4,0.9", "0.1,0.2,0,0.4"]) {
    assert.ok(parseCrop(raw)?.error, `expected an error for ${raw}`);
  }
});

test("a crop outside the image is refused", () => {
  assert.ok(parseCrop("-0.1,0,0.5,0.5")?.error);
  assert.ok(parseCrop("0.8,0,0.5,0.5")?.error);
});

test("browser rounding a hair over 1 is tolerated, not rejected", () => {
  // A UI computing 0.00005 + 0.99999 is right; refusing it would be a bug report nobody could reproduce.
  assert.equal(parseCrop("0,0,1.00005,1")?.error, undefined);
});

test("EXIF orientations 5-8 swap the axes", () => {
  // .rotate() applies orientation BEFORE extract, so the rect must scale against post-rotation dimensions.
  assert.deepEqual(orientedSize({ width: 4000, height: 3000, orientation: 1 }), { width: 4000, height: 3000 });
  assert.deepEqual(orientedSize({ width: 4000, height: 3000, orientation: 6 }), { width: 3000, height: 4000 });
  assert.deepEqual(orientedSize({ width: 4000, height: 3000 }), { width: 4000, height: 3000 });
});

test("a normalized rect becomes integer pixels", () => {
  const px = cropToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, { width: 1000, height: 800 });
  assert.deepEqual(px, { left: 250, top: 400, width: 500, height: 200 });
  for (const v of Object.values(px)) assert.ok(Number.isInteger(v));
});

test("a rect that rounds past the edge is clamped, not thrown", () => {
  // sharp.extract() throws on out-of-bounds; clamping is the difference between an image and a 500.
  const px = cropToPixels({ x: 0.9999, y: 0.9999, w: 1, h: 1 }, { width: 100, height: 100 });
  assert.ok(px.left + px.width <= 100, "width must stay inside the source");
  assert.ok(px.top + px.height <= 100, "height must stay inside the source");
  assert.ok(px.width >= 1 && px.height >= 1, "a degenerate rect must never reach sharp");
});

test("a full-frame crop is the whole image", () => {
  assert.deepEqual(cropToPixels({ x: 0, y: 0, w: 1, h: 1 }, { width: 640, height: 480 }),
                   { left: 0, top: 0, width: 640, height: 480 });
});

test("the cache key distinguishes every transform that changes the bytes", () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  const b = { left: 50, top: 0, width: 100, height: 100 };
  const keys = new Set([
    transformSuffix("cover", null, createHash),
    transformSuffix("inside", null, createHash),
    transformSuffix("cover", a, createHash),
    transformSuffix("cover", b, createHash),
  ]);
  assert.equal(keys.size, 4, "two transforms sharing a key overwrite each other behind an immutable header");
});

test("the same transform always yields the same key", () => {
  const crop = { left: 1, top: 2, width: 3, height: 4 };
  assert.equal(transformSuffix("cover", crop, createHash), transformSuffix("cover", crop, createHash));
});

test("every fit sharp accepts is allowed, and nothing else", () => {
  for (const fit of ["cover", "contain", "fill", "inside", "outside"]) assert.ok(FITS.has(fit));
  for (const fit of ["crop", "scale", "", "COVER"]) assert.ok(!FITS.has(fit));
});

test("extract runs AFTER rotate in the handler", () => {
  // Not executable here (sharp will not load), and too important to leave unguarded: the rect is in
  // displayed coordinates, so extracting before rotate crops the wrong region of any rotated photo.
  const src = readFileSync(new URL("../src/onDemandResize.js", import.meta.url), "utf8");
  const rotate = src.indexOf(".rotate()");
  const extract = src.indexOf(".extract(");
  assert.ok(rotate > -1 && extract > -1, "handler must both rotate and extract");
  assert.ok(rotate < extract, "extract() must come after rotate()");
});

test("the cache key carries the transform suffix", () => {
  const src = readFileSync(new URL("../src/onDemandResize.js", import.meta.url), "utf8");
  assert.match(src, /custom_\$\{width\}x\$\{height\}_\$\{suffix\}/,
    "a key without the transform lets two crops overwrite each other");
});
