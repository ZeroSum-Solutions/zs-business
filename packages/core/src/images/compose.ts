// Product pixel lock (image-port.md IM-9). Our own code builds the output from the source, the
// matte and the generated background, then checks the vendor's file against it. A vendor never
// decides what the product looks like.
import type { ImagePreset } from "@zs/contracts";
import { decodePng, type RgbaImage } from "./png.js";

/** IM-9: the product region (alpha above 0) must cover 2% to 98% of the pixels. */
export const MATTE_MIN_COVERAGE = 0.02;
export const MATTE_MAX_COVERAGE = 0.98;

export type MatteCheck = { readonly ok: true; readonly alpha: Uint8Array } | { readonly ok: false };

/** An 8-bit grayscale matte of the source's size whose product region is neither empty nor full. */
export function checkMatte(matteBytes: Uint8Array, source: RgbaImage): MatteCheck {
  let decoded;
  try { decoded = decodePng(matteBytes); } catch { return { ok: false }; }
  if (decoded.colorType !== 0 || decoded.width !== source.width || decoded.height !== source.height) return { ok: false };
  const pixels = source.width * source.height;
  const alpha = new Uint8Array(pixels);
  let covered = 0;
  for (let p = 0; p < pixels; p += 1) {
    alpha[p] = decoded.rgba[p * 4]!;
    if (alpha[p]! > 0) covered += 1;
  }
  const coverage = covered / pixels;
  return coverage >= MATTE_MIN_COVERAGE && coverage <= MATTE_MAX_COVERAGE ? { ok: true, alpha } : { ok: false };
}

/** The product's opacity at each pixel: the matte scaled by the source's own alpha. */
export function effectiveAlpha(source: RgbaImage, matte: Uint8Array): Uint8Array {
  const out = new Uint8Array(matte.length);
  for (let p = 0; p < matte.length; p += 1) out[p] = Math.floor((matte[p]! * source.rgba[p * 4 + 3]! + 127) / 255);
  return out;
}

/**
 * The fixed composite: each pixel is `source x alpha + background x (1 - alpha)` in whole numbers,
 * rounded to nearest. A swap is opaque. With no background (background removal) the colour is the
 * source's where alpha is above 0, the alpha is the product's, and the rest is fully transparent.
 */
export function composite(source: RgbaImage, matte: Uint8Array, background: RgbaImage | null): RgbaImage {
  const alpha = effectiveAlpha(source, matte);
  const out = new Uint8Array(source.rgba.length);
  for (let p = 0; p < alpha.length; p += 1) {
    const a = alpha[p]!;
    const o = p * 4;
    if (background === null) {
      if (a === 0) continue;
      out[o] = source.rgba[o]!;
      out[o + 1] = source.rgba[o + 1]!;
      out[o + 2] = source.rgba[o + 2]!;
      out[o + 3] = a;
    } else {
      for (let c = 0; c < 3; c += 1) out[o + c] = Math.floor((source.rgba[o + c]! * a + background.rgba[o + c]! * (255 - a) + 127) / 255);
      out[o + 3] = 255;
    }
  }
  return { width: source.width, height: source.height, rgba: out };
}

export type PixelLock =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "size_changed" | "product_pixels_changed" };

/** IM-9: the output must equal our composite over every pixel whose alpha is above 0. */
export function checkProductPixels(expected: RgbaImage, alpha: Uint8Array, output: RgbaImage): PixelLock {
  if (output.width !== expected.width || output.height !== expected.height) return { ok: false, reason: "size_changed" };
  for (let p = 0; p < alpha.length; p += 1) {
    if (alpha[p] === 0) continue;
    const o = p * 4;
    if (output.rgba[o] !== expected.rgba[o] || output.rgba[o + 1] !== expected.rgba[o + 1]
      || output.rgba[o + 2] !== expected.rgba[o + 2] || output.rgba[o + 3] !== expected.rgba[o + 3])
      return { ok: false, reason: "product_pixels_changed" };
  }
  return { ok: true };
}

/** Presets whose output our code builds from a matte (IM-9). */
export const MATTE_PRESETS: ReadonlySet<ImagePreset> = new Set(["background_remove", "studio_background_swap"]);
