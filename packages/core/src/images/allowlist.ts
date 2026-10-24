// Commercial-safe weights only (image-port.md IM-8). Each entry records the licence of the
// weights it runs. Nothing runs that is not listed and verified (IM-19).
import type { ImageAdapter } from "@zs/contracts";

export interface ModelEntry {
  readonly adapter: ImageAdapter;
  readonly modelId: string;
  /** The weights' licence, in our words. */
  readonly license: string;
  /** Self-hosted weights only: the SHA-256 of the `.safetensors` file. */
  readonly weightsSha256?: string;
  /**
   * IM-19: false until the owner has checked the vendor's hosted-use terms for this model. An
   * unverified entry is listed so the adapter and its tests can name it, but nothing runs on it.
   */
  readonly verified: boolean;
}

export const IMAGE_MODEL_ALLOWLIST: readonly ModelEntry[] = Object.freeze([
  { adapter: "fake", modelId: "fake-matte-v1", license: "none: test double with no weights", verified: true },
  { adapter: "fake", modelId: "fake-upscale-v1", license: "none: test double with no weights", verified: true },
  // Vendor entries (IM-19). TODO verify each vendor's hosted-use terms before setting verified.
  // Kie.ai entries:
  // TODO verify: each licence below is our reading of the model maker's hosted-API terms, not checked.
  { adapter: "kie", modelId: "recraft/remove-background", license: "TODO verify: Recraft's proprietary hosted model; outputs usable commercially under its API terms", verified: false },
  { adapter: "kie", modelId: "recraft/remove-background+bytedance/seedream-v4-text-to-image", license: "TODO verify: Recraft's proprietary hosted cut-out plus ByteDance Seedream 4.0, a proprietary hosted model; outputs usable commercially under their API terms", verified: false },
  { adapter: "kie", modelId: "topaz/image-upscale", license: "TODO verify: Topaz Labs' proprietary hosted upscaler; outputs usable commercially under its API terms", verified: false },
  // End of Kie.ai entries.
  // FAL entries:
  // TODO verify: FAL's hosted-use terms for each model, and that FAL serves these weights.
  { adapter: "fal", modelId: "fal-ai/birefnet/v2", license: "BiRefNet weights, MIT: commercial use allowed. TODO verify hosted-use terms", verified: false },
  {
    adapter: "fal", modelId: "fal-ai/birefnet/v2+fal-ai/flux/schnell",
    license: "BiRefNet weights, MIT; FLUX.1 schnell weights, Apache-2.0: commercial use allowed for both. TODO verify hosted-use terms",
    verified: false,
  },
  { adapter: "fal", modelId: "fal-ai/esrgan", license: "Real-ESRGAN weights, BSD-3-Clause: commercial use allowed. TODO verify hosted-use terms", verified: false },
  // End of FAL entries.
]);

/**
 * IM-8: names that must never reach the list: FLUX dev weights and non-commercial background
 * removers. A test checks every entry against this, so a later edit cannot add one by mistake.
 */
export const FORBIDDEN_MODEL_PATTERNS: readonly RegExp[] = Object.freeze([
  /flux[._\s-]*1?[._\s-]*(dev|fill[._\s-]*dev|redux[._\s-]*dev)/i,
  /flux[._\s-]*2[._\s-]*dev/i,
  /rmbg[._\s-]*1[._\s]*4/i,
]);
export const NON_COMMERCIAL_LICENSE = /non[\s-]*commercial|research[\s-]*only|cc[\s-]*by[\s-]*nc/i;

export const isForbiddenModel = (modelId: string): boolean => FORBIDDEN_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));

export function findAllowedModel(adapter: ImageAdapter, modelId: string): ModelEntry | null {
  const entry = IMAGE_MODEL_ALLOWLIST.find((candidate) => candidate.adapter === adapter && candidate.modelId === modelId);
  return entry && entry.verified && !isForbiddenModel(entry.modelId) && !NON_COMMERCIAL_LICENSE.test(entry.license) ? entry : null;
}

/** IM-8: self-hosted weights load only from `.safetensors`; `.ckpt`, `.pt` and other pickle formats are refused. */
export const isSafeWeightsFile = (filename: string): boolean => /\.safetensors$/i.test(filename);
