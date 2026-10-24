// Commercial-safe weights only (image-port.md IM-8). Each entry records the licence of the
// weights it runs. Nothing runs that is not listed. No vendor model is listed yet: the hosted
// model IDs and their terms are settled when the first vendor adapter is written (Known limits).
import type { ImageAdapter } from "@zs/contracts";

export interface ModelEntry {
  readonly adapter: ImageAdapter;
  readonly modelId: string;
  /** The weights' licence, in our words. */
  readonly license: string;
  /** Self-hosted weights only: the SHA-256 of the `.safetensors` file. */
  readonly weightsSha256?: string;
}

export const IMAGE_MODEL_ALLOWLIST: readonly ModelEntry[] = Object.freeze([
  { adapter: "fake", modelId: "fake-matte-v1", license: "none: test double with no weights" },
  { adapter: "fake", modelId: "fake-upscale-v1", license: "none: test double with no weights" },
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
  return entry && !isForbiddenModel(entry.modelId) && !NON_COMMERCIAL_LICENSE.test(entry.license) ? entry : null;
}

/** IM-8: self-hosted weights load only from `.safetensors`; `.ckpt`, `.pt` and other pickle formats are refused. */
export const isSafeWeightsFile = (filename: string): boolean => /\.safetensors$/i.test(filename);
