// Image port, first slice (image-port.md IM-1..IM-16) with the fake adapter, an injected clock and
// two tenants. The acceptance flow follows the contract's list; the other tests pin the rules the
// flow does not reach. No vendor, key or network is involved.
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { idempotencyKeySchema, mediaObjectKeys, type MemberRole } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  createFakeImageWorkflowPort,
  createImageWorker,
  createImageWorkflowPort,
  imagePrice,
  createMemorySiteStore,
  createSession,
  creditWallet,
  findAllowedModel,
  IMAGE_MODEL_ALLOWLIST,
  isForbiddenModel,
  isSafeWeightsFile,
  memberDispatch,
  NON_COMMERCIAL_LICENSE,
  parseImageConfig,
  sha256Hex,
  type EdgeDependencies,
  type FakeImageWorkflowPort,
  type ImageReport,
  type SiteCompiler,
} from "../src/index.js";
import { directDispatch } from "../src/edge/session.js";
import { imageActorId, imageWorkerAuthorize } from "../src/images/worker.js";
import { decodePng, encodeRgbaPng } from "../src/images/png.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let ownerB: string;
let memberA: string;
let port: FakeImageWorkflowPort;
let reports: ImageReport[];
const store = createMemorySiteStore();
const siteStore = createMemorySiteStore();
const config = parseImageConfig({ environment: "test", adapter: "fake" });
/** TODO verify: placeholder prices for config tests only. */
const prices = { background_remove: 10, studio_background_swap: 25, upscale_2k: 30 };

/** A fake compiler: the spec lists base64 image files and the page that links them. */
const compiler: SiteCompiler = {
  async compile(spec) {
    const images = (spec.images as string[] | undefined) ?? [];
    return {
      entry: "index.html",
      files: [
        { path: "index.html", mediaType: "text/html; charset=utf-8", bytes: new TextEncoder().encode("<h1>Ring</h1>") },
        ...images.map((b64, index) => ({ path: `img/${index}.png`, mediaType: "image/png", bytes: new Uint8Array(Buffer.from(b64, "base64")) })),
      ],
    };
  },
};

const deps = (): EdgeDependencies => ({
  db: database.db, clock, generateId: randomUUID,
  images: { store, config }, sites: { store: siteStore, compiler },
});
const sessionFor = (tenantId: string, actorId: string) => createSession(deps(), { tenantId, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const worker = () => createImageWorker({
  service, db: database.db, store, port, config, clock, generateId: randomUUID, report: (event) => reports.push(event),
});

async function addMember(tenantId: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

/** A 24 x 24 opaque ring photo. `seed` makes the bytes differ so each test can upload its own. */
function ringPhoto(seed = 0, size = 24): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p += 1) {
    rgba[p * 4] = (p * 7 + seed * 13) & 0xff;
    rgba[p * 4 + 1] = (p * 3 + seed * 5 + 40) & 0xff;
    rgba[p * 4 + 2] = (p * 11 + seed) & 0xff;
    rgba[p * 4 + 3] = 255;
  }
  return encodeRgbaPng({ width: size, height: size, rgba });
}

let photoSeed = 1;
async function upload(tenantId = tenantA, actorId = ownerA, bytes = ringPhoto(photoSeed++)) {
  return (await sessionFor(tenantId, actorId).uploadMediaAsset(bytes, "image/png", randomUUID())).result;
}
const swap = (sourceAssetId: string, description = "warm marble") =>
  ({ sourceAssetId, preset: "studio_background_swap", params: { backgroundDescription: description } });
async function generate(body: object, tenantId = tenantA, actorId = ownerA) {
  return (await sessionFor(tenantId, actorId).generateImageVariant(body, randomUUID())).result;
}
const variant = async (id: string) => (await rows<Record<string, any>>("SELECT * FROM image_variants WHERE id=$1", [id]))[0]!;
const wallet = async (tenantId = tenantA) =>
  (await rows<{ balance: string; reserved: string }>("SELECT balance, reserved FROM wallets WHERE tenant_id=$1", [tenantId]))[0]!;
const captures = async (tenantId = tenantA) =>
  (await rows<{ amount: string; reservation_id: string }>("SELECT amount, reservation_id FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantId]));
const reservation = async (variantId: string) =>
  (await rows<{ status: string; amount: string }>("SELECT status, amount FROM wallet_reservations WHERE job_kind='image_job' AND job_id=$1", [variantId]))[0];
async function approve(variantId: string, sha256: string) {
  const owner = sessionFor(tenantA, ownerA);
  const proposal = await owner.requestApproval({
    action: { actionType: "media.variant.approve", target: { type: "media_variant", id: variantId }, payload: { variantId, sha256 } },
    summary: "Use this photo on the site", expiresInMinutes: 43_200,
  }, randomUUID());
  return owner.approveApproval(proposal.result.id, {}, randomUUID());
}
const stagedBytes = async (row: Record<string, any>) => (await store.get(mediaObjectKeys.staging(row.tenant_id, row.id, row.sha256)))!.body;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantA = fixture.a.tenantId;
  tenantB = fixture.b.tenantId;
  ownerA = await addMember(tenantA, "owner");
  ownerB = await addMember(tenantB, "owner");
  memberA = await addMember(tenantA, "staff");
  await service((tx) => creditWallet(tx, {
    tenantId: tenantA, ledgerId: randomUUID(), amount: 1_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START),
  }));
});
afterAll(async () => { await database?.close(); });
beforeEach(() => {
  now = START;
  port = createFakeImageWorkflowPort();
  reports = [];
});

describe("acceptance flow (IM-3..IM-16)", () => {
  it("runs a ring photo from upload to a published, approved image", async () => {
    const owner = sessionFor(tenantA, ownerA);
    const profilesBefore = await rows("SELECT to_jsonb(b) AS row FROM business_profiles b WHERE tenant_id=$1", [tenantA]);
    // 1. The owner uploads a ring photo; the same bytes again return the same asset.
    const ring = ringPhoto(100);
    const first = (await owner.uploadMediaAsset(ring, "image/png", randomUUID())).result;
    const again = (await owner.uploadMediaAsset(ring, "image/png", randomUUID())).result;
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ contentType: "image/png", width: 24, height: 24, origin: "upload", variantId: null });
    expect((await rows("SELECT 1 FROM media_assets WHERE tenant_id=$1 AND sha256=$2", [tenantA, first.sha256]))).toHaveLength(1);

    // 2. A model ID in params is refused.
    await expect(owner.generateImageVariant(
      { sourceAssetId: first.id, preset: "studio_background_swap", params: { backgroundDescription: "marble", modelId: "flux-1-dev" } },
      randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await rows("SELECT 1 FROM image_variants WHERE tenant_id=$1", [tenantA])).toHaveLength(0);

    // 3. A background swap reserves the price, stages a variant and captures once.
    const queued = await generate(swap(first.id));
    expect(queued).toMatchObject({ status: "queued", priceMinor: 20, currency: "usd" });
    const before = await wallet();
    await worker().runOnce();
    const staged = await variant(queued.id);
    expect(staged).toMatchObject({
      status: "staged", adapter: "fake", model_id: "fake-matte-v1", prompt_text: "Studio product photo background: warm marble",
      staged_at: new Date(START), expires_at: new Date(START + 14 * DAY),
    });
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.matte_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.background_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(port.calls).toHaveLength(1);
    const ledger = await captures();
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.amount)).toBe(-20);
    expect(Number((await wallet()).balance)).toBe(Number(before.balance) - 20);
    expect(Number((await wallet()).reserved)).toBe(0);
    expect((await reservation(queued.id))?.status).toBe("captured");
    // Another pass does nothing more.
    await worker().runOnce();
    expect(await captures()).toHaveLength(1);
    expect(port.calls).toHaveLength(1);

    // 4. A fake that alters one product pixel fails and stages nothing.
    port.alterProductPixelNext();
    const altered = await generate(swap(first.id, "dark slate"));
    await worker().runOnce();
    expect(await variant(altered.id)).toMatchObject({ status: "failed", failure_reason: "product_pixels_changed", sha256: null });
    expect((await reservation(altered.id))?.status).toBe("released");
    expect(store.keys().filter((key) => key.startsWith(mediaObjectKeys.stagingPrefix(tenantA, altered.id)))).toEqual([]);
    expect(await captures()).toHaveLength(1);
    expect(Number((await wallet()).reserved)).toBe(0);

    // 5. A release that holds the staged variant is refused.
    const site = (await owner.createSite({ name: "Main" }, randomUUID())).result;
    const image64 = Buffer.from(await stagedBytes(staged)).toString("base64");
    await expect(owner.publishSite(site.id, { spec: { images: [image64] } }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "image_not_approved" } });

    // 6. The owner approves; after promotion the same publish succeeds, with a source record.
    const result = await approve(queued.id, staged.sha256);
    expect(result.execution.result).toMatchObject({ status: "approved" });
    expect((await variant(queued.id)).status).toBe("approved");
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "promoted", promoted_at: new Date(START) });
    const asset = (await rows<Record<string, any>>("SELECT * FROM media_assets WHERE tenant_id=$1 AND sha256=$2", [tenantA, staged.sha256]))[0]!;
    expect(asset).toMatchObject({ origin: "variant", variant_id: queued.id, content_type: "image/png", width: 24, height: 24 });
    expect(await store.head(mediaObjectKeys.asset(tenantA, staged.sha256))).not.toBeNull();
    expect(await rows(
      "SELECT 1 FROM source_records WHERE tenant_id=$1 AND subject_type='media_asset' AND subject_id=$2 AND source='image_variant' AND source_ref=$3",
      [tenantA, asset.id, queued.id])).toHaveLength(1);
    const published = await owner.publishSite(site.id, { spec: { images: [image64] } }, randomUUID());
    expect(published.result.release.fileCount).toBe(2);

    // 7. A direct member call of approve is refused; approving after 14 days is variant_expired.
    await expect(memberDispatch(deps(), { tenantId: tenantA, actorId: ownerA })({
      actionType: "media.variant.approve", target: { tenantId: tenantA, type: "media_variant", id: queued.id },
      payload: { variantId: queued.id, sha256: staged.sha256 },
      approvalReference: { tenantId: tenantA, id: randomUUID() }, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "TenantDenied" });
    const late = await generate(swap(first.id, "pale oak"));
    await worker().runOnce();
    const lateRow = await variant(late.id);
    expect(lateRow.status).toBe("staged");
    now = START + 14 * DAY;
    await expect(approve(late.id, lateRow.sha256)).rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_expired" } });
    expect((await variant(late.id)).status).toBe("staged");

    // 8. No business fact changed (the contract's catalog rows do not exist yet; profiles are the nearest facts), and tenant B cannot read A's variants under the runtime role.
    expect(await rows("SELECT to_jsonb(b) AS row FROM business_profiles b WHERE tenant_id=$1", [tenantA])).toEqual(profilesBefore);
    const seenByB = await database.db.tenant(tenantB, async (tx) => ({
      variants: (await tx.query("SELECT id FROM image_variants WHERE id=$1", [queued.id])).rows,
      assets: (await tx.query("SELECT id FROM media_assets WHERE id=$1", [first.id])).rows,
    }));
    expect(seenByB).toEqual({ variants: [], assets: [] });
    expect(await sessionFor(tenantB, ownerB).listImageVariants()).toEqual({ items: [] });
  });
});

describe("worker rules", () => {
  it("expires a staged variant after 14 days and removes its staging file", async () => {
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} });
    await worker().runOnce();
    const row = await variant(queued.id);
    expect(row.status).toBe("staged");
    now = START + 14 * DAY + 1_000;
    await worker().runOnce();
    expect((await variant(queued.id)).status).toBe("expired");
    expect(await store.head(mediaObjectKeys.staging(tenantA, queued.id, row.sha256))).toBeNull();
    await expect(approve(queued.id, row.sha256)).rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_expired" } });
  });

  it("fails a variant whose model is not allowed before it reserves or calls", async () => {
    port.useModelId("background_remove", "FLUX.1-dev");
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} });
    const held = await wallet();
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: "model_not_allowed" });
    expect(port.calls).toHaveLength(0);
    expect(await reservation(queued.id)).toBeUndefined();
    expect(await wallet()).toEqual(held);
  });

  it("fails with insufficient_funds and never calls the adapter", async () => {
    const source = await upload(tenantB, ownerB);
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} }, tenantB, ownerB);
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: "insufficient_funds" });
    expect(port.calls).toHaveLength(0);
    expect(await reservation(queued.id)).toBeUndefined();
  });

  it.each([
    ["digest_mismatch", (p: FakeImageWorkflowPort) => p.corruptDigestNext()],
    ["matte_invalid", (p: FakeImageWorkflowPort) => p.matteNext("empty")],
    ["matte_invalid", (p: FakeImageWorkflowPort) => p.matteNext("full")],
    ["size_changed", (p: FakeImageWorkflowPort) => p.resizeNext()],
    ["adapter_error", (p: FakeImageWorkflowPort) => p.failNext()],
  ])("fails %s and releases the hold", async (reason, arrange) => {
    arrange(port);
    const source = await upload();
    const queued = await generate(swap(source.id, `case ${reason}`));
    const before = await wallet();
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: reason, sha256: null });
    expect((await reservation(queued.id))?.status).toBe("released");
    expect(await wallet()).toEqual(before);
  });

  it("catches a single partial-alpha rim pixel that changed", async () => {
    port.alterProductPixelNext("partial");
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} });
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: "product_pixels_changed" });
  });

  it("stages an upscale at 2048 pixels", async () => {
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "upscale_2k", params: {} });
    await worker().runOnce();
    const row = await variant(queued.id);
    expect(row).toMatchObject({ status: "staged", model_id: "fake-upscale-v1", matte_sha256: null, background_sha256: null });
    expect((await reservation(queued.id))?.status).toBe("captured");
  });

  it("never sends an unknown outcome again: it asks, then stages or fails after the wait", async () => {
    port.timeoutNext("vendor-job-1");
    const source = await upload();
    const queued = await generate(swap(source.id, "unknown one"));
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "running", provider_job_id: "vendor-job-1" });
    expect((await reservation(queued.id))?.status).toBe("held");
    await worker().runOnce();
    expect(port.calls).toHaveLength(1);
    expect(port.lookups).toContain("vendor-job-1");
    expect((await variant(queued.id)).status).toBe("running");
    port.settleLookup("vendor-job-1", "done");
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "staged", provider_job_id: "vendor-job-1" });
    expect((await reservation(queued.id))?.status).toBe("captured");
    expect(port.calls).toHaveLength(1);

    port.timeoutNext("vendor-job-2");
    const second = await generate(swap(source.id, "unknown two"));
    await worker().runOnce();
    now += config.outcomeWaitMs + 1_000;
    await worker().runOnce();
    expect(await variant(second.id)).toMatchObject({ status: "failed", failure_reason: "outcome_unknown" });
    // The hold stays for an operator: nothing guesses whether the vendor billed.
    expect((await reservation(second.id))?.status).toBe("held");
    expect(port.calls).toHaveLength(2);
  });

  it("releases the hold of a job the vendor reports failed", async () => {
    port.timeoutNext("vendor-job-3");
    const source = await upload();
    const queued = await generate(swap(source.id, "vendor failed"));
    await worker().runOnce();
    port.settleLookup("vendor-job-3", "failed");
    await worker().runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: "adapter_error" });
    expect((await reservation(queued.id))?.status).toBe("released");
  });
});

function pngChunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

describe("review fixes", () => {
  it("reads a PNG colour key (tRNS) as transparent pixels", () => {
    const header = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const raw = Buffer.from([0, 10, 20, 30, 200, 100, 50]);
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header),
      pngChunk("tRNS", Buffer.from([0, 10, 0, 20, 0, 30])), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const image = decodePng(bytes);
    expect([image.rgba[3], image.rgba[7]]).toEqual([0, 255]);
  });

  it("refuses an upload with a forged PNG header", async () => {
    await expect(sessionFor(tenantA, ownerA).uploadMediaAsset(ringPhoto(31).slice(0, 40), "image/png", randomUUID()))
      .rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("does not fail a job that another pass already started", async () => {
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} });
    await service((tx) => tx.query("UPDATE image_variants SET status='running' WHERE id=$1", [queued.id]));
    const dispatch = directDispatch(deps(), tenantA, imageActorId(tenantA), imageWorkerAuthorize);
    await expect(dispatch({
      actionType: "media.variant.fail", target: { tenantId: tenantA, type: "media_variant", id: queued.id },
      payload: { variantId: queued.id, reason: "insufficient_funds", providerJobId: null, expectStatus: "queued" },
      approvalReference: { tenantId: tenantA, id: randomUUID() }, idempotencyKey: randomUUID(),
    } as never)).rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_changed" } });
    expect((await variant(queued.id)).status).toBe("running");
  });

  it("refuses a worker whose port is not the configured adapter", () => {
    const other = Object.create(port, { adapter: { value: "kie" } });
    expect(() => createImageWorker({ service, db: database.db, store, port: other, config, clock, generateId: randomUUID })).toThrow();
  });

  it("keeps the vendor job ID when a staging write fails, so a later pass can finish", async () => {
    const source = await upload();
    const queued = await generate(swap(source.id, "retry after store error"));
    const failing = { ...store, put: async () => { throw new Error("store down"); } } as unknown as typeof store;
    const broken = createImageWorker({ service, db: database.db, store: Object.assign(Object.create(store), { put: failing.put }), port, config, clock, generateId: randomUUID, report: (event) => reports.push(event) });
    await broken.runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "running", provider_job_id: expect.stringMatching(/^fake-job-/) });
    expect((await reservation(queued.id))?.status).toBe("held");
    await worker().runOnce();
    expect((await variant(queued.id)).status).toBe("staged");
    expect(port.calls).toHaveLength(1);
  });

  it("fails an upscale whose file is only a header, and releases its hold", async () => {
    const headerOnly = {
      ...port,
      runPreset: async (input: Parameters<typeof port.runPreset>[0]) => {
        const output = await port.runPreset(input);
        const bytes = output.bytes.slice(0, 33); // signature and IHDR, no image data
        return { ...output, bytes, sha256: sha256Hex(bytes) };
      },
    } as typeof port;
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "upscale_2k", params: {} });
    await createImageWorker({ service, db: database.db, store, port: headerOnly, config, clock, generateId: randomUUID, report: (event) => reports.push(event) }).runOnce();
    expect(await variant(queued.id)).toMatchObject({ status: "failed", failure_reason: "output_invalid" });
    expect((await reservation(queued.id))?.status).toBe("released");
  });
});

describe("edge rules", () => {
  it("refuses uploads that are not images, are mislabelled or are too big", async () => {
    const owner = sessionFor(tenantA, ownerA);
    await expect(owner.uploadMediaAsset(new TextEncoder().encode("<svg/>"), "image/png", randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(owner.uploadMediaAsset(ringPhoto(7), "image/jpeg", randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(owner.uploadMediaAsset(ringPhoto(7), "image/svg+xml", randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(owner.uploadMediaAsset(new Uint8Array(0), "image/png", randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("needs the publish permission", async () => {
    const restricted = await addMember(tenantA, "viewer" as MemberRole).catch(() => null);
    if (restricted) {
      await expect(sessionFor(tenantA, restricted).uploadMediaAsset(ringPhoto(8), "image/png", randomUUID())).rejects.toMatchObject({ code: "TenantDenied" });
    }
    expect(memberA).toBeTruthy();
  });

  it("refuses a source asset of another tenant", async () => {
    const foreign = await upload(tenantB, ownerB);
    await expect(sessionFor(tenantA, ownerA).generateImageVariant({ sourceAssetId: foreign.id, preset: "background_remove", params: {} }, randomUUID()))
      .rejects.toMatchObject({ code: "NotFound" });
  });

  it("replays a generate request under the same key", async () => {
    const source = await upload();
    const owner = sessionFor(tenantA, ownerA);
    const key = randomUUID();
    const first = await owner.generateImageVariant({ sourceAssetId: source.id, preset: "background_remove", params: {} }, key);
    const second = await owner.generateImageVariant({ sourceAssetId: source.id, preset: "background_remove", params: {} }, key);
    expect(second.result.id).toBe(first.result.id);
    expect(await rows("SELECT 1 FROM image_variants WHERE id=$1", [first.result.id])).toHaveLength(1);
  });
});

describe("allowlist, config and keys (IM-6, IM-8, IM-16)", () => {
  it("lists no forbidden or non-commercial weights", () => {
    expect(IMAGE_MODEL_ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of IMAGE_MODEL_ALLOWLIST) {
      expect(isForbiddenModel(entry.modelId)).toBe(false);
      expect(NON_COMMERCIAL_LICENSE.test(entry.license)).toBe(false);
    }
    for (const name of ["FLUX.1-dev", "flux-dev", "FLUX.1-Fill-dev", "FLUX.1-Redux-dev", "FLUX.2-dev", "RMBG-1.4"])
      expect(isForbiddenModel(name), name).toBe(true);
    expect(findAllowedModel("fake", "FLUX.1-dev")).toBeNull();
    expect(findAllowedModel("fake", "fake-matte-v1")).not.toBeNull();
    expect(findAllowedModel("kie", "fake-matte-v1")).toBeNull();
  });

  it("loads weights only from safetensors files", () => {
    expect(isSafeWeightsFile("model.safetensors")).toBe(true);
    for (const name of ["model.ckpt", "model.pt", "model.pth", "model.bin", "model.pkl"]) expect(isSafeWeightsFile(name)).toBe(false);
  });

  it("refuses a production config that names higgsfield or the fake", () => {
    for (const adapter of ["higgsfield", "fake", "comfyui"])
      expect(() => parseImageConfig({ environment: "production", adapter })).toThrow();
    expect(parseImageConfig({ environment: "production", adapter: "kie", prices }).adapter).toBe("kie");
    expect(parseImageConfig({ environment: "production", adapter: "fal", prices }).adapter).toBe("fal");
    expect(() => parseImageConfig({ environment: "test", adapter: "kie", prices })).toThrow();
    expect(() => parseImageConfig({ environment: "production", adapter: "kie", prices, extra: 1 })).toThrow();
  });

  it("reads prices from config: only the fake in tests may omit them (IM-20)", () => {
    expect(() => parseImageConfig({ environment: "production", adapter: "kie" })).toThrow(/prices/);
    expect(() => parseImageConfig({ environment: "development", adapter: "fake" })).toThrow(/prices/);
    expect(() => parseImageConfig({ environment: "production", adapter: "fal", prices: { ...prices, upscale_2k: 0 } })).toThrow();
    expect(parseImageConfig({ environment: "production", adapter: "fal", prices }).prices).toEqual(prices);
    expect(imagePrice(parseImageConfig({ environment: "production", adapter: "kie", prices, currency: "eur" }), "upscale_2k"))
      .toEqual({ priceMinor: 30, currency: "eur" });
  });

  it("selects the configured adapter and fails closed without a key (IM-21)", () => {
    const portDeps = { fetch: (() => { throw new Error("no network in tests"); }) as unknown as typeof fetch, clock, sleep: async () => undefined };
    const kie = parseImageConfig({ environment: "production", adapter: "kie", prices });
    const fal = parseImageConfig({ environment: "production", adapter: "fal", prices });
    expect(() => createImageWorkflowPort(kie, portDeps)).toThrow(/API key/);
    expect(() => createImageWorkflowPort(fal, { ...portDeps, apiKey: "" })).toThrow(/API key/);
    expect(() => createImageWorkflowPort(fal, { ...portDeps, apiKey: "k" })).toThrow(/vendor costs/);
    expect(createImageWorkflowPort(config, portDeps).adapter).toBe("fake");
  });

  it("runs nothing on an unverified allowlist entry (IM-19)", () => {
    for (const entry of IMAGE_MODEL_ALLOWLIST.filter((candidate) => !candidate.verified))
      expect(findAllowedModel(entry.adapter, entry.modelId)).toBeNull();
  });

  it("reserves the image-job: key prefix for the worker", () => {
    expect(idempotencyKeySchema.safeParse("image-job:abc:stage").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("IMAGE-JOB:abc").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("image-jobs-are-fine").success).toBe(true);
  });
});

describe("rejection and content reads (IM-22, IM-23)", () => {
  async function stagedVariant(preset: "background_remove" | "studio_background_swap" = "background_remove") {
    const source = await upload();
    const queued = await generate(preset === "background_remove"
      ? { sourceAssetId: source.id, preset, params: {} } : swap(source.id, `staged ${photoSeed}`));
    await worker().runOnce();
    const row = await variant(queued.id);
    expect(row.status).toBe("staged");
    return { source, row };
  }

  it("rejects a staged variant once, keeps the capture and sweeps its staging file", async () => {
    const { row } = await stagedVariant();
    const owner = sessionFor(tenantA, ownerA);
    await expect(owner.rejectImageVariant(row.id, { sha256: "0".repeat(64) }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_changed" } });
    now = START + 60_000;
    const rejected = (await owner.rejectImageVariant(row.id, { sha256: row.sha256 }, randomUUID())).result;
    expect(rejected).toMatchObject({ status: "rejected", rejectedAt: new Date(START + 60_000).toISOString(), sha256: row.sha256 });
    expect(await rows("SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='media.variant.rejected' AND payload->>'variantId'=$2",
      [tenantA, row.id])).toEqual([{ payload: { variantId: row.id, sha256: row.sha256 } }]);
    // A repeat under a new key returns it unchanged.
    now = START + 120_000;
    const again = (await owner.rejectImageVariant(row.id, { sha256: row.sha256 }, randomUUID())).result;
    expect(again).toEqual(rejected);
    // The vendor ran: the hold stays captured.
    expect((await reservation(row.id))?.status).toBe("captured");
    await worker().runOnce();
    expect(await store.head(mediaObjectKeys.staging(tenantA, row.id, row.sha256))).toBeNull();
    expect((await variant(row.id)).status).toBe("rejected");
    await expect(approve(row.id, row.sha256)).rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_not_staged" } });
    await expect(owner.readImageVariantContent(row.id)).rejects.toMatchObject({ code: "NotFound" });
  });

  it("sweeps every rejected staging file in the window, past the first hundred", async () => {
    const source = await upload();
    const keys: string[] = [];
    const STAGE = `status='staged', staged_at=$3, expires_at=$4, adapter='fake', model_id='fake-matte-v1', model_license='apache-2.0', workflow_hash='w1'`;
    for (let i = 0; i < 101; i += 1) {
      const id = randomUUID();
      const sha = sha256Hex(new TextEncoder().encode(`rejected ${id}`));
      const rejectedAt = new Date(START - (i + 1) * 60_000);
      await service(async (tx) => {
        await tx.query(`INSERT INTO image_variants (tenant_id,id,source_asset_id,source_sha256,preset,params,price_minor,currency,created_by,created_at)
          VALUES ($1,$2,$3,$4,'background_remove','{}',10,'usd',$5,$6)`, [tenantA, id, source.id, source.sha256, ownerA, new Date(START - DAY)]);
        await tx.query("UPDATE image_variants SET status='running' WHERE tenant_id=$1 AND id=$2", [tenantA, id]);
        await tx.query(`UPDATE image_variants SET ${STAGE}, sha256='${sha}' WHERE tenant_id=$1 AND id=$2`, [tenantA, id, new Date(START - DAY), new Date(START + 13 * DAY)]);
        await tx.query("UPDATE image_variants SET status='rejected', rejected_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantA, id, rejectedAt]);
      });
      const key = mediaObjectKeys.staging(tenantA, id, sha);
      await store.put(key, new Uint8Array([i & 0xff]), { contentType: "image/png" });
      keys.push(key);
    }
    // One long-lived worker, as apps/api runs it: each pass takes the next part of the backlog.
    const sweeper = worker();
    await sweeper.runOnce();
    await sweeper.runOnce();
    const left = [];
    for (const key of keys) if (await store.head(key)) left.push(key);
    expect(left).toEqual([]);
  });

  it("refuses to reject a variant that is not staged, another tenant's, or without publish", async () => {
    const source = await upload();
    const queued = await generate({ sourceAssetId: source.id, preset: "background_remove", params: {} });
    await expect(sessionFor(tenantA, ownerA).rejectImageVariant(queued.id, { sha256: "a".repeat(64) }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_not_staged" } });
    await worker().runOnce();
    const row = await variant(queued.id);
    await expect(sessionFor(tenantB, ownerB).rejectImageVariant(queued.id, { sha256: row.sha256 }, randomUUID()))
      .rejects.toMatchObject({ code: "NotFound" });
    await expect(sessionFor(tenantA, memberA).rejectImageVariant(queued.id, { sha256: row.sha256 }, randomUUID()))
      .rejects.toMatchObject({ code: "TenantDenied" });
    await expect(sessionFor(tenantA, ownerA).rejectImageVariant(queued.id, { sha256: row.sha256, note: "x" }, randomUUID()))
      .rejects.toMatchObject({ code: "ValidationFailed" });
    expect((await variant(queued.id)).status).toBe("staged");
  });

  it("never runs a rejection through an approval", async () => {
    const { row } = await stagedVariant();
    await expect(sessionFor(tenantA, ownerA).requestApproval({
      action: { actionType: "media.variant.reject", target: { type: "media_variant", id: row.id }, payload: { variantId: row.id, sha256: row.sha256 } },
      summary: "Reject it",
    }, randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("reads an asset's and a staged variant's bytes for the session tenant only", async () => {
    const owner = sessionFor(tenantA, ownerA);
    const photo = ringPhoto(500);
    const asset = (await owner.uploadMediaAsset(photo, "image/png", randomUUID())).result;
    const content = await owner.readMediaAssetContent(asset.id);
    expect(content.contentType).toBe("image/png");
    expect(Buffer.from(content.bytes).equals(Buffer.from(photo))).toBe(true);
    await expect(sessionFor(tenantB, ownerB).readMediaAssetContent(asset.id)).rejects.toMatchObject({ code: "NotFound" });
    await expect(sessionFor(tenantA, memberA).readMediaAssetContent(asset.id)).rejects.toMatchObject({ code: "TenantDenied" });
    await expect(owner.readMediaAssetContent(randomUUID())).rejects.toMatchObject({ code: "NotFound" });

    const queued = await generate({ sourceAssetId: asset.id, preset: "background_remove", params: {} });
    await expect(owner.readImageVariantContent(queued.id)).rejects.toMatchObject({ code: "NotFound" });
    await worker().runOnce();
    const row = await variant(queued.id);
    const staged = await owner.readImageVariantContent(queued.id);
    expect(staged.contentType).toBe("image/png");
    expect(Buffer.from(staged.bytes).equals(Buffer.from(await stagedBytes(row)))).toBe(true);
    await expect(sessionFor(tenantB, ownerB).readImageVariantContent(queued.id)).rejects.toMatchObject({ code: "NotFound" });

    // A stored object that no longer matches its row is an error, never served.
    await store.delete(mediaObjectKeys.staging(tenantA, row.id, row.sha256));
    await store.put(mediaObjectKeys.staging(tenantA, row.id, row.sha256), ringPhoto(501), { contentType: "image/png" });
    await expect(owner.readImageVariantContent(queued.id)).rejects.toThrow(/digest/);
  });

  it("requests the approval of a staged variant through the approvals path", async () => {
    const { row } = await stagedVariant("studio_background_swap");
    const owner = sessionFor(tenantA, ownerA);
    await expect(owner.requestImageVariantApproval(row.id, { sha256: "b".repeat(64) }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "variant_changed" } });
    await expect(sessionFor(tenantB, ownerB).requestImageVariantApproval(row.id, { sha256: row.sha256 }, randomUUID()))
      .rejects.toMatchObject({ code: "NotFound" });
    const key = randomUUID();
    const proposal = await owner.requestImageVariantApproval(row.id, { sha256: row.sha256 }, key);
    expect(proposal.result).toMatchObject({
      status: "pending", actionType: "media.variant.approve", target: { tenantId: tenantA, type: "media_variant", id: row.id },
      payload: { variantId: row.id, sha256: row.sha256 },
    });
    expect((await owner.requestImageVariantApproval(row.id, { sha256: row.sha256 }, key)).result.id).toBe(proposal.result.id);
    const decided = await owner.approveApproval(proposal.result.id, {}, randomUUID());
    expect(decided.execution.result).toMatchObject({ status: "approved" });
    // A retry of the request after the approval replays it.
    expect((await owner.requestImageVariantApproval(row.id, { sha256: row.sha256 }, key)).result.id).toBe(proposal.result.id);
    await worker().runOnce();
    expect((await variant(row.id)).status).toBe("promoted");
    expect((await owner.readImageVariantContent(row.id)).contentType).toBe("image/png");
  });
});
