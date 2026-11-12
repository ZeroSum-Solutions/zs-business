// hub-access.md H-15 over HTTP: what a `sites:publish` token does on its own site, the fixed check order,
// the quota and the body limit. The cross-creator cases (X-8 to X-15, X-35) are in creator-isolation.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  automationTokenWithSecretSchema,
  siteOutputSchema,
  siteReleaseDetailSchema,
  siteReleaseListSchema,
  siteReleaseResponseSchema,
  siteSyncResponseSchema,
  sitePreviewSchema,
  type AutomationScope,
} from "@zs/contracts";
import { createMemorySiteStore, plainSiteCompiler } from "@zs/core";
import { call, createApiHarness, type ApiHarness, type TenantSetup } from "./helpers.js";

const BASE = "/automation/v1/sites";
const memory = createMemorySiteStore();
let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness({ activepieces: {}, sites: { store: memory, compiler: plainSiteCompiler } }); });
afterAll(async () => { await h?.close(); });

const spec = (title: string) => ({ kind: "plain", title, sections: [{ heading: "Hours", body: "Mon to Fri" }] });
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const createSite = async (tenant: TenantSetup, name: string) => {
  const response = await call(h.app, "POST", "/v1/sites", { token: tenant.token, key: randomUUID(), body: { name } });
  return siteOutputSchema.parse(response.body).result;
};
async function mint(scopes: AutomationScope[], siteIds: string[]) {
  const response = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
    token: h.a.token, key: randomUUID(), body: { name: "Site agent", scopes, siteIds },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const created = automationTokenWithSecretSchema.parse(response.body);
  const revoke = () => call(h.app, "POST", `/v1/integrations/activepieces/tokens/${created.token.id}/revoke`, { token: h.a.token, key: randomUUID(), body: {} });
  return { ...created, revoke };
}
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });
const send = (secret: string, method: string, path: string, options: { body?: unknown; key?: string } = {}) =>
  call(h.app, method, path, { headers: auth(secret), ...(options.body === undefined ? {} : { body: options.body }), ...(options.key ? { key: options.key } : {}) });

describe("a site token on its own site", () => {
  it("previews, publishes, lists, reads, rolls back and syncs; a replayed key answers the same release", async () => {
    const site = await createSite(h.a, "A shop");
    const { secret, revoke } = await mint(["sites:publish"], [site.id]);

    const got = await send(secret, "GET", `${BASE}/${site.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(siteOutputSchema.shape.result.parse(got.body)).toMatchObject({ id: site.id, currentReleaseId: null });

    const preview = sitePreviewSchema.parse((await send(secret, "POST", `${BASE}/${site.id}/preview`, { body: { spec: spec("One") } })).body);
    expect(preview.entryHtml).toContain("<h1>One</h1>");

    const key = randomUUID();
    const first = await send(secret, "POST", `${BASE}/${site.id}/releases`, { key, body: { spec: spec("One") } });
    expect(first.status).toBe(201);
    const v1 = siteReleaseResponseSchema.parse(first.body);
    expect(v1.result.release.digest).toBe(preview.digest);
    const again = await send(secret, "POST", `${BASE}/${site.id}/releases`, { key, body: { spec: spec("One") } });
    expect(again.status).toBe(201);
    expect(siteReleaseResponseSchema.parse(again.body).result.release.id).toBe(v1.result.release.id);
    const reused = await send(secret, "POST", `${BASE}/${site.id}/releases`, { key, body: { spec: spec("Another") } });
    expect(reused.status).toBe(409);
    expect(errorOf(reused).details).toEqual({ reason: "idempotency_key_reused" });

    const v2 = siteReleaseResponseSchema.parse((await send(secret, "POST", `${BASE}/${site.id}/releases`, {
      key: randomUUID(), body: { spec: spec("Two"), expectedCurrentReleaseId: v1.result.release.id },
    })).body);
    const listed = siteReleaseListSchema.parse((await send(secret, "GET", `${BASE}/${site.id}/releases`)).body);
    expect(listed.items.map((release) => release.id)).toEqual([v2.result.release.id, v1.result.release.id]);
    const detail = siteReleaseDetailSchema.parse((await send(secret, "GET", `${BASE}/${site.id}/releases/${v1.result.release.id}`)).body);
    expect(detail.spec).toEqual(spec("One"));

    const stale = await send(secret, "POST", `${BASE}/${site.id}/releases/${v1.result.release.id}/activate`, {
      key: randomUUID(), body: { expectedCurrentReleaseId: v1.result.release.id },
    });
    expect(stale.status).toBe(409);
    const back = await send(secret, "POST", `${BASE}/${site.id}/releases/${v1.result.release.id}/activate`, {
      key: randomUUID(), body: { expectedCurrentReleaseId: v2.result.release.id },
    });
    expect(back.status).toBe(200);
    expect(siteReleaseResponseSchema.parse(back.body).result.site.currentReleaseId).toBe(v1.result.release.id);
    expect(siteSyncResponseSchema.parse((await send(secret, "POST", `${BASE}/${site.id}/sync`)).body).edge).toBe("synced");
    await revoke();
  });

  it("refuses a release of another site of the same tenant with 404, and there is no create or list route", async () => {
    const one = await createSite(h.a, "A one");
    const two = await createSite(h.a, "A two");
    const { secret, revoke } = await mint(["sites:publish"], [one.id, two.id]);
    const release = siteReleaseResponseSchema.parse((await send(secret, "POST", `${BASE}/${two.id}/releases`, { key: randomUUID(), body: { spec: spec("Two") } })).body).result.release;
    const wrongSite = await send(secret, "GET", `${BASE}/${one.id}/releases/${release.id}`);
    expect(wrongSite.status).toBe(404);
    expect(wrongSite.body).toEqual((await send(secret, "GET", `${BASE}/${one.id}/releases/${randomUUID()}`)).body);
    expect((await send(secret, "POST", `${BASE}/${one.id}/releases/${release.id}/activate`, { key: randomUUID(), body: { expectedCurrentReleaseId: null } })).status).toBe(404);
    expect((await send(secret, "GET", BASE)).status).toBe(404);
    expect((await send(secret, "POST", BASE, { key: randomUUID(), body: { name: "New" } })).status).toBe(404);
    await revoke();
  });

  it("checks the site before the body: a bad body is 400 on a named site and 404 on any other", async () => {
    const site = await createSite(h.a, "A shop");
    const other = await createSite(h.b, "B shop");
    const { secret, revoke } = await mint(["sites:publish"], [site.id]);
    const raw = (siteId: string, body: string, type = "application/json") =>
      h.app.request(`${BASE}/${siteId}/releases`, { method: "POST", headers: { ...auth(secret), "Content-Type": type, "Idempotency-Key": randomUUID() }, body });
    expect((await raw(other.id, "{not json")).status).toBe(404);
    expect((await raw(other.id, JSON.stringify({ spec: { kind: "plain" } }))).status).toBe(404);
    expect((await raw(site.id, "{not json")).status).toBe(400);
    expect((await raw(site.id, JSON.stringify({ spec: spec("x") }), "text/plain")).status).toBe(400);
    expect((await raw(site.id, JSON.stringify({ spec: spec("x"), extra: 1 }))).status).toBe(400);
    const noKey = await h.app.request(`${BASE}/${site.id}/releases`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify({ spec: spec("x") }) });
    expect(noKey.status).toBe(400);
    await revoke();
  });

  it("refuses a body over 64 KiB with 413 before it looks at the token row", async () => {
    const site = await createSite(h.a, "A shop");
    const { secret, revoke } = await mint(["sites:publish"], [site.id]);
    const big = JSON.stringify({ spec: spec("x"), pad: "a".repeat(70 * 1024) });
    const response = await h.app.request(`${BASE}/${site.id}/releases`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: big });
    expect(response.status).toBe(413);
    await revoke();
    // A revoked token with an oversize body is still 413: the body check comes before the token row.
    const again = await h.app.request(`${BASE}/${site.id}/releases`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: big });
    expect(again.status).toBe(413);
  });

  it("counts 30 requests a minute per token, then answers 429 with Retry-After, and counts another token apart", async () => {
    const site = await createSite(h.a, "A shop");
    const busy = await mint(["sites:publish"], [site.id]);
    const calm = await mint(["sites:publish"], [site.id]);
    for (let n = 0; n < 30; n += 1) expect((await send(busy.secret, "GET", `${BASE}/${site.id}`)).status).toBe(200);
    const refused = await send(busy.secret, "GET", `${BASE}/${site.id}`);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(errorOf(refused).code).toBe("RateLimited");
    expect((await send(calm.secret, "GET", `${BASE}/${site.id}`)).status).toBe(200);
    await busy.revoke();
    await calm.revoke();
  });
});
