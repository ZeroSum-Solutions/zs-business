// The HTTP client's image routes (image-port.md IM-22): an upload is the raw bytes under their own
// type, image bytes come back as a Blob, every write carries the caller's key, and approving is
// the approval request followed by the approvals path's approve.
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const ASSET = "a1b2c3d4-1a3f-4b5c-9d7e-000000000002";
const VARIANT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000003";
const APPROVAL = "a1b2c3d4-1a3f-4b5c-9d7e-000000000004";
const TENANT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000005";
const USER = "a1b2c3d4-1a3f-4b5c-9d7e-000000000006";
const SHA = "b".repeat(64);
const AT = "2026-10-24T10:00:00.000Z";

interface Call { url: URL; init: RequestInit }

function client(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "/api",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const asset = {
  id: ASSET, sha256: SHA, contentType: "image/png", byteLength: 4, width: 1, height: 1, origin: "upload", variantId: null, createdBy: USER, createdAt: AT,
};
const variant = {
  id: VARIANT, sourceAssetId: ASSET, sourceSha256: SHA, preset: "background_remove", params: { aspectRatio: "source" }, status: "queued",
  failureReason: null, sha256: null, matteSha256: null, backgroundSha256: null, adapter: null, modelId: null, modelLicense: null,
  workflowHash: null, promptText: null, providerJobId: null, priceMinor: 8, currency: "usd", vendorCostMicros: null, createdBy: USER,
  createdAt: AT, stagedAt: null, expiresAt: null, approvedAt: null, promotedAt: null, rejectedAt: null,
};
const approval = {
  id: APPROVAL, tenantId: TENANT, actionType: "media.variant.approve", target: { tenantId: TENANT, type: "media_variant", id: VARIANT },
  payload: { variantId: VARIANT, sha256: SHA }, summary: "Approve an edited image", status: "pending", standing: "pending", requestedBy: USER,
  requestedAt: AT, expiresAt: AT, decidedBy: null, decidedAt: null, decisionNote: null, revokedBy: null, revokedAt: null, revokeNote: null, executedActionId: null,
};

describe("http client: media", () => {
  it("uploads the raw bytes with their own type and the caller's key", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: asset })]);
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    expect(await api.uploadMediaAsset(file, { idempotencyKey: "k-up" })).toEqual(asset);
    const call = calls[0]!;
    expect(call.url.pathname).toBe("/api/v1/media/assets");
    expect(call.init.method).toBe("POST");
    expect(headers(call)["Content-Type"]).toBe("image/png");
    expect(headers(call)["Idempotency-Key"]).toBe("k-up");
    expect(call.init.body).toBe(file);
  });

  it("refuses to upload without a key", async () => {
    const { api, calls } = client([]);
    await expect(api.uploadMediaAsset(new Blob(["x"], { type: "image/png" }), { idempotencyKey: "" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("lists assets and variants, and reads one variant", async () => {
    const { api, calls } = client([json(200, { items: [asset] }), json(200, { items: [variant] }), json(200, variant)]);
    expect(await api.listMediaAssets()).toEqual([asset]);
    expect(await api.listImageVariants()).toEqual([variant]);
    expect(await api.getImageVariant(VARIANT)).toEqual(variant);
    expect(calls.map((call) => [call.init.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/media/assets"], ["GET", "/api/v1/media/variants"], ["GET", `/api/v1/media/variants/${VARIANT}`],
    ]);
  });

  it("reads image bytes as a Blob with the API's type, and a 404 as not_found", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { api, calls } = client([
      new Response(bytes, { status: 200, headers: { "Content-Type": "image/webp" } }),
      json(404, { error: { code: "NotFound", message: "Not found", details: {} } }),
    ]);
    const blob = await api.getMediaAssetContent(ASSET);
    expect(blob.type).toBe("image/webp");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/media/assets/${ASSET}/content`);
    expect(headers(calls[0])["Accept"]).toContain("image/png");
    await expect(api.getImageVariantContent(VARIANT)).rejects.toMatchObject({ kind: "not_found" });
    expect(calls[1]!.url.pathname).toBe(`/api/v1/media/variants/${VARIANT}/content`);
  });

  it("generates with the preset and params only", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: variant })]);
    await api.generateImageVariant({ sourceAssetId: ASSET, preset: "studio_background_swap", params: { aspectRatio: "source", backgroundDescription: "Slate" } }, { idempotencyKey: "k-gen" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/media/variants");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sourceAssetId: ASSET, preset: "studio_background_swap", params: { aspectRatio: "source", backgroundDescription: "Slate" } });
    expect(headers(calls[0])["Idempotency-Key"]).toBe("k-gen");
  });

  it("asks for an approval with the digest, takes the envelope or the bare record, then approves it", async () => {
    const decided = { ...approval, status: "approved", standing: "approved", decidedBy: USER, decidedAt: AT, executedActionId: ACTION };
    const { api, calls } = client([
      json(201, { actionId: ACTION, result: approval }),
      json(201, approval),
      json(200, { approval: { actionId: ACTION, result: decided }, execution: { actionId: ACTION, result: { ...variant, status: "approved" } } }),
    ]);
    expect((await api.requestVariantApproval({ variantId: VARIANT, sha256: SHA }, { idempotencyKey: "k-req" })).id).toBe(APPROVAL);
    expect((await api.requestVariantApproval({ variantId: VARIANT, sha256: SHA }, { idempotencyKey: "k-req" })).id).toBe(APPROVAL);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/media/variants/${VARIANT}/approval`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sha256: SHA });
    const answer = await api.approveApproval(APPROVAL, { idempotencyKey: "k-ok" });
    expect(answer.approval.result.status).toBe("approved");
    expect(calls[2]!.url.pathname).toBe(`/api/v1/approvals/${APPROVAL}/approve`);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({});
    expect(headers(calls[2])["Idempotency-Key"]).toBe("k-ok");
  });

  it("rejects with the digest, and says why a conflict happened", async () => {
    const { api, calls } = client([
      json(200, { actionId: ACTION, result: { ...variant, status: "rejected", sha256: SHA, rejectedAt: AT } }),
      json(409, { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "variant_changed" } } }),
    ]);
    expect((await api.rejectImageVariant({ variantId: VARIANT, sha256: SHA }, { idempotencyKey: "k-rej" })).status).toBe("rejected");
    expect(calls[0]!.url.pathname).toBe(`/api/v1/media/variants/${VARIANT}/reject`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sha256: SHA });
    await expect(api.rejectImageVariant({ variantId: VARIANT, sha256: SHA }, { idempotencyKey: "k-rej-2" })).rejects.toMatchObject({
      kind: "conflict", reason: "variant_changed", message: "This image changed since you looked at it. Look at it again before you decide.",
    });
  });
});
