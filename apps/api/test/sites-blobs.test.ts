// hub-access.md H-16 and H-17 over HTTP: the content-addressed blob route for members and `sites:publish` tokens
// (X-16 to X-18), the blob reader a compile receives, the kind dispatch, and the daily publish limit (plans.md PL-25).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  automationTokenWithSecretSchema,
  siteBlobSchema,
  siteObjectKeys,
  siteOutputSchema,
  siteRecordSchema,
  sitePreviewSchema,
  siteReleaseListSchema,
  siteReleaseResponseSchema,
  SITE_LIMITS,
  ValidationFailed,
  type AutomationScope,
} from "@zs/contracts";
import { createKindSiteCompiler, createMemorySiteStore, plainSiteCompiler, type SiteCompiler } from "@zs/core";
import { signDevToken } from "../src/dev-token.js";
import { appOnDatabase, call, createApiHarness, NOW, SECRET, type ApiHarness, type TenantSetup } from "./helpers.js";

const encoder = new TextEncoder();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A picture the sniffer accepts: a PNG header followed by random bytes, so each call gives a new digest. */
function png(size = 64): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]);
  out.set(randomBytes(size - 24), 24);
  return out;
}

/** A stand-in for the `@mish/linkpage` adapter: it reads the blob its spec names and ships it as a file. */
const fakeLinkpage: SiteCompiler = {
  async compile(spec, { blobs }) {
    if (typeof spec.avatar !== "string") throw new ValidationFailed("A link page needs an avatar");
    const avatar = await blobs.read(spec.avatar);
    return {
      entry: "index.html",
      files: [
        { path: "index.html", mediaType: "text/html; charset=utf-8", bytes: encoder.encode(`<h1>${String(spec.title)}</h1>`) },
        { path: "avatar.bin", mediaType: "application/octet-stream", bytes: avatar },
      ],
    };
  },
};
const fakePublisher: SiteCompiler = {
  async compile(spec) {
    return { entry: "index.html", files: [{ path: "index.html", mediaType: "text/html; charset=utf-8", bytes: encoder.encode(`<p>${String(spec.recipe)}</p>`) }] };
  },
};

const memory = createMemorySiteStore();
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs) };
let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({
    clock, activepieces: {},
    sites: { store: memory, compiler: createKindSiteCompiler({ plain: plainSiteCompiler, publisher: fakePublisher, linkpage: fakeLinkpage }) },
  });
});
afterAll(async () => { await h?.close(); });
afterEach(() => { clockMs = Date.parse(NOW); });
const DAY = 24 * 3600 * 1000;

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const createSite = async (tenant: TenantSetup, name: string, token: string = tenant.token) => {
  const response = await call(h.app, "POST", "/v1/sites", { token, key: randomUUID(), body: { name } });
  return siteOutputSchema.parse(response.body).result;
};
const putRaw = (app: ApiHarness["app"], token: string, siteId: string, digest: string, body: Uint8Array, base = "/v1/sites", type = "application/octet-stream") =>
  app.request(`${base}/${siteId}/blobs/${digest}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body: body as Uint8Array<ArrayBuffer> });
const readJson = async (response: Response) => { const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null }; };
const member = async (tenant: TenantSetup, siteId: string, bytes: Uint8Array, digest = sha(bytes)) => readJson(await putRaw(h.app, tenant.token, siteId, digest, bytes));
async function mint(scopes: AutomationScope[], siteIds: string[], tenant: TenantSetup = h.a) {
  const response = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
    token: tenant.token, key: randomUUID(), body: { name: "Site agent", scopes, ...(scopes.includes("sites:publish") ? { siteIds } : {}) },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return automationTokenWithSecretSchema.parse(response.body);
}
const viaToken = async (secret: string, siteId: string, bytes: Uint8Array, digest = sha(bytes)) =>
  readJson(await putRaw(h.app, secret, siteId, digest, bytes, "/automation/v1/sites"));
const prefixed = (tenant: TenantSetup) => memory.keys().filter((key) => key.startsWith(`t/${tenant.tenantId}/`));
const blobKey = (tenant: TenantSetup, digest: string) => siteObjectKeys.blob(tenant.tenantId, digest);
const publishVia = (tenant: Pick<TenantSetup, "token">, siteId: string, spec: unknown, key: string = randomUUID()) =>
  call(h.app, "POST", `/v1/sites/${siteId}/releases`, { token: tenant.token, key, body: { spec } });
/** A member token valid at the test clock's current time (a token lives one hour, so a moved clock needs a new one). */
const nowToken = (tenant: TenantSetup) => signDevToken(SECRET, tenant, clock, 3600);
const publishAs = async (tenant: TenantSetup, siteId: string, spec: unknown, key: string = randomUUID()) =>
  publishVia({ token: await nowToken(tenant) }, siteId, spec, key);
const plain = (title: string) => ({ kind: "plain", title, sections: [] });

describe("PUT /v1/sites/:id/blobs/:sha256 (members)", () => {
  it("stores the bytes under the tenant prefix once and answers 201, then 200 without a second write", async () => {
    const site = await createSite(h.a, "Blobs");
    const bytes = png();
    const digest = sha(bytes);
    memory.resetLog();
    const first = await member(h.a, site.id, bytes);
    expect(first.status).toBe(201);
    expect(siteBlobSchema.parse(first.body)).toEqual({ sha256: digest, bytes: bytes.length, mediaType: "image/png", created: true });
    expect(memory.writes()).toEqual([blobKey(h.a, digest)]);
    expect((await memory.get(blobKey(h.a, digest)))?.body).toEqual(bytes);

    memory.resetLog();
    const again = await member(h.a, site.id, bytes);
    expect(again.status).toBe(200);
    expect(siteBlobSchema.parse(again.body)).toEqual({ sha256: digest, bytes: bytes.length, mediaType: "image/png", created: false });
    expect(memory.writes()).toEqual([]);
  });

  it("names the type from the bytes, never the Content-Type", async () => {
    const site = await createSite(h.a, "Types");
    const bytes = png();
    const response = await readJson(await putRaw(h.app, h.a.token, site.id, sha(bytes), bytes, "/v1/sites", "text/html"));
    expect(response.status).toBe(201);
    expect(siteBlobSchema.parse(response.body).mediaType).toBe("image/png");
    const gif = Uint8Array.from([...encoder.encode("GIF89a"), ...randomBytes(16)]);
    expect(siteBlobSchema.parse((await member(h.a, site.id, gif)).body).mediaType).toBe("image/gif");
  });

  it("X-18: bytes that do not hash to the path are a 400 and nothing is written", async () => {
    const site = await createSite(h.a, "Mismatch");
    const bytes = png();
    memory.resetLog();
    const before = memory.keys();
    const wrong = await member(h.a, site.id, bytes, sha(png()));
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).code).toBe("ValidationFailed");
    expect(memory.writes()).toEqual([]);
    expect(memory.keys()).toEqual(before);
  });

  it("refuses a bad digest, an empty body, a non-picture and an oversized body without touching the store", async () => {
    const site = await createSite(h.a, "Refusals");
    memory.resetLog();
    expect((await member(h.a, site.id, png(), "ABC")).status).toBe(400);
    expect((await member(h.a, site.id, png(), sha(png()).toUpperCase())).status).toBe(400);
    const empty = new Uint8Array(0);
    expect((await member(h.a, site.id, empty)).status).toBe(400);
    const text = encoder.encode("<svg onload=alert(1)/>");
    expect((await member(h.a, site.id, text)).status).toBe(400);
    const big = new Uint8Array(SITE_LIMITS.fileBytes + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await member(h.a, site.id, big)).status).toBe(413);
    expect(memory.writes()).toEqual([]);
    expect(memory.reads()).toEqual([]);
  });

  it("accepts a picture of exactly the release file limit", async () => {
    const site = await createSite(h.a, "Edge");
    const bytes = png(SITE_LIMITS.fileBytes);
    const response = await member(h.a, site.id, bytes);
    expect(response.status).toBe(201);
    expect(siteBlobSchema.parse(response.body).bytes).toBe(SITE_LIMITS.fileBytes);
  });

  it("X-16: a site of another tenant is a 404 and no object is written", async () => {
    const theirs = await createSite(h.b, "B shop");
    const bytes = png();
    memory.resetLog();
    const response = await member(h.a, theirs.id, bytes);
    expect(response.status).toBe(404);
    expect(memory.writes()).toEqual([]);
    expect(memory.keys().some((key) => key.includes(sha(bytes)))).toBe(false);
    const unknown = await member(h.a, randomUUID(), bytes);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(response.body);
  });

  it("needs a signed-in member", async () => {
    const site = await createSite(h.a, "Auth");
    const bytes = png();
    const response = await h.app.request(`/v1/sites/${site.id}/blobs/${sha(bytes)}`, { method: "PUT", body: bytes as Uint8Array<ArrayBuffer> });
    expect(response.status).toBe(401);
    expect(memory.keys().some((key) => key.includes(sha(bytes)))).toBe(false);
  });
});

describe("PUT /automation/v1/sites/:siteId/blobs/:sha256 (sites:publish tokens)", () => {
  it("uploads for a named site: 201, then 200; the cache header is no-store", async () => {
    const site = await createSite(h.a, "Token blobs");
    const { secret } = await mint(["sites:publish"], [site.id]);
    const bytes = png();
    const first = await putRaw(h.app, secret, site.id, sha(bytes), bytes, "/automation/v1/sites");
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(siteBlobSchema.parse(await first.json())).toMatchObject({ created: true, mediaType: "image/png" });
    memory.resetLog();
    expect((await viaToken(secret, site.id, bytes)).status).toBe(200);
    expect(memory.writes()).toEqual([]);
  });

  it("X-16: a site the token does not name, or another tenant's, is a 404 with the same body and no object", async () => {
    const own = await createSite(h.a, "Named");
    const unnamed = await createSite(h.a, "Unnamed");
    const theirs = await createSite(h.b, "B shop");
    const { secret } = await mint(["sites:publish"], [own.id]);
    const bytes = png();
    memory.resetLog();
    const foreign = await viaToken(secret, theirs.id, bytes);
    const other = await viaToken(secret, unnamed.id, bytes);
    const nothing = await viaToken(secret, randomUUID(), bytes);
    expect([foreign.status, other.status, nothing.status]).toEqual([404, 404, 404]);
    expect(other.body).toEqual(foreign.body);
    expect(nothing.body).toEqual(foreign.body);
    expect(memory.writes()).toEqual([]);
    expect(memory.keys().some((key) => key.includes(sha(bytes)))).toBe(false);
  });

  it("X-18: a hash mismatch is a 400 and nothing is written", async () => {
    const site = await createSite(h.a, "Token mismatch");
    const { secret } = await mint(["sites:publish"], [site.id]);
    memory.resetLog();
    const response = await viaToken(secret, site.id, png(), sha(png()));
    expect(response.status).toBe(400);
    expect(memory.writes()).toEqual([]);
  });

  it("checks in the contract's order: tag 401, body 413, token row 401, scope 403, site 404, then the bytes 400", async () => {
    const site = await createSite(h.a, "Order");
    const propose = await mint(["contacts:read"], [site.id]);
    const { secret, token } = await mint(["sites:publish"], [site.id]);
    const big = new Uint8Array(SITE_LIMITS.fileBytes + 1);
    memory.resetLog();
    // A body over the cap is 413 before the token row is read; a forged tag is 401 first.
    expect((await viaToken(secret, site.id, big, sha(png()))).status).toBe(413);
    expect((await viaToken("zsap1_forged", site.id, big, sha(png()))).status).toBe(401);
    expect((await viaToken(propose.secret, site.id, png())).status).toBe(403);
    expect((await viaToken(secret, randomUUID(), png(), "nothex")).status).toBe(404);
    expect((await viaToken(secret, site.id, png(), "nothex")).status).toBe(400);
    expect(memory.writes()).toEqual([]);
    // A revoked token is 401 and writes nothing.
    await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${token.id}/revoke`, { token: h.a.token, key: randomUUID(), body: {} });
    expect((await viaToken(secret, site.id, png())).status).toBe(401);
    expect(memory.writes()).toEqual([]);
  });
});

describe("the blob reader and the site kinds (H-17)", () => {
  it("X-17: a spec naming a digest only another tenant holds fails like one nobody holds, and no read touches that prefix", async () => {
    const mine = await createSite(h.a, "Reader");
    const theirs = await createSite(h.b, "B reader");
    const secret = png();
    const digest = sha(secret);
    expect((await member(h.b, theirs.id, secret)).status).toBe(201);
    memory.resetLog();

    const named = await publishVia(h.a, mine.id, { kind: "linkpage", title: "Me", avatar: digest });
    expect(named.status).toBe(400);
    expect(errorOf(named).code).toBe("ValidationFailed");
    const nobody = await publishVia(h.a, mine.id, { kind: "linkpage", title: "Me", avatar: sha(png()) });
    expect(nobody.status).toBe(400);
    // The two answers are the same but for the digest each one names.
    const strip = (body: unknown) => JSON.stringify(body).replace(/[0-9a-f]{64}/g, "<digest>");
    expect(strip(nobody.body)).toBe(strip(named.body));
    const preview = await call(h.app, "POST", `/v1/sites/${mine.id}/preview`, { token: h.a.token, body: { spec: { kind: "linkpage", title: "Me", avatar: digest } } });
    expect(preview.status).toBe(400);

    expect(memory.reads()).toContain(blobKey(h.a, digest));
    expect(memory.reads().filter((key) => key.startsWith(`t/${h.b.tenantId}/`))).toEqual([]);
    expect(memory.writes()).toEqual([]);
    const untouched = siteRecordSchema.parse((await call(h.app, "GET", `/v1/sites/${mine.id}`, { token: h.a.token })).body);
    expect(untouched.currentReleaseId).toBeNull();
    expect(siteReleaseListSchema.parse((await call(h.app, "GET", `/v1/sites/${mine.id}/releases`, { token: h.a.token })).body).items).toEqual([]);
  });

  it("a digest that is not 64 lowercase hex characters never becomes a key: a path-like name is a 400 with no read", async () => {
    const mine = await createSite(h.a, "Traversal");
    memory.resetLog();
    for (const avatar of [`../${h.b.tenantId}/blobs/${sha(png())}`, `t/${h.b.tenantId}/blobs/${sha(png())}`, "", sha(png()).toUpperCase()]) {
      const response = await publishVia(h.a, mine.id, { kind: "linkpage", title: "Me", avatar });
      expect(response.status, avatar).toBe(400);
    }
    expect(memory.reads()).toEqual([]);
  });

  it("publishes once the tenant has uploaded the blob, serves its bytes and answers the same bytes for a token", async () => {
    const mine = await createSite(h.a, "Linkpage");
    const bytes = png(300);
    const digest = sha(bytes);
    expect((await member(h.a, mine.id, bytes)).status).toBe(201);
    const response = await publishVia(h.a, mine.id, { kind: "linkpage", title: "Me", avatar: digest });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const release = siteReleaseResponseSchema.parse(response.body).result.release;
    expect(memory.keys()).toContain(siteObjectKeys.blob(h.a.tenantId, digest));
    const preview = sitePreviewSchema.parse((await call(h.app, "POST", `/v1/sites/${mine.id}/preview`, {
      token: h.a.token, body: { spec: { kind: "linkpage", title: "Me", avatar: digest } },
    })).body);
    expect(preview.files.find((file) => file.path === "avatar.bin")).toMatchObject({ sha256: digest, bytes: 300 });
    expect(preview.digest).toBe(release.digest);
  });

  it("dispatches on kind: untagged goes to the publisher, plain to the plain compiler, anything else is a 400", async () => {
    const mine = await createSite(h.a, "Dispatch");
    const untagged = await publishVia(h.a, mine.id, { recipe: "from the publisher" });
    expect(untagged.status, JSON.stringify(untagged.body)).toBe(201);
    const preview = await call(h.app, "POST", `/v1/sites/${mine.id}/preview`, { token: h.a.token, body: { spec: { recipe: "x" } } });
    expect(sitePreviewSchema.parse(preview.body).entryHtml).toBe("<p>x</p>");
    expect((await publishVia(h.a, mine.id, plain("Plain"))).status).toBe(201);
    for (const kind of ["recipe", "", "Plain", 7, null, ["plain"], { kind: "plain" }]) {
      const response = await publishVia(h.a, mine.id, { kind, title: "x" });
      expect(response.status, JSON.stringify(kind)).toBe(400);
      expect(errorOf(response).code).toBe("ValidationFailed");
    }
  });

  it("answers 400 for linkpage until its adapter is wired, and for an untagged spec when no publisher is wired", async () => {
    const bare = appOnDatabase(h.database.db, { clock, sites: { store: memory, compiler: createKindSiteCompiler({ plain: plainSiteCompiler }) } });
    const mine = await createSite(h.a, "Unwired");
    const send = (spec: unknown) => call(bare, "POST", `/v1/sites/${mine.id}/releases`, { token: h.a.token, key: randomUUID(), body: { spec } });
    const linkpage = await send({ kind: "linkpage", title: "Me", avatar: sha(png()) });
    expect(linkpage.status).toBe(400);
    expect(JSON.stringify(linkpage.body)).toMatch(/not available/);
    expect((await send({ recipe: "x" })).status).toBe(400);
    expect((await send(plain("Still works"))).status).toBe(201);
  });
});

describe("the daily publish limit (PL-25)", () => {
  // Each test uses its own tenant and its own span of the clock; releases of an earlier test are older than a day.
  // The admin pool: the service role may not delete a plan row, and these tests reset the tenant's plan.
  const sql = (text: string, params: unknown[]) => h.database.pool.query(text, params);
  const clearPlan = (tenant: TenantSetup) => sql("DELETE FROM tenant_plans WHERE tenant_id=$1", [tenant.tenantId]);
  const freeTier = (tenant: TenantSetup) => sql(
    "INSERT INTO tenant_plans (tenant_id, free_tier, created_at, updated_at) VALUES ($1, true, now(), now()) ON CONFLICT (tenant_id) DO UPDATE SET free_tier=true, plan=NULL, plan_interval=NULL, status='none'",
    [tenant.tenantId]);
  const inWindow = async (tenant: TenantSetup) => (await sql(
    "SELECT count(*)::int AS used FROM site_releases WHERE tenant_id=$1 AND created_at > $2::timestamptz - interval '1 day'",
    [tenant.tenantId, new Date(clockMs)])).rows[0]!.used as number;

  it("lets a comped tenant publish without a limit, stops a free one at 20 in 24 hours, and follows the plan once it is paid or granted", async () => {
    const site = await createSite(h.b, "Busy");
    const keyed = randomUUID();
    const first = await publishAs(h.b, site.id, plain("Release 0"), keyed);
    expect(first.status).toBe(201);
    for (let n = 1; n < 20; n += 1) expect((await publishAs(h.b, site.id, plain(`Release ${n}`))).status).toBe(201);

    // Free: 20 used in the last day.
    await freeTier(h.b);
    memory.resetLog();
    const refused = await publishAs(h.b, site.id, plain("Release 20"));
    expect(refused.status).toBe(409);
    expect(errorOf(refused).details).toEqual({ reason: "plan_limit", resource: "sitePublishesPerDay", limit: 20, used: 20 });
    expect(memory.writes()).toEqual([]);

    // A replay of a release that exists is not a new publish; rolling back is not either.
    const firstRelease = siteReleaseResponseSchema.parse(first.body).result.release;
    const replay = await publishAs(h.b, site.id, plain("Release 0"), keyed);
    expect(replay.status).toBe(201);
    expect(siteReleaseResponseSchema.parse(replay.body).result.release.id).toBe(firstRelease.id);
    const back = await call(h.app, "POST", `/v1/sites/${site.id}/releases/${firstRelease.id}/activate`, {
      token: await nowToken(h.b), key: randomUUID(), body: { expectedCurrentReleaseId: siteRecordSchema.parse((await call(h.app, "GET", `/v1/sites/${site.id}`, { token: await nowToken(h.b) })).body).currentReleaseId },
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);

    // The same limit holds for a site token.
    const { secret } = await mint(["sites:publish"], [site.id], h.b);
    const viaSecret = await call(h.app, "POST", `/automation/v1/sites/${site.id}/releases`, {
      headers: { Authorization: `Bearer ${secret}` }, key: randomUUID(), body: { spec: plain("Release 20") },
    });
    expect(viaSecret.status).toBe(409);
    expect(errorOf(viaSecret).details).toMatchObject({ resource: "sitePublishesPerDay" });

    // The window rolls: the 20 releases are exactly a day old at +24h and no longer count.
    clockMs += DAY / 2;
    expect((await publishAs(h.b, site.id, plain("Release 20"))).status).toBe(409);
    clockMs += DAY / 2;
    expect((await publishAs(h.b, site.id, plain("Release 20"))).status).toBe(201);
    clockMs = Date.parse(NOW);

    // Paid plans have their own number; a grant outranks the free marker; a comped tenant has none.
    await sql("UPDATE tenant_plans SET free_tier=false, plan='solo', plan_interval='month', status='active' WHERE tenant_id=$1", [h.b.tenantId]);
    expect((await publishAs(h.b, site.id, plain("Release 21"))).status).toBe(201);
    await sql("UPDATE tenant_plans SET plan=NULL, plan_interval=NULL, status='none', free_tier=true WHERE tenant_id=$1", [h.b.tenantId]);
    expect((await publishAs(h.b, site.id, plain("Release 22"))).status).toBe(409);
    await sql("UPDATE tenant_plans SET granted_plan='pro', granted_until=NULL, grant_note='test', granted_at=now(), granted_by='test' WHERE tenant_id=$1", [h.b.tenantId]);
    expect((await publishAs(h.b, site.id, plain("Release 22"))).status).toBe(201);
    await clearPlan(h.b);
    expect((await publishAs(h.b, site.id, plain("Release 23"))).status).toBe(201);
  });

  it("counts a tenant's releases across its sites, and never another tenant's", async () => {
    const one = await createSite(h.a, "Count one");
    const two = await createSite(h.a, "Count two");
    clockMs = Date.parse(NOW) + 2 * DAY;
    try {
      expect(await inWindow(h.a)).toBe(0);
      for (let n = 0; n < 20; n += 1) expect((await publishAs(h.a, n % 2 ? one.id : two.id, plain(`A ${n}`))).status).toBe(201);
      await freeTier(h.a);
      expect((await publishAs(h.a, one.id, plain("Over"))).status).toBe(409);
      expect((await publishAs(h.a, two.id, plain("Over"))).status).toBe(409);
      // Tenant B is comped (no plan row) and has released more than 20 times in all: unaffected.
      const theirs = await createSite(h.b, "Unaffected", await nowToken(h.b));
      expect((await publishAs(h.b, theirs.id, plain("B"))).status).toBe(201);
    } finally {
      await clearPlan(h.a);
    }
  });

  it("two publishes racing for the last slot of two sites: one wins, one is refused", async () => {
    const one = await createSite(h.b, "Race one");
    const two = await createSite(h.b, "Race two");
    const filler = await createSite(h.b, "Race filler");
    clockMs = Date.parse(NOW) + 5 * DAY;
    try {
      expect(await inWindow(h.b)).toBe(0);
      for (let n = 0; n < 19; n += 1) expect((await publishAs(h.b, filler.id, plain(`Fill ${n}`))).status).toBe(201);
      await freeTier(h.b);
      const results = await Promise.all([publishAs(h.b, one.id, plain("Race A")), publishAs(h.b, two.id, plain("Race B"))]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(await inWindow(h.b)).toBe(20);
    } finally {
      await clearPlan(h.b);
    }
  });
});
