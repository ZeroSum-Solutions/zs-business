/**
 * In-memory product photos and their edits for the demo (image-port.md IM-22, IM-23), with the
 * server's rules: an upload must be a PNG, JPEG or WebP within the size limit, the same bytes are
 * one asset, a request retried with its key replays, and only a staged variant whose digest the
 * owner saw can be approved (through a stored approval) or rejected. There is no worker: a
 * variant moves on by the clock as it is read, `queued` for QUEUED_MS, then `running` until
 * STAGED_MS after it was made, then `staged`. An approved one is `promoted` PROMOTE_MS later.
 * The edited bytes are fixed sample images per preset; the demo never changes a photo.
 */
import {
  generateVariantRequestSchema,
  MEDIA_CONTENT_TYPES,
  MEDIA_LIMITS,
  variantDecisionRequestSchema,
  type ApprovalRecord,
  type ImageFailureReason,
  type JsonValue,
  type ImagePreset,
  type ImageVariant,
  type MediaAsset,
  type MediaContentType,
} from "@zs/contracts";
import { newId as defaultNewId } from "../../id";
import { fingerprint } from "../../intent-key";
import { demoError, demoValidationError } from "../errors";
import type { ApprovalsApi, MediaApi } from "../types";
import type { DemoClock } from "./adapter";
import { DEMO_OWNER, DEMO_TENANT_ID } from "./seed";

/** Hooks that make the next edit end some other way. */
export interface DemoMediaControls {
  /** The next variant made fails with this reason instead of being staged. */
  failNextImageJob(reason: ImageFailureReason): void;
}

export const QUEUED_MS = 800;
export const STAGED_MS = 2_400;
export const PROMOTE_MS = 2_000;
const DAY = 86_400_000;

/** IM-20: the test double's prices (FAKE_TEST_PRICES in core), in cents. */
export const DEMO_IMAGE_PRICES: Readonly<Record<ImagePreset, number>> = Object.freeze({
  background_remove: 8, studio_background_swap: 20, upscale_2k: 12,
});
/** The fake adapter's models and licence, as core's allowlist names them. */
const MODELS: Readonly<Record<ImagePreset, string>> = Object.freeze({
  background_remove: "fake-matte-v1", studio_background_swap: "fake-matte-v1", upscale_2k: "fake-upscale-v1",
});
export const DEMO_MODEL_LICENSE = "none: test double with no weights";

// 64 by 48 PNGs drawn for the demo: a ring on a grey table, cut out, and on a studio backdrop.
const PHOTO_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAACJ0lEQVR42u3X6VIaQRQF4PNaisY8jEpUZJUBBAVkiVlMZIvZfJEYo2bzsU7SGJIqa3qYom9Pper64+Mfp87pmoIeVLPr1Ay13Do1Qy23Qc2wn9+gZqjnN6kZ6oVNaoZGIU3N0CimqRkOimlqhsPSE2r2cADNvS0m6efHtakfH2Ye8fv7f5Lug9bvD99uz9f+Do8a/+2dsTr19e0qk+iGVnmLvtyeP154vHFzdsdnR7TL2/RBavzN2Qqv36zQV0+0g21Kkx4/46MrjoIdSooz3vbdqPFXEyNF6b7oVHYoZd74uDm28caXcYqSndGpZCghavyimWHjZ6R6o1vNUIJtvGtu2PjLUYpSvdGrZijB9ti75oaNvxwtU6o3erVdurKOF8g27o//PLwjkY1+bZeubL/2Etn9Pwdwf7whkY3+fpaubP/zEtlG2PiLwbJINp7Ws3Rlu+RIZBth4w2JbBzXs3Rlu+FJZBth4y8GSyLZOG7k6Mp2vZXINsLGfzpdEsnGs0aOEmx3e9dc23ip3nh+kKcE24uNa27YeEOqt9gBRL3VSY8XPYAXhwVKmfdKGzfH9tjPSHYWPQAjzivtvOFJjZ8ewMtmgdKixtvu9nHG++iKk2aRPkiP99UTJ60ifREb77EjXrVK9G3R8Ul0w+t2iUmaNz7pPokfwP8Gp0d71OzhAAadMjXDsFOmZhh2A2qGUTegZhj3AmqGca9CzTDpV6gZJv0qNfsFDbNdVqgPj1gAAAAASUVORK5CYII=";
const CUTOUT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAABJklEQVR42u2XWw6CMBRE2RYK6hJFVHxuRETF57JqKmkg2AKBQi5lTjKfNjkTYjuWBQAAAAAAAOiC92HKeF57kQl77tIYKf05JtJl8o8tj/vLfeMyA8RnrK48TxwkGbR8HDjstnbYoOVFjJFX/bZI/rriGbNey1c9RyXPc1kSLaFIvu6ZMnmR3lx1Tc+VyUc+wQKafvZFBeTlI3/EBiEvyMufF0nIP291FpCXJ1eA7J7Xdb5MPvQIFdD2sJHJEyzg/4Wn63yZfOjZlAqQP291F5CVP81tWjdBW5O2F/KiANmw0VFAXp5kAW3seZU8yQKSEoonbdPPnrS8jkmr+rfvjXw6Z9Xyqre9MfLZKTtY+Sp73nj5KpO2TN4ykTJ5CwAAAAAAANAFXzYO0Nyf81eAAAAAAElFTkSuQmCC";
const STUDIO_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAACH0lEQVR42u3X23LSYBQF4PValdb6iNaq9dQXsVZt1fZCewBaTgmQBEgo0MMbLOeHQWec/CFD9p8ZZ/fiu2TNWnsYSDAbP1AzTJMHaoZpck/NMInvqRkm8R01w83ojpphPLylZo8HSAYzaoY4mlEzxNGUmmEUTlmmkw/bcz/eLz3l93d/ld0Ho3BC1073t/8Mzxr/7a2xNXf8ZotldMMwmNCV0/1na483jvYWXHbEoH9DF6TGH+1t8uvrTbrqif9h/JKTA0S9MSXlGW/7bNb4L6+MCqX7IuyOKWXV+Lw5tvHG55cVSnZG2E0oIWv8uplp45ekeiPwE0qwjS+amzb+cLdCqd4I/JgSbF/7orlp4w93n1CqN/pezKJs4yWyjX/Hf3qxIJGNXmfEomy/9hLZRtp4QyJb7ABp//NSB0gbf7AjdIBue8iibA85EtlG2viDnQ2RbPitAYuyPd5KZBtp4z8+3xDJhtccUILt2b5orm28VG94zYgSbC82RXPTxi8OINMbnUZECVlvdetm2sYbUr3Rvg4pZdUrbd4c29d+SbKz6AGMPK+0q4aXNX5+gNZVQGlZ423P9nnGu+iKZj2gC9LjXfVEs96nK3Lj3XVEo9ana+uOL6MbGrUey7RqfNl9cF3tUTNcXXap2eMB6hc+NUPt3KdmqJ171AzVM4+aoXrWoWa4/NWhZrj42aZm6g/wG/5ytSDF31DoAAAAAElFTkSuQmCC";
const OUTPUT_PNG: Readonly<Record<ImagePreset, string>> = Object.freeze({
  background_remove: CUTOUT_PNG, studio_background_swap: STUDIO_PNG, upscale_2k: PHOTO_PNG,
});

export const DEMO_PHOTO_ASSET_ID = "3c9e2f41-8a7b-4d6c-9e15-2a4b6c8d0e11";

const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest("SHA-256", bytes));

/** Width and height from the image header, or null when the header is not one of IM-3's types. */
export function imageSize(bytes: Uint8Array, type: MediaContentType): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (type === "image/png") {
    if (bytes.length < 24 || ascii(1, 3) !== "PNG" || ascii(12, 4) !== "IHDR") return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    // Walk the segments to the first start-of-frame marker.
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  if (bytes.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const chunk = ascii(12, 4);
  const read24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  if (chunk === "VP8X") return { width: 1 + read24(24), height: 1 + read24(27) };
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  return null;
}

interface StoredVariant {
  record: ImageVariant;
  /** What the job turns out to be, fixed when it is made: its bytes, or a failure. */
  fate: { bytes: Uint8Array<ArrayBuffer>; sha256: string } | { reason: ImageFailureReason };
}

export function createDemoMedia(options: { clock?: DemoClock; newId?: () => string; latencyMs?: number } = {}): {
  api: MediaApi & ApprovalsApi;
  controls: DemoMediaControls;
} {
  const clock = options.clock ?? { now: () => new Date() };
  const newId = options.newId ?? defaultNewId;
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const iso = (ms: number) => new Date(ms).toISOString();

  const assets = new Map<string, { record: MediaAsset; bytes: Uint8Array<ArrayBuffer> }>();
  const variants = new Map<string, StoredVariant>();
  const approvals = new Map<string, ApprovalRecord>();
  const replies = new Map<string, { print: string; response: Promise<unknown> }>();
  let failNext: ImageFailureReason | null = null;
  let jobs = 0;
  let seeded: Promise<void> | null = null;

  async function output(preset: ImagePreset): Promise<StoredVariant["fate"]> {
    const bytes = decode(OUTPUT_PNG[preset]);
    return { bytes, sha256: await sha256(bytes) };
  }
  /** What the next job turns out to be: a failure asked for with `failNextImageJob`, else the preset's sample. */
  async function fateFor(preset: ImagePreset): Promise<StoredVariant["fate"]> {
    if (failNext) {
      const reason = failNext;
      failNext = null;
      return { reason };
    }
    return output(preset);
  }

  function newVariant(source: MediaAsset, preset: ImagePreset, params: Record<string, string>, createdAt: number, fate: StoredVariant["fate"], id = newId()): StoredVariant {
    return {
      fate,
      record: {
        id, sourceAssetId: source.id, sourceSha256: source.sha256, preset, params, status: "queued", failureReason: null,
        sha256: null, matteSha256: null, backgroundSha256: null, adapter: null, modelId: null, modelLicense: null,
        workflowHash: null, promptText: null, providerJobId: null, priceMinor: DEMO_IMAGE_PRICES[preset], currency: "usd",
        vendorCostMicros: null, createdBy: DEMO_OWNER.userId, createdAt: iso(createdAt), stagedAt: null, expiresAt: null,
        approvedAt: null, promotedAt: null, rejectedAt: null,
      },
    };
  }

  /** Moves a variant on by the clock, as the worker would have by now. */
  function advance(stored: StoredVariant): ImageVariant {
    const now = clock.now().getTime();
    let record = stored.record;
    const made = Date.parse(record.createdAt);
    if (record.status === "queued" && now - made >= QUEUED_MS) record = { ...record, status: "running" };
    if (record.status === "running" && now - made >= STAGED_MS) {
      jobs += 1;
      const providerJobId = `fake-job-${jobs}`;
      if ("reason" in stored.fate) {
        record = { ...record, status: "failed", failureReason: stored.fate.reason, providerJobId };
      } else {
        const stagedAt = made + STAGED_MS;
        const swap = record.preset === "studio_background_swap";
        record = {
          ...record, status: "staged", sha256: stored.fate.sha256, adapter: "fake", modelId: MODELS[record.preset],
          modelLicense: DEMO_MODEL_LICENSE, workflowHash: `fake:${record.preset}:v1`, providerJobId, vendorCostMicros: 7_000,
          promptText: swap ? `Studio product photo background: ${String(record.params.backgroundDescription ?? "")}` : null,
          stagedAt: iso(stagedAt), expiresAt: iso(stagedAt + MEDIA_LIMITS.stagingDays * DAY),
        };
      }
    }
    if (record.status === "staged" && record.expiresAt && now >= Date.parse(record.expiresAt)) record = { ...record, status: "expired" };
    if (record.status === "approved" && record.approvedAt && now - Date.parse(record.approvedAt) >= PROMOTE_MS)
      record = { ...record, status: "promoted", promotedAt: iso(Date.parse(record.approvedAt) + PROMOTE_MS) };
    stored.record = record;
    return structuredClone(record);
  }

  const seed = () => (seeded ??= (async () => {
    const bytes = decode(PHOTO_PNG);
    const now = clock.now().getTime();
    const photo: MediaAsset = {
      id: DEMO_PHOTO_ASSET_ID, sha256: await sha256(bytes), contentType: "image/png", byteLength: bytes.byteLength,
      width: 64, height: 48, origin: "upload", variantId: null, createdBy: DEMO_OWNER.userId, createdAt: iso(now - 3 * DAY),
    };
    assets.set(photo.id, { record: photo, bytes });
    // One edit approved and in the library, one that could not find the ring.
    const done = newVariant(photo, "background_remove", { aspectRatio: "source" }, now - 3 * DAY + 60_000, await output("background_remove"),
      "3c9e2f41-8a7b-4d6c-9e15-2a4b6c8d0e21");
    advance(done);
    done.record = { ...done.record, status: "promoted", approvedAt: iso(now - 2 * DAY), promotedAt: iso(now - 2 * DAY + PROMOTE_MS) };
    variants.set(done.record.id, done);
    const failed = newVariant(photo, "studio_background_swap", { aspectRatio: "source", backgroundDescription: "White marble with soft morning light" },
      now - DAY, { reason: "matte_invalid" }, "3c9e2f41-8a7b-4d6c-9e15-2a4b6c8d0e22");
    advance(failed);
    variants.set(failed.record.id, failed);
  })());

  /** A key names one write: the same body replays its answer, another body is a conflict. A write that fails leaves nothing behind. */
  async function once<T>(key: string, body: unknown, work: () => Promise<T>): Promise<T> {
    const print = fingerprint(body);
    const stored = replies.get(key);
    let response: Promise<unknown>;
    if (stored) {
      if (stored.print !== print) throw demoError("Conflict", { reason: "idempotency_key_reused" });
      response = stored.response;
    } else {
      response = work().then((value) => structuredClone(value));
      replies.set(key, { print, response });
      response.catch(() => replies.delete(key));
    }
    return structuredClone(await response) as T;
  }

  const findVariant = (id: string) => {
    const found = variants.get(id);
    if (!found) throw demoError("NotFound");
    advance(found);
    return found;
  };
  const decision = (input: { sha256: string }) => {
    const parsed = variantDecisionRequestSchema.safeParse({ sha256: input.sha256 });
    if (!parsed.success) throw demoValidationError(parsed.error.issues);
    return parsed.data;
  };
  /** IM-12, IM-23: only the staged bytes the owner saw. */
  const checkStaged = (stored: StoredVariant, sha: string) => {
    if (stored.record.status === "expired") throw demoError("Conflict", { reason: "variant_expired" });
    if (stored.record.status !== "staged") throw demoError("Conflict", { reason: "variant_not_staged", status: stored.record.status });
    if (stored.record.sha256 !== sha) throw demoError("Conflict", { reason: "variant_changed" });
  };
  const newestFirst = <T extends { record: { createdAt: string } }>(a: T, b: T) => b.record.createdAt.localeCompare(a.record.createdAt);

  const api: MediaApi & ApprovalsApi = {
    async listMediaAssets() {
      await seed(); await wait();
      return [...assets.values()].sort(newestFirst).map((asset) => structuredClone(asset.record));
    },
    async uploadMediaAsset(file, options) {
      await seed(); await wait();
      const type = MEDIA_CONTENT_TYPES.find((allowed) => allowed === file.type);
      if (!type) throw demoValidationError([{ path: ["contentType"], message: "Upload a PNG, JPEG or WebP image" }]);
      if (file.size < 1 || file.size > MEDIA_LIMITS.fileBytes) throw demoValidationError([{ path: ["byteLength"], message: "The image is too large" }]);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = imageSize(bytes, type);
      if (!size || size.width < 1 || size.height < 1 || size.width > MEDIA_LIMITS.maxSide || size.height > MEDIA_LIMITS.maxSide
        || size.width * size.height > MEDIA_LIMITS.maxPixels) throw demoValidationError([{ path: [], message: "The image could not be read" }]);
      const sha = await sha256(bytes);
      return once(options.idempotencyKey, ["upload", type, sha], async () => {
        // IM-1: the same bytes are one asset.
        const known = [...assets.values()].find((asset) => asset.record.sha256 === sha);
        if (known) return known.record;
        const record: MediaAsset = {
          id: newId(), sha256: sha, contentType: type, byteLength: bytes.byteLength, ...size, origin: "upload", variantId: null,
          createdBy: DEMO_OWNER.userId, createdAt: clock.now().toISOString(),
        };
        assets.set(record.id, { record, bytes });
        return record;
      });
    },
    async getMediaAssetContent(assetId) {
      await seed(); await wait();
      const asset = assets.get(assetId);
      if (!asset) throw demoError("NotFound");
      return new Blob([asset.bytes], { type: asset.record.contentType });
    },
    async listImageVariants() {
      await seed(); await wait();
      return [...variants.values()].sort(newestFirst).map(advance);
    },
    async getImageVariant(variantId) {
      await seed(); await wait();
      return structuredClone(findVariant(variantId).record);
    },
    async getImageVariantContent(variantId) {
      await seed(); await wait();
      const stored = findVariant(variantId);
      if (!["staged", "approved", "promoted"].includes(stored.record.status) || "reason" in stored.fate) throw demoError("NotFound");
      return new Blob([stored.fate.bytes], { type: "image/png" });
    },
    async generateImageVariant(input, options) {
      await seed(); await wait();
      const parsed = generateVariantRequestSchema.safeParse(input);
      if (!parsed.success) throw demoValidationError(parsed.error.issues);
      const request = parsed.data;
      return once(options.idempotencyKey, ["generate", request], async () => {
        const source = assets.get(request.sourceAssetId);
        if (!source) throw demoError("NotFound");
        const stored = newVariant(source.record, request.preset, request.params, clock.now().getTime(), await fateFor(request.preset));
        variants.set(stored.record.id, stored);
        return stored.record;
      });
    },
    async requestVariantApproval(input, options) {
      await seed(); await wait();
      const body = decision(input);
      return once(options.idempotencyKey, ["approval", input.variantId, body], async () => {
        const stored = findVariant(input.variantId);
        checkStaged(stored, body.sha256);
        const now = clock.now().getTime();
        const approval: ApprovalRecord = {
          id: newId(), tenantId: DEMO_TENANT_ID, actionType: "media.variant.approve",
          target: { tenantId: DEMO_TENANT_ID, type: "media_variant", id: input.variantId },
          payload: { variantId: input.variantId, sha256: body.sha256 }, summary: "Approve an edited image",
          status: "pending", standing: "pending", requestedBy: DEMO_OWNER.userId, requestedAt: iso(now), expiresAt: iso(now + 7 * DAY),
          decidedBy: null, decidedAt: null, decisionNote: null, revokedBy: null, revokedAt: null, revokeNote: null, executedActionId: null,
        };
        approvals.set(approval.id, approval);
        return approval;
      });
    },
    async approveApproval(approvalId, options) {
      await seed(); await wait();
      return once(options.idempotencyKey, ["approve", approvalId], async () => {
        const approval = approvals.get(approvalId);
        if (!approval) throw demoError("NotFound");
        if (approval.status !== "pending") throw demoError("Conflict", { reason: "approval_decided" });
        const payload = approval.payload as { variantId: string; sha256: string };
        const stored = findVariant(payload.variantId);
        // An approval of what is already approved answers it unchanged, as the handler does.
        if (stored.record.status !== "approved" && stored.record.status !== "promoted") {
          checkStaged(stored, payload.sha256);
          stored.record = { ...stored.record, status: "approved", approvedAt: clock.now().toISOString() };
        }
        const actionId = newId();
        const decided: ApprovalRecord = {
          ...approval, status: "approved", standing: "approved", decidedBy: DEMO_OWNER.userId, decidedAt: clock.now().toISOString(), executedActionId: actionId,
        };
        approvals.set(approvalId, decided);
        return { approval: { actionId: newId(), result: decided }, execution: { actionId, result: structuredClone(stored.record) as unknown as JsonValue } };
      });
    },
    async rejectImageVariant(input, options) {
      await seed(); await wait();
      const body = decision(input);
      return once(options.idempotencyKey, ["reject", input.variantId, body], async () => {
        const stored = findVariant(input.variantId);
        // A repeat on a rejected variant returns it unchanged (IM-23).
        if (stored.record.status === "rejected" && stored.record.sha256 === body.sha256) return stored.record;
        checkStaged(stored, body.sha256);
        stored.record = { ...stored.record, status: "rejected", rejectedAt: clock.now().toISOString() };
        return stored.record;
      });
    },
  };

  return { api, controls: { failNextImageJob(reason) { failNext = reason; } } };
}
