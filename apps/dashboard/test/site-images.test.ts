// The Site screen's Images section (image-port.md IM-22..IM-24): one label, tone and plain sentence per
// status, actions only where the server allows them, and a demo that runs the lifecycle with no backend.
import { IMAGE_FAILURE_REASONS, IMAGE_STATUSES, type ImageVariant } from "@zs/contracts";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import {
  FAILURE_MESSAGES,
  generateRequest,
  pickedPhoto,
  provenanceRows,
  uploadedPhotos,
  variantActions,
  variantStatus,
  variantsOf,
  variantTitle,
} from "../src/components/site/images-model";
import { ImagesSection } from "../src/components/site/images-section";
import { isApiError } from "../src/lib/api/errors";
import { createDemoMedia, DEMO_PHOTO_ASSET_ID, imageSize, PROMOTE_MS, QUEUED_MS, STAGED_MS } from "../src/lib/api/demo/media";
import { imageWorkPending } from "../src/lib/queries";
import { keys, renderScreen } from "./helpers/render";

const SHA = "a".repeat(64);

function variant(change: Partial<ImageVariant> = {}): ImageVariant {
  return {
    id: "3c9e2f41-8a7b-4d6c-9e15-2a4b6c8d0f01", sourceAssetId: DEMO_PHOTO_ASSET_ID, sourceSha256: SHA, preset: "background_remove",
    params: { aspectRatio: "source" }, status: "staged", failureReason: null, sha256: SHA, matteSha256: null, backgroundSha256: null,
    adapter: "fake", modelId: "fake-matte-v1", modelLicense: "none: test double with no weights", workflowHash: "fake:background_remove:v1",
    promptText: null, providerJobId: "fake-job-1", priceMinor: 8, currency: "usd", vendorCostMicros: 7000,
    createdBy: "9a1b3c5d-7e9f-4a1b-8c2d-000000000001", createdAt: "2026-10-24T10:00:00.000Z", stagedAt: "2026-10-24T10:00:02.400Z",
    expiresAt: "2026-11-07T10:00:02.400Z", approvedAt: null, promotedAt: null, rejectedAt: null, ...change,
  };
}

/** A 2 by 1 RGBA PNG: signature, IHDR, one IDAT, IEND. */
const TINY_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM4ISf3X07uxH8AECsEBxOnYNoAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

describe("image variant status", () => {
  it("gives every status a label, a tone and a sentence", () => {
    for (const status of IMAGE_STATUSES) {
      const view = variantStatus({ status, failureReason: status === "failed" ? "adapter_error" : null });
      expect(view.label, status).not.toBe("");
      expect(view.summary, status).toMatch(/\.$/);
    }
  });

  it("says Waiting and Working while the worker is on it, and pulses", () => {
    expect(variantStatus({ status: "queued", failureReason: null })).toMatchObject({ label: "Waiting", tone: "info", working: true });
    expect(variantStatus({ status: "running", failureReason: null })).toMatchObject({ label: "Working", tone: "info", working: true });
  });

  it("asks for a decision on a staged variant, and calls approved and promoted both Approved", () => {
    // The one state that waits on the owner stands apart from Approved and Live (warn, not accent or success).
    expect(variantStatus({ status: "staged", failureReason: null })).toMatchObject({ label: "Ready to review", tone: "warn", working: false });
    expect(variantStatus({ status: "approved", failureReason: null })).toMatchObject({ label: "Approved", tone: "success", working: true });
    expect(variantStatus({ status: "promoted", failureReason: null })).toEqual({
      label: "Approved", tone: "success", working: false, summary: "In your images, ready to use on your site.",
    });
    expect(variantStatus({ status: "rejected", failureReason: null })).toMatchObject({ label: "Rejected", tone: "neutral" });
    expect(variantStatus({ status: "expired", failureReason: null })).toMatchObject({ label: "Expired", tone: "neutral" });
  });

  it("explains each failure in plain words, never with its code", () => {
    for (const reason of IMAGE_FAILURE_REASONS) {
      const view = variantStatus({ status: "failed", failureReason: reason });
      expect(view).toMatchObject({ label: "Failed", tone: "danger", working: false });
      expect(view.summary).toBe(FAILURE_MESSAGES[reason]);
      expect(view.summary).not.toContain("_");
    }
    expect(variantStatus({ status: "failed", failureReason: "insufficient_funds" }).summary).toBe("Your balance was too low for this edit. Add funds, then try again.");
  });
});

describe("image variant actions", () => {
  it("lets only a staged variant with bytes be approved or rejected", () => {
    for (const status of IMAGE_STATUSES) {
      expect(variantActions({ status, sha256: SHA }).decide, status).toBe(status === "staged");
    }
    expect(variantActions({ status: "staged", sha256: null }).decide).toBe(false);
  });

  it("shows the edited bytes only once they exist and while the server keeps them", () => {
    const shown = IMAGE_STATUSES.filter((status) => variantActions({ status, sha256: SHA }).showResult);
    expect(shown).toEqual(["staged", "approved", "promoted"]);
    expect(variantActions({ status: "queued", sha256: null })).toEqual({ decide: false, showResult: false, showProvenance: false });
    expect(variantActions({ status: "rejected", sha256: SHA })).toMatchObject({ showResult: false, showProvenance: true });
  });

  it("lists the price first, then the adapter, model, licence and the rest of the provenance (IM-12)", () => {
    expect(provenanceRows(variant())).toEqual([
      { term: "Price", detail: "$0.08" },
      { term: "Made with", detail: "Test adapter (fake)" },
      { term: "Model", detail: "fake-matte-v1" },
      { term: "Licence", detail: "none: test double with no weights" },
      { term: "Workflow", detail: "fake:background_remove:v1" },
      { term: "Vendor job", detail: "fake-job-1" },
    ]);
    expect(provenanceRows(variant({ promptText: "Studio product photo background: slate" })))
      .toContainEqual({ term: "Prompt", detail: "Studio product photo background: slate" });
    expect(provenanceRows(variant({ adapter: null, modelId: null, modelLicense: null, workflowHash: null, providerJobId: null, priceMinor: 20 })))
      .toEqual([{ term: "Price", detail: "$0.20" }]);
  });

  it("names a swap by its background", () => {
    expect(variantTitle(variant())).toBe("Remove background");
    expect(variantTitle(variant({ preset: "studio_background_swap", params: { aspectRatio: "source", backgroundDescription: " Slate " } }))).toBe("Studio background: Slate");
  });
});

describe("generate request", () => {
  it("needs a photo, and a background description for a swap", () => {
    expect(generateRequest(null, "background_remove", "")).toEqual({ ok: false, why: "Upload or pick a photo first." });
    expect(generateRequest("p", "studio_background_swap", "   ")).toEqual({ ok: false, why: "Describe the background first." });
    expect(generateRequest("p", "studio_background_swap", "x".repeat(301))).toEqual({ ok: false, why: "Keep the background description to 300 characters." });
  });

  it("sends the source aspect ratio, and the trimmed description only for a swap", () => {
    expect(generateRequest("p", "upscale_2k", "ignored")).toEqual({ ok: true, request: { sourceAssetId: "p", preset: "upscale_2k", params: { aspectRatio: "source" } } });
    expect(generateRequest("p", "studio_background_swap", "  Linen  ")).toEqual({
      ok: true, request: { sourceAssetId: "p", preset: "studio_background_swap", params: { aspectRatio: "source", backgroundDescription: "Linen" } },
    });
  });

  it("refuses text Postgres cannot store", () => {
    expect(generateRequest("p", "studio_background_swap", "bad\u0000text").ok).toBe(false);
  });
});

describe("photo and edit lists", () => {
  it("shows uploads newest first, keeps the pick while it is listed, and edits per photo", () => {
    const older = { id: "a", origin: "upload", createdAt: "2026-10-01T00:00:00.000Z" };
    const newer = { id: "b", origin: "upload", createdAt: "2026-10-02T00:00:00.000Z" };
    const made = { id: "c", origin: "variant", createdAt: "2026-10-03T00:00:00.000Z" };
    const photos = uploadedPhotos([older, newer, made] as never);
    expect(photos.map((photo) => photo.id)).toEqual(["b", "a"]);
    expect(pickedPhoto(photos, "a")).toBe("a");
    expect(pickedPhoto(photos, "gone")).toBe("b");
    expect(pickedPhoto([], null)).toBeNull();
    // An upload whose bytes match an approved edit comes back as that edit's asset: it stays pickable.
    expect(uploadedPhotos([older, newer, made] as never, "c").map((photo) => photo.id)).toEqual(["c", "b", "a"]);
    const list = [variant({ id: "1", sourceAssetId: "a" }), variant({ id: "2", sourceAssetId: "b" })];
    expect(variantsOf(list, "a").map((item) => item.id)).toEqual(["1"]);
    expect(variantsOf(undefined, "a")).toEqual([]);
  });

  it("polls while an edit is being made or added to the library", () => {
    expect(imageWorkPending(undefined)).toBe(false);
    expect(imageWorkPending([variant({ status: "staged" }), variant({ status: "failed" })])).toBe(false);
    for (const status of ["queued", "running", "approved"] as const) expect(imageWorkPending([variant({ status })]), status).toBe(true);
  });
});

describe("demo media", () => {
  function demo(start = Date.parse("2026-10-24T10:00:00.000Z")) {
    let now = start;
    let id = 0;
    const media = createDemoMedia({ clock: { now: () => new Date(now) }, newId: () => `4d0f3a52-9b8c-4e7d-8f26-${String(++id).padStart(12, "0")}` });
    return { ...media, tick: (ms: number) => { now += ms; } };
  }
  const png = () => new Blob([TINY_PNG], { type: "image/png" });

  it("seeds a photo with an approved edit and one that failed", async () => {
    const { api } = demo();
    const [photo] = await api.listMediaAssets();
    expect(photo).toMatchObject({ id: DEMO_PHOTO_ASSET_ID, contentType: "image/png", width: 64, height: 48, origin: "upload" });
    const variants = await api.listImageVariants();
    expect(variants.map((item) => [item.status, item.failureReason])).toEqual([["failed", "matte_invalid"], ["promoted", null]]);
    const content = await api.getMediaAssetContent(DEMO_PHOTO_ASSET_ID);
    expect(content.type).toBe("image/png");
    expect(imageSize(new Uint8Array(await content.arrayBuffer()), "image/png")).toEqual({ width: 64, height: 48 });
  });

  it("uploads a PNG as an asset, once per key and once per content", async () => {
    const { api } = demo();
    const asset = await api.uploadMediaAsset(png(), { idempotencyKey: "k-up" });
    expect(asset).toMatchObject({ contentType: "image/png", byteLength: TINY_PNG.byteLength, width: 2, height: 1, origin: "upload" });
    expect(await api.uploadMediaAsset(png(), { idempotencyKey: "k-up" })).toEqual(asset);
    expect((await api.uploadMediaAsset(png(), { idempotencyKey: "k-again" })).id).toBe(asset.id);
    expect((await api.listMediaAssets()).filter((item) => item.id === asset.id)).toHaveLength(1);
    const bytes = new Uint8Array(await (await api.getMediaAssetContent(asset.id)).arrayBuffer());
    expect(bytes).toEqual(TINY_PNG);
  });

  it("refuses a file that is not a PNG, JPEG or WebP, or whose header does not read", async () => {
    const { api } = demo();
    await expect(api.uploadMediaAsset(new Blob(["<svg/>"], { type: "image/svg+xml" }), { idempotencyKey: "k1" })).rejects.toMatchObject({ kind: "validation", message: "Upload a PNG, JPEG or WebP photo." });
    await expect(api.uploadMediaAsset(new Blob(["not a png"], { type: "image/png" }), { idempotencyKey: "k2" })).rejects.toMatchObject({ kind: "validation" });
  });

  it("moves a variant from queued to running to staged by the clock, with provenance and a price", async () => {
    const { api, tick } = demo();
    const asset = await api.uploadMediaAsset(png(), { idempotencyKey: "k-up" });
    const made = await api.generateImageVariant({ sourceAssetId: asset.id, preset: "background_remove", params: {} }, { idempotencyKey: "k-gen" });
    expect(made).toMatchObject({ status: "queued", sha256: null, adapter: null, priceMinor: 8, currency: "usd", params: { aspectRatio: "source" } });
    await expect(api.getImageVariantContent(made.id)).rejects.toMatchObject({ kind: "not_found" });
    tick(QUEUED_MS);
    expect((await api.getImageVariant(made.id)).status).toBe("running");
    tick(STAGED_MS - QUEUED_MS);
    const staged = await api.getImageVariant(made.id);
    expect(staged).toMatchObject({ status: "staged", adapter: "fake", modelId: "fake-matte-v1", modelLicense: "none: test double with no weights" });
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(staged.expiresAt!) - Date.parse(staged.stagedAt!)).toBe(14 * 86_400_000);
    expect((await api.getImageVariantContent(made.id)).type).toBe("image/png");
    // The same key and body replays the first answer.
    expect((await api.generateImageVariant({ sourceAssetId: asset.id, preset: "background_remove", params: {} }, { idempotencyKey: "k-gen" })).id).toBe(made.id);
  });

  it("needs a background description for a swap and keeps its prompt", async () => {
    const { api, tick } = demo();
    await expect(api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "studio_background_swap", params: {} }, { idempotencyKey: "k1" }))
      .rejects.toMatchObject({ kind: "validation" });
    await expect(api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "upscale_2k", params: { modelId: "x" } }, { idempotencyKey: "k2" }))
      .rejects.toMatchObject({ kind: "validation" });
    const made = await api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "studio_background_swap", params: { backgroundDescription: "Slate" } }, { idempotencyKey: "k3" });
    tick(STAGED_MS);
    expect(await api.getImageVariant(made.id)).toMatchObject({ status: "staged", priceMinor: 20, promptText: "Studio product photo background: Slate" });
  });

  it("approves through a stored approval, then promotes", async () => {
    const { api, tick } = demo();
    const made = await api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "background_remove", params: {} }, { idempotencyKey: "k-gen" });
    await expect(api.requestVariantApproval({ variantId: made.id, sha256: SHA }, { idempotencyKey: "k-early" })).rejects.toMatchObject({ reason: "variant_not_staged" });
    tick(STAGED_MS);
    const staged = await api.getImageVariant(made.id);
    await expect(api.requestVariantApproval({ variantId: made.id, sha256: SHA }, { idempotencyKey: "k-wrong" })).rejects.toMatchObject({ reason: "variant_changed" });
    const approval = await api.requestVariantApproval({ variantId: made.id, sha256: staged.sha256! }, { idempotencyKey: "k-req" });
    expect(approval).toMatchObject({ actionType: "media.variant.approve", status: "pending", target: { type: "media_variant", id: made.id }, payload: { variantId: made.id, sha256: staged.sha256 } });
    expect((await api.requestVariantApproval({ variantId: made.id, sha256: staged.sha256! }, { idempotencyKey: "k-req" })).id).toBe(approval.id);
    const answer = await api.approveApproval(approval.id, { idempotencyKey: "k-ok" });
    expect(answer.approval.result).toMatchObject({ id: approval.id, status: "approved", executedActionId: answer.execution.actionId });
    expect(answer.execution.result).toMatchObject({ id: made.id, status: "approved" });
    // A retry with the same key replays; a new key on a decided approval is a conflict.
    expect(await api.approveApproval(approval.id, { idempotencyKey: "k-ok" })).toEqual(answer);
    await expect(api.approveApproval(approval.id, { idempotencyKey: "k-twice" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(api.rejectImageVariant({ variantId: made.id, sha256: staged.sha256! }, { idempotencyKey: "k-rej" })).rejects.toMatchObject({ reason: "variant_not_staged" });
    tick(PROMOTE_MS);
    expect((await api.getImageVariant(made.id)).status).toBe("promoted");
    expect((await api.getImageVariantContent(made.id)).size).toBeGreaterThan(0);
  });

  it("rejects a staged variant once, and a repeat answers it unchanged", async () => {
    const { api, tick } = demo();
    const made = await api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "upscale_2k", params: {} }, { idempotencyKey: "k-gen" });
    tick(STAGED_MS);
    const { sha256 } = await api.getImageVariant(made.id);
    await expect(api.rejectImageVariant({ variantId: made.id, sha256: SHA }, { idempotencyKey: "k-bad" })).rejects.toMatchObject({ reason: "variant_changed" });
    const rejected = await api.rejectImageVariant({ variantId: made.id, sha256: sha256! }, { idempotencyKey: "k-rej" });
    expect(rejected).toMatchObject({ status: "rejected", rejectedAt: "2026-10-24T10:00:02.400Z" });
    expect(await api.rejectImageVariant({ variantId: made.id, sha256: sha256! }, { idempotencyKey: "k-rej-2" })).toEqual(rejected);
    await expect(api.getImageVariantContent(made.id)).rejects.toMatchObject({ kind: "not_found" });
    await expect(api.requestVariantApproval({ variantId: made.id, sha256: sha256! }, { idempotencyKey: "k-req" })).rejects.toMatchObject({ reason: "variant_not_staged" });
  });

  it("fails the next job with the reason asked for, and answers not found for unknown IDs", async () => {
    const { api, controls, tick } = demo();
    controls.failNextImageJob("insufficient_funds");
    const made = await api.generateImageVariant({ sourceAssetId: DEMO_PHOTO_ASSET_ID, preset: "background_remove", params: {} }, { idempotencyKey: "k-gen" });
    tick(STAGED_MS);
    expect(await api.getImageVariant(made.id)).toMatchObject({ status: "failed", failureReason: "insufficient_funds", sha256: null });
    const missing = await api.getImageVariant("4d0f3a52-9b8c-4e7d-8f26-999999999999").catch((error: unknown) => error);
    expect(isApiError(missing, "not_found")).toBe(true);
    await expect(api.generateImageVariant({ sourceAssetId: "4d0f3a52-9b8c-4e7d-8f26-999999999999", preset: "upscale_2k", params: {} }, { idempotencyKey: "k-x" }))
      .rejects.toMatchObject({ kind: "not_found" });
  });

  it("reads JPEG and WebP sizes from their headers", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 64, height: 48 });
    const webp = new Uint8Array(30);
    webp.set([...new TextEncoder().encode("RIFF")], 0);
    webp.set([...new TextEncoder().encode("WEBPVP8X")], 8);
    webp.set([63, 0, 0, 47, 0, 0], 24);
    expect(imageSize(webp, "image/webp")).toEqual({ width: 64, height: 48 });
    expect(imageSize(jpeg, "image/png")).toBeNull();
  });
});

describe("images section", () => {
  it("shows a staged edit with its provenance and both decisions, and a failure in plain words", () => {
    const photo = {
      id: DEMO_PHOTO_ASSET_ID, sha256: SHA, contentType: "image/png", byteLength: 100, width: 64, height: 48, origin: "upload",
      variantId: null, createdBy: "9a1b3c5d-7e9f-4a1b-8c2d-000000000001", createdAt: "2026-10-24T09:00:00.000Z",
    };
    const html = renderScreen(h(ImagesSection), {
      fill: (client) => {
        client.setQueryData(keys.mediaAssets, [photo]);
        client.setQueryData(keys.imageVariants, [
          variant({ id: "3c9e2f41-8a7b-4d6c-9e15-2a4b6c8d0f02", status: "failed", failureReason: "matte_invalid", sha256: null, adapter: null, modelId: null, modelLicense: null }),
          variant(),
        ]);
      },
    }).replaceAll("<!-- -->", "");
    expect(html).toContain("Ready to review");
    expect(html).toContain("Test adapter (fake)");
    expect(html).toContain("fake-matte-v1");
    expect(html).toContain("$0.08");
    expect(html).toMatch(/Approve<span class="sr-only"> the edit: Remove background<\/span>/);
    expect(html).toMatch(/Reject<span class="sr-only"> the edit: Remove background<\/span>/);
    expect(html).toContain(FAILURE_MESSAGES.matte_invalid);
    expect(html.match(/>Approve</g) ?? []).toHaveLength(1);
  });

  it("says when image editing is not set up", async () => {
    const { failQuery } = await import("./helpers/render");
    const { ApiError } = await import("../src/lib/api/errors");
    const html = renderScreen(h(ImagesSection), { fill: (client) => failQuery(client, keys.mediaAssets, new ApiError("not_found", "Not found", 404, "NotFound")) });
    expect(html).toContain("Image editing is not switched on yet");
  });
});
