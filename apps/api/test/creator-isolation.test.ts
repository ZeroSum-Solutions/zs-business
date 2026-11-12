// creator identity spec X-8 to X-15 and X-35 over HTTP: a `sites:publish` token of creator A acts on A's named
// sites and on nothing else. Two tenants, a real database, the real routes and the real site store logic
// (in memory). hub-access.md H-13 to H-15. Fake data only: Halden & Rowe.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  automationTokenWithSecretSchema,
  automationWhoAmISchema,
  siteOutputSchema,
  siteReleaseListSchema,
  siteReleaseResponseSchema,
  type AutomationScope,
  type SiteObjectStore,
} from "@zs/contracts";
import { createMemorySiteStore, plainSiteCompiler } from "@zs/core";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { appOnDatabase, call, createApiHarness, NOW, type ApiHarness, type MemberSetup, type TenantSetup } from "./helpers.js";

const BASE = "/automation/v1/sites";
const ME = "/integrations/activepieces/v1/me";

const memory = createMemorySiteStore();
const store: SiteObjectStore = memory;
let h: ApiHarness;
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs) };
beforeAll(async () => { h = await createApiHarness({ clock, activepieces: {}, sites: { store, compiler: plainSiteCompiler } }); });
afterAll(async () => { await h?.close(); });

/** The per-tenant active-token limit (W-15): each test's tokens are revoked when it ends. */
const minted: { owner: MemberSetup; id: string }[] = [];
afterEach(async () => {
  clockMs = Date.parse(NOW);
  for (const { owner, id } of minted.splice(0))
    await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${id}/revoke`, { token: owner.token, key: randomUUID(), body: {} });
});

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const spec = (title: string) => ({ kind: "plain", title, sections: [{ heading: "Hours", body: "Mon to Fri" }] });
const createSite = async (tenant: TenantSetup, name: string) => {
  const response = await call(h.app, "POST", "/v1/sites", { token: tenant.token, key: randomUUID(), body: { name } });
  expect(response.status).toBe(201);
  return siteOutputSchema.parse(response.body).result;
};
/** A publish by the owner, so a site has a live release. */
const ownerPublish = async (tenant: TenantSetup, siteId: string, title: string) => {
  const response = await call(h.app, "POST", `/v1/sites/${siteId}/releases`, { token: tenant.token, key: randomUUID(), body: { spec: spec(title) } });
  expect(response.status).toBe(201);
  return siteReleaseResponseSchema.parse(response.body).result.release;
};
async function mint(owner: MemberSetup, scopes: AutomationScope[], siteIds: string[] = [], extra: { expiresInDays?: number } = {}) {
  const response = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
    token: owner.token, key: randomUUID(), body: { name: "Site agent", scopes, ...(siteIds.length > 0 ? { siteIds } : {}), ...extra },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const created = automationTokenWithSecretSchema.parse(response.body);
  minted.push({ owner, id: created.token.id });
  return created;
}
const tokenCall = (secret: string, method: string, path: string, options: { body?: unknown; key?: string } = {}) =>
  call(h.app, method, path, { headers: { Authorization: `Bearer ${secret}` }, ...(options.body === undefined ? {} : { body: options.body }), ...(options.key ? { key: options.key } : {}) });
const publishAs = (secret: string, siteId: string, title: string, extra: Record<string, unknown> = {}) =>
  tokenCall(secret, "POST", `${BASE}/${siteId}/releases`, { key: randomUUID(), body: { spec: spec(title), ...extra } });
const releasesOf = async (tenant: TenantSetup, siteId: string) =>
  siteReleaseListSchema.parse((await call(h.app, "GET", `/v1/sites/${siteId}/releases`, { token: tenant.token })).body).items;
const siteOf = async (tenant: TenantSetup, siteId: string) =>
  siteOutputSchema.shape.result.parse((await call(h.app, "GET", `/v1/sites/${siteId}`, { token: tenant.token })).body);
const keysOf = (tenant: TenantSetup) => memory.keys().filter((key) => key.startsWith(`t/${tenant.tenantId}/`)).sort();

/** The app's database with every statement logged, so a test can say what was (not) read. */
function recording() {
  const sqls: string[] = [];
  const wrap = (tx: Transaction): Transaction => ({
    query: ((sql: string, params?: unknown[]) => { sqls.push(sql); return tx.query(sql as never, params as never); }) as Transaction["query"],
  });
  const db: ScopedDatabase = {
    ...h.database.db,
    tenant: (tenantId, work, options) => h.database.db.tenant(tenantId, (tx) => work(wrap(tx)), options),
    withoutTenant: (work, options) => h.database.db.withoutTenant((tx) => work(wrap(tx)), options),
  };
  return { db, sqls };
}
/** SQL that touches the site tables (not the token's own allowlist table). */
const readsSiteRows = (sqls: readonly string[]) => sqls.filter((sql) => /\b(sites|site_releases|site_pointers|site_hosts)\b/i.test(sql));

describe("a token acts on A's named sites only (X-8 to X-12)", () => {
  it("X-8: A's token on B's site is the same 404 as an unknown ID", async () => {
    const siteA = await createSite(h.a, "A shop");
    const siteB = await createSite(h.b, "B shop");
    const { secret } = await mint(h.a, ["sites:publish"], [siteA.id]);
    const foreign = await tokenCall(secret, "GET", `${BASE}/${siteB.id}`);
    const unknown = await tokenCall(secret, "GET", `${BASE}/${randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    // The GET routes of a release list and a release answer the same.
    expect((await tokenCall(secret, "GET", `${BASE}/${siteB.id}/releases`)).body).toEqual(unknown.body);
    expect((await tokenCall(secret, "GET", `${BASE}/${siteB.id}/releases/${randomUUID()}`)).body).toEqual(unknown.body);
    // A's own site works.
    expect((await tokenCall(secret, "GET", `${BASE}/${siteA.id}`)).status).toBe(200);
  });

  it("X-9: A's token publishing to B's site is 404, B is unchanged and the store gets no write under B's prefix", async () => {
    const siteA = await createSite(h.a, "A shop");
    const siteB = await createSite(h.b, "B shop");
    await ownerPublish(h.b, siteB.id, "B original");
    const { secret } = await mint(h.a, ["sites:publish"], [siteA.id]);
    const keysBefore = keysOf(h.b);
    const releasesBefore = await releasesOf(h.b, siteB.id);
    const siteBefore = await siteOf(h.b, siteB.id);

    const response = await publishAs(secret, siteB.id, "Stolen");
    expect(response.status).toBe(404);
    expect(response.body).toEqual((await publishAs(secret, randomUUID(), "Stolen")).body);
    expect(keysOf(h.b)).toEqual(keysBefore);
    expect(await releasesOf(h.b, siteB.id)).toEqual(releasesBefore);
    expect(await siteOf(h.b, siteB.id)).toEqual(siteBefore);
  });

  it("X-10: activating B's release on A's site, from A's true current release, is the 404 of an unknown release", async () => {
    const siteA = await createSite(h.a, "A shop");
    const siteB = await createSite(h.b, "B shop");
    const current = await ownerPublish(h.a, siteA.id, "A live");
    const releaseB = await ownerPublish(h.b, siteB.id, "B live");
    const { secret } = await mint(h.a, ["sites:publish"], [siteA.id]);
    const activate = (releaseId: string, expected: string | null) =>
      tokenCall(secret, "POST", `${BASE}/${siteA.id}/releases/${releaseId}/activate`, { key: randomUUID(), body: { expectedCurrentReleaseId: expected } });

    const foreign = await activate(releaseB.id, current.id);
    const unknown = await activate(randomUUID(), current.id);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    // Without the true current release the answer is the stale 409, the same for any release ID.
    const stale = await activate(releaseB.id, null);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual((await activate(randomUUID(), null)).body);
    expect(await siteOf(h.a, siteA.id)).toMatchObject({ currentReleaseId: current.id });
    expect(await siteOf(h.b, siteB.id)).toMatchObject({ currentReleaseId: releaseB.id });
  });

  it("X-11: a site of A that the token does not name is 404 for publish, activate, preview and sync, and stays unchanged", async () => {
    const named = await createSite(h.a, "A named");
    const business = await createSite(h.a, "A business");
    const live = await ownerPublish(h.a, business.id, "Business live");
    const { secret } = await mint(h.a, ["sites:publish"], [named.id]);
    const before = await siteOf(h.a, business.id);
    const keysBefore = keysOf(h.a);

    const answers = [
      await publishAs(secret, business.id, "Not mine"),
      await tokenCall(secret, "POST", `${BASE}/${business.id}/releases/${live.id}/activate`, { key: randomUUID(), body: { expectedCurrentReleaseId: live.id } }),
      await tokenCall(secret, "POST", `${BASE}/${business.id}/preview`, { body: { spec: spec("Not mine") } }),
      await tokenCall(secret, "POST", `${BASE}/${business.id}/sync`),
      await tokenCall(secret, "GET", `${BASE}/${business.id}`),
      await tokenCall(secret, "GET", `${BASE}/${business.id}/releases`),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404]);
    const unknown = await tokenCall(secret, "POST", `${BASE}/${randomUUID()}/sync`);
    expect(answers[3]!.body).toEqual(unknown.body);
    expect(await siteOf(h.a, business.id)).toEqual(before);
    expect(await releasesOf(h.a, business.id)).toHaveLength(1);
    expect(keysOf(h.a)).toEqual(keysBefore);
  });

  it("X-12: a spec that sets the tenant, origin, trackBase or signup is 400, and nothing is recorded", async () => {
    const siteA = await createSite(h.a, "A shop");
    const { secret } = await mint(h.a, ["sites:publish"], [siteA.id]);
    const keysBefore = keysOf(h.a);
    const hostOfB = "https://b-shop.example.com";
    for (const extra of [
      { tenantId: h.b.tenantId }, { origin: hostOfB }, { trackBase: hostOfB }, { signup: `${hostOfB}/join` },
    ]) {
      const response = await tokenCall(secret, "POST", `${BASE}/${siteA.id}/releases`, { key: randomUUID(), body: { spec: { ...spec("Hostile"), ...extra } } });
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(errorOf(response).code).toBe("ValidationFailed");
      const preview = await tokenCall(secret, "POST", `${BASE}/${siteA.id}/preview`, { body: { spec: { ...spec("Hostile"), ...extra } } });
      expect(preview.status, JSON.stringify(extra)).toBe(400);
    }
    // The tenant also cannot ride beside the spec.
    expect((await publishAs(secret, siteA.id, "Hostile", { tenantId: h.b.tenantId })).status).toBe(400);
    expect(await releasesOf(h.a, siteA.id)).toEqual([]);
    expect(keysOf(h.a)).toEqual(keysBefore);
    expect(await siteOf(h.a, siteA.id)).toMatchObject({ currentReleaseId: null });
    // The same token still publishes a clean spec.
    expect((await publishAs(secret, siteA.id, "Clean")).status).toBe(201);
  });
});

describe("a token that stops working (X-13)", () => {
  it("X-13: a revoked token and an expired token are 401, and B's token still works", async () => {
    const siteA = await createSite(h.a, "A shop");
    const siteB = await createSite(h.b, "B shop");
    const revoked = await mint(h.a, ["sites:publish"], [siteA.id]);
    const shortLived = await mint(h.a, ["sites:publish"], [siteA.id], { expiresInDays: 1 });
    const other = await mint(h.b, ["sites:publish"], [siteB.id], { expiresInDays: 365 });
    expect((await tokenCall(revoked.secret, "GET", `${BASE}/${siteA.id}`)).status).toBe(200);

    const revoke = await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${revoked.token.id}/revoke`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(revoke.status).toBe(200);
    const afterRevoke = await tokenCall(revoked.secret, "GET", `${BASE}/${siteA.id}`);
    expect(afterRevoke.status).toBe(401);
    expect((await publishAs(revoked.secret, siteA.id, "After revoke")).status).toBe(401);
    expect((await tokenCall(other.secret, "GET", `${BASE}/${siteB.id}`)).status).toBe(200);

    expect((await tokenCall(shortLived.secret, "GET", `${BASE}/${siteA.id}`)).status).toBe(200);
    clockMs += 2 * 24 * 3600_000;
    const afterExpiry = await tokenCall(shortLived.secret, "GET", `${BASE}/${siteA.id}`);
    expect(afterExpiry.status).toBe(401);
    expect(afterExpiry.body).toEqual(afterRevoke.body);
    expect((await publishAs(shortLived.secret, siteA.id, "After expiry")).status).toBe(401);
    expect((await tokenCall(other.secret, "GET", `${BASE}/${siteB.id}`)).status).toBe(200);
    // Back in the owners' hour, A's site has no release: nothing was published after the revoke or the expiry.
    clockMs = Date.parse(NOW);
    expect(await releasesOf(h.a, siteA.id)).toEqual([]);
  });
});

describe("a token without the scope (X-14)", () => {
  it("X-14: a contacts:read token is 403 on every sites route, the same for A's site, B's site and a random ID, before any site row is read", async () => {
    const siteA = await createSite(h.a, "A shop");
    const siteB = await createSite(h.b, "B shop");
    const { secret } = await mint(h.a, ["contacts:read"]);
    const seen = recording();
    const app = appOnDatabase(seen.db, { clock, sites: { store, compiler: plainSiteCompiler } });
    const send = (method: string, path: string, body?: unknown) =>
      call(app, method, path, { headers: { Authorization: `Bearer ${secret}` }, ...(body === undefined ? {} : { body }), ...(method === "POST" && body !== undefined ? { key: randomUUID() } : {}) });
    const release = randomUUID();
    const routes = (siteId: string): [string, string, unknown?][] => [
      ["GET", `${BASE}/${siteId}`],
      ["POST", `${BASE}/${siteId}/preview`, { spec: spec("x") }],
      ["GET", `${BASE}/${siteId}/releases`],
      ["POST", `${BASE}/${siteId}/releases`, { spec: spec("x") }],
      ["GET", `${BASE}/${siteId}/releases/${release}`],
      ["POST", `${BASE}/${siteId}/releases/${release}/activate`, { expectedCurrentReleaseId: null }],
      ["POST", `${BASE}/${siteId}/sync`],
    ];
    const bodies: unknown[] = [];
    for (const siteId of [siteA.id, siteB.id, randomUUID(), "not-a-uuid"]) {
      for (const [method, path, body] of routes(siteId)) {
        const response = await send(method, path, body);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(errorOf(response).code).toBe("Forbidden");
        bodies.push(response.body);
      }
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(readsSiteRows(seen.sqls)).toEqual([]);
    expect(seen.sqls.some((sql) => /automation_tokens/i.test(sql))).toBe(true);
  });
});

describe("a tampered token (X-15)", () => {
  it("X-15: a token whose tenant bytes are B's is 401 and runs no database statement", async () => {
    const siteA = await createSite(h.a, "A shop");
    const { secret } = await mint(h.a, ["sites:publish"], [siteA.id]);
    const bytes = Buffer.from(secret.slice("zsap1_".length), "base64url");
    Buffer.from(h.b.tenantId.replaceAll("-", ""), "hex").copy(bytes, 0);
    const tampered = `zsap1_${bytes.toString("base64url")}`;
    expect(tampered).not.toBe(secret);

    const seen = recording();
    const app = appOnDatabase(seen.db, { clock, sites: { store, compiler: plainSiteCompiler } });
    const send = (method: string, path: string, body?: unknown) =>
      call(app, method, path, { headers: { Authorization: `Bearer ${tampered}` }, ...(body === undefined ? {} : { body }) });
    const responses = [
      await send("GET", `${BASE}/${siteA.id}`),
      await send("POST", `${BASE}/${siteA.id}/releases`, { spec: spec("x") }),
      await send("POST", `${BASE}/${siteA.id}/sync`),
    ];
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(seen.sqls).toEqual([]);
    expect(await releasesOf(h.a, siteA.id)).toEqual([]);
    // No header and a malformed one are the same 401.
    expect((await call(app, "GET", `${BASE}/${siteA.id}`)).status).toBe(401);
    expect(seen.sqls).toEqual([]);
  });
});

describe("what /me tells the flow (X-35)", () => {
  it("X-35: /me names the token's tenant and only the sites it names; a token without sites:publish gets none", async () => {
    const siteA = await createSite(h.a, "A shop");
    const second = await createSite(h.a, "A second shop");
    const siteB = await createSite(h.b, "B shop");
    const publisher = await mint(h.a, ["sites:publish"], [siteA.id, second.id]);
    const reader = await mint(h.a, ["contacts:read"]);
    const bToken = await mint(h.b, ["sites:publish"], [siteB.id]);

    const me = automationWhoAmISchema.parse((await tokenCall(publisher.secret, "GET", ME)).body);
    expect(me).toMatchObject({ tenantId: h.a.tenantId, tokenId: publisher.token.id, scopes: ["sites:publish"] });
    expect([...me.siteIds].sort()).toEqual([siteA.id, second.id].sort());
    expect(JSON.stringify(me)).not.toContain(siteB.id);
    expect(JSON.stringify(me)).not.toContain(h.b.tenantId);

    const none = automationWhoAmISchema.parse((await tokenCall(reader.secret, "GET", ME)).body);
    expect(none).toMatchObject({ tenantId: h.a.tenantId, siteIds: [] });

    const other = automationWhoAmISchema.parse((await tokenCall(bToken.secret, "GET", ME)).body);
    expect(other).toMatchObject({ tenantId: h.b.tenantId, siteIds: [siteB.id] });
  });
});
