// Shared parts of the hosted image adapters (image-port.md IM-6, IM-17..IM-19). Each vendor call
// goes through `vendorFetch`: HTTPS only, to a fixed host list, and never follows a redirect. The
// output is built here from the vendor's cut-out and background, so a vendor never decides the
// product's pixels (IM-9); the worker then checks it again.
import type { ImagePreset } from "@zs/contracts";
import { composite } from "../compose.js";
import { decodePng, encodeGrayPng, encodeRgbaPng, readImageInfo, type RgbaImage } from "../png.js";
import { ImageAdapterRefused, sha256Hex, type PortFile, type PresetInput, type PresetOutput } from "../port.js";

/** What every hosted adapter takes. The key and the costs come from config, never from a request. */
export interface VendorAdapterOptions {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly clock: { now(): Date };
  /** Waits between status polls; tests pass one that returns at once. */
  readonly sleep: (ms: number) => Promise<void>;
  /** TODO verify: what one job of each preset costs us at the vendor, in micros of USD (from config). */
  readonly vendorCostMicros: Readonly<Record<ImagePreset, number>>;
  readonly pollIntervalMs?: number;
  /** How long `runPreset` polls before it gives up with an unknown outcome. */
  readonly timeoutMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** IM-6: a vendor call to one of its fixed HTTPS hosts. A redirect or any other host is refused. */
export async function vendorFetch(
  fetcher: typeof fetch, hosts: ReadonlySet<string>, url: string, init: RequestInit = {},
): Promise<Response> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ImageAdapterRefused("The vendor named an invalid URL"); }
  if (parsed.protocol !== "https:" || !hosts.has(parsed.hostname)) throw new ImageAdapterRefused("The vendor named a host outside its list");
  const response = await fetcher(parsed.toString(), { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new ImageAdapterRefused("The vendor answered with a redirect");
  return response;
}

const file = (bytes: Uint8Array): PortFile => ({ bytes, sha256: sha256Hex(bytes) });

/** Nearest-neighbour resize of a generated background to the source's size. Never used on the product. */
export function fitBackground(background: RgbaImage, width: number, height: number): RgbaImage {
  if (background.width === width && background.height === height) return background;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(background.height - 1, Math.floor((y * background.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(background.width - 1, Math.floor((x * background.width) / width));
      const from = (sy * background.width + sx) * 4;
      rgba.set(background.rgba.subarray(from, from + 4), (y * width + x) * 4);
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export interface Provenance {
  readonly adapter: PresetOutput["provenance"]["adapter"];
  readonly modelId: string;
  readonly workflowHash: string;
  readonly promptText: string | null;
  readonly providerJobId: string;
  readonly vendorCostMicros: number;
}

/**
 * IM-9, IM-17: the matte presets. The vendor's cut-out (a PNG with alpha at the source's size)
 * gives the matte; for a swap the vendor's background is fitted to the source's size; our own
 * composite is the output. An unreadable or wrongly sized cut-out is a definite refusal.
 */
export function buildMatteOutput(input: PresetInput, cutoutPng: Uint8Array, backgroundPng: Uint8Array | null, provenance: Provenance): PresetOutput {
  let source; let cutout;
  try { source = decodePng(input.source.bytes); } catch { throw new ImageAdapterRefused("The source is not a readable PNG"); }
  try { cutout = decodePng(cutoutPng); } catch { throw new ImageAdapterRefused("The vendor's cut-out is not a readable PNG"); }
  if (cutout.width !== source.width || cutout.height !== source.height) throw new ImageAdapterRefused("The vendor's cut-out changed size");
  const alpha = new Uint8Array(source.width * source.height);
  for (let p = 0; p < alpha.length; p += 1) alpha[p] = cutout.rgba[p * 4 + 3]!;
  let background: RgbaImage | null = null;
  if (input.preset === "studio_background_swap") {
    if (!backgroundPng) throw new ImageAdapterRefused("The vendor returned no background");
    try { background = fitBackground(decodePng(backgroundPng), source.width, source.height); } catch {
      throw new ImageAdapterRefused("The vendor's background is not a readable PNG");
    }
  }
  const image = composite(source, alpha, background);
  const bytes = encodeRgbaPng(image);
  return {
    bytes, contentType: "image/png", width: image.width, height: image.height, sha256: sha256Hex(bytes),
    matte: file(encodeGrayPng(source.width, source.height, alpha)),
    background: background ? file(encodeRgbaPng(background)) : null,
    provenance,
  };
}

/** `upscale_2k`: the vendor's file is the output, if it is a PNG or WebP we can read the size of. */
export function buildUpscaleOutput(bytes: Uint8Array, provenance: Provenance): PresetOutput {
  const info = readImageInfo(bytes);
  if (!info || (info.contentType !== "image/png" && info.contentType !== "image/webp"))
    throw new ImageAdapterRefused("The vendor's upscale is not a PNG or WebP");
  return {
    bytes, contentType: info.contentType, width: info.width, height: info.height, sha256: sha256Hex(bytes),
    matte: null, background: null, provenance,
  };
}

/** A workflow hash names the adapter's fixed request shape per preset, so a change to it shows. */
export const workflowHash = (adapter: string, preset: ImagePreset, shape: unknown): string =>
  sha256Hex(new TextEncoder().encode(`${adapter}:${preset}:${JSON.stringify(shape)}`));
