import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, businessProfileOutputSchema, businessProfileSchema } from "@zs/contracts";
import { signDevToken } from "../src/dev-token.js";
import { call, createApiHarness, NOW, SECRET, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

// business-profile.md BP-5..BP-7, BP-9, BP-12 over HTTP, as zs_runtime on a real database. This is
// the slice's acceptance test: an owner saves, a stale save conflicts, staff are refused, bad zone
// and currency name their paths, and tenant B cannot reach tenant A's profile.
let h: ApiHarness;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness();
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const clock = { now: () => new Date(NOW) };
const tokenOf = (member: MemberSetup) => signDevToken(SECRET, member, clock, 3600);
const get = async (member: MemberSetup) => call(h.app, "GET", "/v1/business", { token: await tokenOf(member) });
const put = async (member: MemberSetup, body: unknown, key: string | null = randomUUID()) =>
  call(h.app, "PUT", "/v1/business", { token: await tokenOf(member), body, ...(key === null ? {} : { key }) });
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;

describe("GET and PUT /v1/business", () => {
  it("gives every member the profile that came with the tenant", async () => {
    for (const member of [h.a, staff]) {
      const response = await get(member);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(businessProfileSchema.parse(response.body)).toMatchObject({
        displayName: "Tenant A", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null, revision: 1,
      });
    }
  });

  it("saves legal name, zone and currency at revision 2; the read returns them; a stale save conflicts", async () => {
    const saved = await put(h.a, { expectedRevision: 1, changes: { legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(businessProfileOutputSchema.parse(saved.body).result).toMatchObject({
      legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR", revision: 2, updatedAt: NOW,
    });
    expect(businessProfileSchema.parse((await get(staff)).body)).toMatchObject({
      legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR", revision: 2,
    });

    const stale = await put(h.a, { expectedRevision: 1, changes: { currency: "GBP" } });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 } });
    expect(businessProfileSchema.parse((await get(h.a)).body).currency).toBe("EUR");
  });

  it("replays a save with the same key and revision once", async () => {
    const key = randomUUID();
    const body = { expectedRevision: 2, changes: { phoneE164: "+442079460000" } };
    const first = await put(h.a, body, key);
    const again = await put(h.a, body, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(businessProfileSchema.parse((await get(h.a)).body)).toMatchObject({ phoneE164: "+442079460000", revision: 3 });
  });

  it("refuses staff with 403, and they keep reading", async () => {
    const response = await put(staff, { expectedRevision: 3, changes: { currency: "GBP" } });
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("Forbidden");
    expect(businessProfileSchema.parse((await get(staff)).body).currency).toBe("EUR");
  });

  it("names the path of a zone or currency outside the lists, and refuses a missing key or an empty change", async () => {
    const zone = await put(h.a, { expectedRevision: 3, changes: { timeZone: "Mars/Base" } });
    expect(zone.status).toBe(400);
    expect(errorOf(zone)).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.timeZone" }] } });
    const money = await put(h.a, { expectedRevision: 3, changes: { currency: "XXZ" } });
    expect(money.status).toBe(400);
    expect(errorOf(money)).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.currency" }] } });
    expect((await put(h.a, { expectedRevision: 3, changes: {} })).status).toBe(400);
    expect((await put(h.a, { expectedRevision: 3, changes: { currency: "GBP" } }, null)).status).toBe(400);
    expect(businessProfileSchema.parse((await get(h.a)).body).revision).toBe(3);
  });

  it("the display name also renames the tenant, which /v1/me?include=profile shows (BP-9)", async () => {
    const saved = await put(h.a, { expectedRevision: 3, changes: { displayName: "Halden & Rowe" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const me = await call(h.app, "GET", "/v1/me?include=profile", { token: await tokenOf(h.a) });
    expect(me.body).toMatchObject({ businessName: "Halden & Rowe" });
  });
});

describe("tenancy (BP-12)", () => {
  it("shows tenant B its own profile, never tenant A's, and leaves A untouched by B's save", async () => {
    const a = businessProfileSchema.parse((await get(h.a)).body);
    const b = businessProfileSchema.parse((await get(h.b)).body);
    expect(b).toMatchObject({ displayName: "Tenant B", currency: "USD", revision: 1 });
    expect(b).not.toEqual(a);
    const saved = await put(h.b, { expectedRevision: 1, changes: { currency: "CAD" } });
    expect(saved.status).toBe(200);
    expect(businessProfileSchema.parse((await get(h.a)).body)).toEqual(a);
  });

  it("refuses a request without a token", async () => {
    expect((await call(h.app, "GET", "/v1/business")).status).toBe(401);
  });
});
