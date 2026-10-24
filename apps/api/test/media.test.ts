// Image routes (image-port.md IM-22, IM-23; second slice acceptance test 1) over HTTP with the fake
// port, an injected clock and two tenants. The worker runs between requests, as the server's would.
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  approvalOutputSchema,
  approveApprovalResponseSchema,
  imageVariantOutputSchema,
  imageVariantSchema,
  MEDIA_LIMITS,
  mediaAssetOutputSchema,
  mediaAssetSchema,
  mediaObjectKeys,
} from "@zs/contracts";
import {
  createFakeImageWorkflowPort,
  createImageWorker,
  createLocalStubSessionCheck,
  createMemorySiteStore,
  creditWallet,
  parseImageConfig,
  type FakeImageWorkflowPort,
} from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { createApp, createHs256Verifier } from "../src/app.js";
import { call, createApiHarness, NOW, SECRET, signedInMember, type ApiHarness, type TenantSetup } from "./helpers.js";

const START = Date.parse(NOW);
let now = START;
const clock = { now: () => new Date(now) };
const store = createMemorySiteStore();
const config = parseImageConfig({ environment: "test", adapter: "fake" });
let port: FakeImageWorkflowPort;

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ clock, images: { store, config } });
  // Tenant A has money; tenant B's wallet stays empty.
  await service((tx) => creditWallet(tx, {
    tenantId: h.a.tenantId, ledgerId: randomUUID(), amount: 1_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START),
  }));
});
afterAll(async () => { await h?.close(); });
beforeEach(() => {
  now = START;
  port = createFakeImageWorkflowPort();
});

const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(h.database.servicePool, work);
const runWorker = () => createImageWorker({ service, db: h.database.db, store, port, config, clock, generateId: randomUUID }).runOnce();
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
/** An 8-bit RGBA PNG; `noise` makes it incompressible, so its size is about 4 bytes a pixel. */
function photo(seed: number, size = 24, noise = false): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let state = seed * 2654435761 >>> 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const p = y * size + x;
      const at = y * (size * 4 + 1) + 1 + x * 4;
      state = (state * 1103515245 + 12345) >>> 0;
      raw[at] = noise ? state >>> 24 : (p * 7 + seed * 13) & 0xff;
      raw[at + 1] = noise ? (state >>> 16) & 0xff : (p * 3 + seed * 5 + 40) & 0xff;
      raw[at + 2] = noise ? (state >>> 8) & 0xff : (p * 11 + seed) & 0xff;
      raw[at + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: noise ? 0 : 6 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}
let seed = 1;

async function uploadRaw(app: typeof h.app, token: string, bytes: Uint8Array<ArrayBuffer>, type = "image/png", key: string = randomUUID()) {
  const response = await app.request("/v1/media/assets", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key, "Content-Type": type }, body: bytes,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function upload(tenant: TenantSetup = h.a, bytes = photo(seed++)) {
  const response = await uploadRaw(h.app, tenant.token, bytes);
  expect(response.status).toBe(201);
  return mediaAssetOutputSchema.parse(response.body).result;
}
const swap = (sourceAssetId: string, backgroundDescription = `marble ${seed++}`) =>
  ({ sourceAssetId, preset: "studio_background_swap", params: { backgroundDescription } });
async function generate(body: object, tenant: TenantSetup = h.a, key = randomUUID()) {
  const response = await call(h.app, "POST", "/v1/media/variants", { token: tenant.token, key, body });
  expect(response.status).toBe(201);
  return imageVariantOutputSchema.parse(response.body).result;
}
const getVariant = async (id: string, tenant: TenantSetup = h.a) =>
  imageVariantSchema.parse((await call(h.app, "GET", `/v1/media/variants/${id}`, { token: tenant.token })).body);
async function staged(tenant: TenantSetup = h.a) {
  const source = await upload(tenant);
  const queued = await generate({ sourceAssetId: source.id, preset: "background_remove" }, tenant);
  await runWorker();
  const variant = await getVariant(queued.id, tenant);
  expect(variant.status).toBe("staged");
  return { source, variant };
}
const content = (path: string, token: string) =>
  h.app.request(path, { headers: { Authorization: `Bearer ${token}` } });

describe("acceptance test 1 (IM-22)", () => {
  it("uploads, generates, stages, shows, approves and promotes a ring photo over HTTP", async () => {
    // Upload: the raw bytes are the body; the same bytes again are the same asset.
    const ring = photo(900);
    const first = await uploadRaw(h.app, h.a.token, ring);
    expect(first.status).toBe(201);
    const asset = mediaAssetOutputSchema.parse(first.body).result;
    expect(asset).toMatchObject({ contentType: "image/png", width: 24, height: 24, origin: "upload", byteLength: ring.byteLength });
    expect(mediaAssetOutputSchema.parse((await uploadRaw(h.app, h.a.token, ring)).body).result.id).toBe(asset.id);
    const assetContent = await content(`/v1/media/assets/${asset.id}/content`, h.a.token);
    expect(assetContent.status).toBe(200);
    expect(Buffer.from(await assetContent.arrayBuffer()).equals(Buffer.from(ring))).toBe(true);
    expect(assetContent.headers.get("Content-Type")).toBe("image/png");

    // Generate only queues: no reservation, no vendor call (IM-7).
    const queued = await generate(swap(asset.id, "warm marble"));
    expect(queued).toMatchObject({ status: "queued", priceMinor: 20, currency: "usd", sourceAssetId: asset.id });
    expect(port.calls).toHaveLength(0);
    expect((await call(h.app, "GET", `/v1/media/variants/${queued.id}/content`, { token: h.a.token })).status).toBe(404);

    // The worker stages it; the status check and the staged bytes follow.
    await runWorker();
    expect(port.calls).toHaveLength(1);
    const variant = await getVariant(queued.id);
    expect(variant).toMatchObject({ status: "staged", adapter: "fake", promptText: "Studio product photo background: warm marble" });
    const shown = await content(`/v1/media/variants/${queued.id}/content`, h.a.token);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Cache-Control")).toBe("private, no-store");
    expect(shown.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(shown.headers.get("Content-Type")).toBe("image/png");
    const bytes = Buffer.from(await shown.arrayBuffer());
    expect(bytes.equals(Buffer.from((await store.get(mediaObjectKeys.staging(h.a.tenantId, queued.id, variant.sha256!)))!.body))).toBe(true);
    const listed = await call(h.app, "GET", "/v1/media/variants", { token: h.a.token });
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(queued.id);

    // Request, then an owner approves; promotion makes it an asset.
    const requested = await call(h.app, "POST", `/v1/media/variants/${queued.id}/approval`, {
      token: h.a.token, key: randomUUID(), body: { sha256: variant.sha256 },
    });
    expect(requested.status).toBe(201);
    const approval = approvalOutputSchema.parse(requested.body).result;
    expect(approval).toMatchObject({ status: "pending", actionType: "media.variant.approve", payload: { variantId: queued.id, sha256: variant.sha256 } });
    const approved = await call(h.app, "POST", `/v1/approvals/${approval.id}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status).toBe(200);
    expect(approveApprovalResponseSchema.parse(approved.body).execution.result).toMatchObject({ status: "approved" });
    await runWorker();
    expect(await getVariant(queued.id)).toMatchObject({ status: "promoted", promotedAt: new Date(START).toISOString() });
    const assets = (await call(h.app, "GET", "/v1/media/assets", { token: h.a.token })).body.items.map((item: unknown) => mediaAssetSchema.parse(item));
    expect(assets.find((item: { sha256: string }) => item.sha256 === variant.sha256)).toMatchObject({ origin: "variant", variantId: queued.id });
    // A promoted variant still shows its bytes.
    expect((await content(`/v1/media/variants/${queued.id}/content`, h.a.token)).status).toBe(200);
  });

  it("answers NotFound to tenant B for A's asset, variant and content", async () => {
    const { source, variant } = await staged();
    for (const path of [
      `/v1/media/assets/${source.id}/content`, `/v1/media/variants/${variant.id}`, `/v1/media/variants/${variant.id}/content`,
    ]) {
      const response = await call(h.app, "GET", path, { token: h.b.token });
      expect(response.status, path).toBe(404);
      expect(errorOf(response).code).toBe("NotFound");
    }
    for (const path of [`/v1/media/variants/${variant.id}/approval`, `/v1/media/variants/${variant.id}/reject`]) {
      const response = await call(h.app, "POST", path, { token: h.b.token, key: randomUUID(), body: { sha256: variant.sha256 } });
      expect(response.status, path).toBe(404);
    }
    const generated = await call(h.app, "POST", "/v1/media/variants", {
      token: h.b.token, key: randomUUID(), body: { sourceAssetId: source.id, preset: "background_remove" },
    });
    expect(generated.status).toBe(404);
    expect((await call(h.app, "GET", "/v1/media/variants", { token: h.b.token })).body.items.map((item: { id: string }) => item.id))
      .not.toContain(variant.id);
    expect((await getVariant(variant.id)).status).toBe("staged");
  });

  it("is Forbidden to a member without publish", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const { source, variant } = await staged();
    expect((await uploadRaw(h.app, staff.token, photo(seed++))).status).toBe(403);
    for (const [method, path, body] of [
      ["GET", "/v1/media/assets", undefined], ["GET", `/v1/media/assets/${source.id}/content`, undefined],
      ["GET", "/v1/media/variants", undefined], ["GET", `/v1/media/variants/${variant.id}`, undefined],
      ["GET", `/v1/media/variants/${variant.id}/content`, undefined],
      ["POST", "/v1/media/variants", { sourceAssetId: source.id, preset: "background_remove" }],
      ["POST", `/v1/media/variants/${variant.id}/approval`, { sha256: variant.sha256 }],
      ["POST", `/v1/media/variants/${variant.id}/reject`, { sha256: variant.sha256 }],
    ] as const) {
      const response = await call(h.app, method, path, { token: staff.token, ...(body ? { body, key: randomUUID() } : {}) });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(errorOf(response).code).toBe("Forbidden");
    }
  });

  it("refuses a model ID in params with 400 and replays a repeated key", async () => {
    const source = await upload();
    const refused = await call(h.app, "POST", "/v1/media/variants", {
      token: h.a.token, key: randomUUID(),
      body: { sourceAssetId: source.id, preset: "studio_background_swap", params: { backgroundDescription: "slate", modelId: "flux-1-dev" } },
    });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).code).toBe("ValidationFailed");
    const key = randomUUID();
    const body = { sourceAssetId: source.id, preset: "upscale_2k" };
    const first = await generate(body, h.a, key);
    const second = await generate(body, h.a, key);
    expect(second.id).toBe(first.id);
    expect((await call(h.app, "GET", "/v1/media/variants", { token: h.a.token })).body.items
      .filter((item: { id: string }) => item.id === first.id)).toHaveLength(1);
  });

  it("fails insufficient_funds with an empty wallet and never calls the port", async () => {
    // Earlier tests leave jobs queued: finish them first, so this port sees only B's job.
    await runWorker();
    port = createFakeImageWorkflowPort();
    const source = await upload(h.b);
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove" }, h.b);
    await runWorker();
    expect(await getVariant(queued.id, h.b)).toMatchObject({ status: "failed", failureReason: "insufficient_funds" });
    expect(port.calls).toHaveLength(0);
  });

  it("rejects a staged variant (IM-23)", async () => {
    const { variant } = await staged();
    const wrong = await call(h.app, "POST", `/v1/media/variants/${variant.id}/reject`, {
      token: h.a.token, key: randomUUID(), body: { sha256: "0".repeat(64) },
    });
    expect(wrong.status).toBe(409);
    expect(errorOf(wrong)).toMatchObject({ code: "Conflict", details: { reason: "variant_changed" } });
    now = START + 5_000;
    const rejected = await call(h.app, "POST", `/v1/media/variants/${variant.id}/reject`, {
      token: h.a.token, key: randomUUID(), body: { sha256: variant.sha256 },
    });
    expect(rejected.status).toBe(200);
    expect(imageVariantOutputSchema.parse(rejected.body).result).toMatchObject({ status: "rejected", rejectedAt: new Date(START + 5_000).toISOString() });
    expect((await call(h.app, "GET", `/v1/media/variants/${variant.id}/content`, { token: h.a.token })).status).toBe(404);
    const late = await call(h.app, "POST", `/v1/media/variants/${variant.id}/approval`, {
      token: h.a.token, key: randomUUID(), body: { sha256: variant.sha256 },
    });
    expect(errorOf(late)).toMatchObject({ code: "Conflict", details: { reason: "variant_not_staged" } });
    await runWorker();
    expect(await store.head(mediaObjectKeys.staging(h.a.tenantId, variant.id, variant.sha256!))).toBeNull();
  });
});

describe("route edges (IM-3, IM-21, IM-22)", () => {
  it("takes an upload larger than the JSON limit and keeps 64 KiB everywhere else", async () => {
    const big = photo(seed++, 160, true);
    expect(big.byteLength).toBeGreaterThan(64 * 1024);
    expect((await uploadRaw(h.app, h.a.token, big)).status).toBe(201);
    const json = await call(h.app, "POST", "/v1/media/variants", {
      token: h.a.token, key: randomUUID(), body: { sourceAssetId: randomUUID(), preset: "background_remove", pad: "x".repeat(70 * 1024) },
    });
    expect(json.status).toBe(413);
    const tooBig = await uploadRaw(h.app, h.a.token, new Uint8Array(MEDIA_LIMITS.fileBytes + 1));
    expect(tooBig.status).toBe(413);
    expect(errorOf(tooBig).code).toBe("ValidationFailed");
  });

  it("refuses a type outside IM-3's list or bytes that do not match it", async () => {
    expect((await uploadRaw(h.app, h.a.token, photo(seed++), "image/svg+xml")).status).toBe(400);
    expect((await uploadRaw(h.app, h.a.token, photo(seed++), "image/jpeg")).status).toBe(400);
    expect((await uploadRaw(h.app, h.a.token, new TextEncoder().encode("<svg/>"), "image/png")).status).toBe(400);
    expect((await uploadRaw(h.app, h.a.token, photo(seed++), "image/png", "")).status).toBe(400);
  });

  it("needs a signed-in member", async () => {
    const response = await h.app.request("/v1/media/assets", { method: "POST", headers: { "Content-Type": "image/png" }, body: photo(seed++) });
    expect(response.status).toBe(401);
  });

  it("is 404 when images are off, with the 64 KiB limit kept on the upload path", async () => {
    const off = createApp({
      verifier: createHs256Verifier(SECRET, { clock }), sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
      clock, db: h.database.db, generateId: randomUUID, config: { allowedOrigins: [] },
    });
    expect((await uploadRaw(off, h.a.token, photo(seed++))).status).toBe(404);
    expect((await uploadRaw(off, h.a.token, photo(seed++, 160, true))).status).toBe(413);
    expect((await call(off, "GET", "/v1/media/variants", { token: h.a.token })).status).toBe(404);
  });
});
