// The image port (image-port.md IM-5): one interface for every adapter. A deploy names one
// adapter. The fake below is deterministic and needs no vendor, key, Python or network.
import { createHash } from "node:crypto";
import type { ImageAdapter, ImagePreset } from "@zs/contracts";
import { composite, effectiveAlpha } from "./compose.js";
import { decodePng, encodeGrayPng, encodeRgbaPng, readImageInfo, type RgbaImage } from "./png.js";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface PresetInput {
  readonly tenantId: string;
  readonly variantId: string;
  readonly preset: ImagePreset;
  readonly params: Readonly<Record<string, unknown>>;
  readonly source: { readonly bytes: Uint8Array; readonly contentType: string; readonly sha256: string; readonly width: number; readonly height: number };
  /** Equal to the variant ID: a vendor that honours it never runs one job twice. */
  readonly idempotencyKey: string;
}

export interface PortFile {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PresetOutput {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  /** Presets that cut the product out return the matte (8-bit gray PNG, the value is the alpha). */
  readonly matte: PortFile | null;
  /** A background swap also returns the generated background (PNG of the source's size). */
  readonly background: PortFile | null;
  readonly provenance: {
    readonly adapter: ImageAdapter;
    readonly modelId: string;
    readonly workflowHash: string;
    readonly promptText: string | null;
    readonly providerJobId: string | null;
    readonly vendorCostMicros: number;
  };
}

export type LookupResult =
  | { readonly state: "done"; readonly output: PresetOutput }
  | { readonly state: "pending" }
  | { readonly state: "failed" };

/** The call may or may not have run (a timeout, a lost connection). It must not be sent again. */
export class ImageOutcomeUnknown extends Error {
  constructor(readonly providerJobId: string | null = null, message = "The image vendor's answer is unknown") {
    super(message);
    this.name = "ImageOutcomeUnknown";
  }
}
/** The vendor definitely did not run the job, or ran it and refused: nothing was produced or billed. */
export class ImageAdapterRefused extends Error {
  constructor(message = "The image vendor refused the job") {
    super(message);
    this.name = "ImageAdapterRefused";
  }
}

export interface ImageWorkflowPort {
  readonly adapter: ImageAdapter;
  /** The model the preset runs on, so the worker can check the allowlist before it reserves or calls. */
  modelId(preset: ImagePreset): string;
  runPreset(input: PresetInput): Promise<PresetOutput>;
  /** Asks the vendor about a job whose answer never arrived. */
  lookup(providerJobId: string): Promise<LookupResult>;
}

export interface FakeImageWorkflowPort extends ImageWorkflowPort {
  readonly adapter: "fake";
  /** Every runPreset call, in order. */
  readonly calls: readonly PresetInput[];
  /** Every provider job ID asked about. */
  readonly lookups: readonly string[];
  /** The next call is refused (definite failure). */
  failNext(): void;
  /** The next call does the work, then loses the answer: the worker sees an unknown outcome. */
  timeoutNext(providerJobId?: string | null): void;
  /** What a lookup of a timed-out job answers from now on. */
  settleLookup(providerJobId: string, state: "pending" | "done" | "failed"): void;
  /** The next output differs from the composite in one product pixel (a partial-alpha one if asked). */
  alterProductPixelNext(where?: "any" | "partial"): void;
  /** The next matte is empty, or covers the whole image. */
  matteNext(kind: "empty" | "full"): void;
  /** The next output reports a digest that is not its bytes'. */
  corruptDigestNext(): void;
  /** The next output has the wrong size. */
  resizeNext(): void;
  /** Runs the preset on another model name (to prove the allowlist is checked before any call). */
  useModelId(preset: ImagePreset, modelId: string): void;
}

const FAKE_MODELS: Readonly<Record<ImagePreset, string>> = {
  background_remove: "fake-matte-v1",
  studio_background_swap: "fake-matte-v1",
  upscale_2k: "fake-upscale-v1",
};

/** A soft-edged ellipse: solid inside, a ramp at the rim (partial alpha), empty outside. */
function ellipseMatte(width: number, height: number): Uint8Array {
  const matte = new Uint8Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const rx = width * 0.35;
  const ry = height * 0.35;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      matte[y * width + x] = d <= 0.8 ? 255 : d >= 1 ? 0 : Math.round(255 * (1 - d) / 0.2);
    }
  }
  return matte;
}

function backgroundFor(width: number, height: number, prompt: string): RgbaImage {
  const seed = createHash("sha256").update(prompt).digest();
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const t = height > 1 ? y / (height - 1) : 0;
      rgba[o] = Math.round(seed[0]! * (1 - t) + seed[3]! * t);
      rgba[o + 1] = Math.round(seed[1]! * (1 - t) + seed[4]! * t);
      rgba[o + 2] = Math.round(seed[2]! * (1 - t) + seed[5]! * t);
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function scaleNearest(source: RgbaImage, longSide: number): RgbaImage {
  const factor = Math.max(1, longSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor(y / factor));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(x / factor));
      rgba.set(source.rgba.subarray((sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

const file = (bytes: Uint8Array): PortFile => ({ bytes, sha256: sha256Hex(bytes) });

export function createFakeImageWorkflowPort(): FakeImageWorkflowPort {
  const calls: PresetInput[] = [];
  const lookups: string[] = [];
  const models: Record<ImagePreset, string> = { ...FAKE_MODELS };
  const jobs = new Map<string, { output: PresetOutput; state: "pending" | "done" | "failed" }>();
  let refuse = false;
  let timeout: { providerJobId: string | null } | null = null;
  let alter: "any" | "partial" | null = null;
  let matteKind: "empty" | "full" | null = null;
  let corrupt = false;
  let resize = false;
  let counter = 0;

  function build(input: PresetInput, providerJobId: string): PresetOutput {
    const decoded = decodePng(input.source.bytes);
    const modelId = models[input.preset];
    const workflowHash = sha256Hex(new TextEncoder().encode(`fake:${input.preset}:v1`));
    const prompt = input.preset === "studio_background_swap"
      ? `Studio product photo background: ${String(input.params.backgroundDescription ?? "")}` : null;
    let image: RgbaImage;
    let matte: PortFile | null = null;
    let background: PortFile | null = null;
    if (input.preset === "upscale_2k") {
      image = scaleNearest(decoded, 2048);
    } else {
      const alpha = matteKind === "empty" ? new Uint8Array(decoded.width * decoded.height)
        : matteKind === "full" ? new Uint8Array(decoded.width * decoded.height).fill(255)
        : ellipseMatte(decoded.width, decoded.height);
      matte = file(encodeGrayPng(decoded.width, decoded.height, alpha));
      const bg = input.preset === "studio_background_swap" ? backgroundFor(decoded.width, decoded.height, prompt ?? "") : null;
      if (bg) background = file(encodeRgbaPng(bg));
      image = composite(decoded, alpha, bg);
      if (alter !== null) {
        const effective = effectiveAlpha(decoded, alpha);
        let pick = -1;
        for (let p = 0; p < effective.length && pick < 0; p += 1)
          if (alter === "partial" ? effective[p]! > 0 && effective[p]! < 255 : effective[p]! > 0) pick = p;
        if (pick >= 0) {
          const rgba = image.rgba.slice();
          rgba[pick * 4] = (rgba[pick * 4]! + 1) & 0xff;
          image = { ...image, rgba };
        }
      }
    }
    if (resize) image = { width: image.width + 1, height: image.height, rgba: new Uint8Array((image.width + 1) * image.height * 4) };
    const bytes = encodeRgbaPng(image);
    return {
      bytes, contentType: "image/png", width: image.width, height: image.height,
      sha256: corrupt ? "0".repeat(64) : sha256Hex(bytes), matte, background,
      provenance: { adapter: "fake", modelId, workflowHash, promptText: prompt, providerJobId, vendorCostMicros: 7_000 },
    };
  }

  return {
    adapter: "fake",
    calls,
    lookups,
    modelId: (preset) => models[preset],
    failNext: () => { refuse = true; },
    timeoutNext: (providerJobId = null) => { timeout = { providerJobId }; },
    settleLookup(providerJobId, state) {
      const job = jobs.get(providerJobId);
      if (!job) throw new Error("No such fake job");
      job.state = state;
    },
    alterProductPixelNext: (where = "any") => { alter = where; },
    matteNext: (kind) => { matteKind = kind; },
    corruptDigestNext: () => { corrupt = true; },
    resizeNext: () => { resize = true; },
    useModelId: (preset, modelId) => { models[preset] = modelId; },
    async runPreset(input) {
      calls.push(input);
      if (!readImageInfo(input.source.bytes)) throw new ImageAdapterRefused("Unreadable source image");
      if (refuse) { refuse = false; throw new ImageAdapterRefused(); }
      counter += 1;
      const providerJobId = `fake-job-${counter}`;
      const output = build(input, providerJobId);
      alter = null; matteKind = null; corrupt = false; resize = false;
      if (timeout) {
        const named = timeout.providerJobId ?? providerJobId;
        timeout = null;
        jobs.set(named, { output: { ...output, provenance: { ...output.provenance, providerJobId: named } }, state: "pending" });
        throw new ImageOutcomeUnknown(named);
      }
      return output;
    },
    async lookup(providerJobId) {
      lookups.push(providerJobId);
      const job = jobs.get(providerJobId);
      if (!job) return { state: "failed" };
      return job.state === "done" ? { state: "done", output: job.output } : { state: job.state };
    },
  };
}
