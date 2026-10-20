import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, homeResultsSchema, type HomeResults } from "@zs/contracts";
import { signDevToken } from "../src/dev-token.js";
import {
  call,
  contactAndDeal,
  createApiHarness,
  KEY_SECRET,
  provisionPage,
  SECRET,
  signedInMember,
  type ApiHarness,
  type MemberSetup,
  type TenantSetup,
} from "./helpers.js";

// inbox-home.md H-3..H-6 over HTTP. The injected clock is set per phase; results never read the
// database clock or the host's date, so the week boundaries below are exact.
let now = Date.parse("2026-10-12T15:00:00.000Z");
const clock = { now: () => new Date(now) };
let h: ApiHarness;
let staff: MemberSetup;
let pageKey: string;
let results: HomeResults;

/** The member's token, issued at the clock's current time. */
const tokenOf = (member: Pick<MemberSetup, "tenantId" | "actorId" | "sessionId">) => signDevToken(SECRET, member, clock, 3600);

/** A deal for the contact with a value and source, moved into the won stage now (H-2 stamps won_at). */
async function wonDeal(tenant: TenantSetup, token: string, email: string, value: { amountMinor: number; currency: string }, leadSource: string | null) {
  const { contactId, dealId } = await contactAndDeal(h, { ...tenant, token }, email);
  const set = await call(h.app, "POST", `/v1/crm/deals/${dealId}/details`, {
    token, key: randomUUID(), body: { expectedRevision: 1, value, leadSource },
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const moved = await call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, {
    token, key: randomUUID(), body: { pipelineId: tenant.pipelineId, stageId: tenant.stages[1], expectedRevision: 2 },
  });
  expect(moved.status).toBe(200);
  return contactId;
}

beforeAll(async () => {
  h = await createApiHarness({ clock, publicIntake: { keySecrets: { current: KEY_SECRET }, clientIp: { header: "x-real-ip" } } });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
  pageKey = (await provisionPage(h, h.a)).key;

  // Last week, Monday 15:00 UTC: an owner-entered lead, an owner booking and a won referral deal.
  let token = await tokenOf(h.a);
  await wonDeal(h.a, token, "last-week@example.com", { amountMinor: 200_000, currency: "USD" }, "referral");
  const ownerBooking = await call(h.app, "POST", "/v1/booking/bookings", {
    token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: "2026-10-12T16:00:00.000Z" },
  });
  expect(ownerBooking.status).toBe(201);

  // Last Friday: after the point of last week that this week has reached, so it counts nowhere.
  now = Date.parse("2026-10-16T12:00:00.000Z");
  token = await tokenOf(h.a);
  await wonDeal(h.a, token, "friday@example.com", { amountMinor: 999, currency: "USD" }, "phone");

  // This week, Wednesday 12:00 UTC: a website booking that creates its customer, and two won deals.
  now = Date.parse("2026-10-21T12:00:00.000Z");
  token = await tokenOf(h.a);
  const email = `website.${randomUUID().slice(0, 8)}@example.com`;
  const request = await call(h.app, "POST", `/public/v1/pages/${pageKey}/requests`, {
    key: randomUUID(), headers: { "X-Real-IP": "203.0.113.7" },
    body: {
      resourceId: h.a.resourceId, startsAt: "2026-10-26T09:00:00.000Z", name: "Callum Avery", email, phone: null,
      notes: "Looking at engagement rings", consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "booking_page", website: "",
    },
  });
  expect(request.status, JSON.stringify(request.body)).toBe(201);
  // The deals reuse the website customer (create-or-find by email), so they add no lead.
  await wonDeal(h.a, token, email, { amountMinor: 150_000, currency: "USD" }, "website");
  await wonDeal(h.a, token, email, { amountMinor: 50_000, currency: "EUR" }, null);
  results = await home(token);
});
afterAll(async () => { await h?.close(); });

async function home(token: string, query = ""): Promise<HomeResults> {
  const response = await call(h.app, "GET", `/v1/home/results${query}`, { token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return homeResultsSchema.parse(response.body);
}

const counts = {
  leads: { thisWeek: 1, lastWeek: 1, bySource: [
    { source: "website", thisWeek: 1, lastWeek: 0 }, { source: "manual", thisWeek: 0, lastWeek: 1 },
  ] },
  bookings: { thisWeek: 1, lastWeek: 1, bySource: [
    { source: "website", thisWeek: 1, lastWeek: 0 }, { source: "owner", thisWeek: 0, lastWeek: 1 },
  ] },
  wonDeals: { thisWeek: 2, lastWeek: 1 },
  revenue: [
    { currency: "USD", thisWeek: 150_000, lastWeek: 200_000, bySource: [
      { source: "website", thisWeek: 150_000, lastWeek: 0 }, { source: "referral", thisWeek: 0, lastWeek: 200_000 },
    ] },
    { currency: "EUR", thisWeek: 50_000, lastWeek: 0, bySource: [{ source: "unset", thisWeek: 50_000, lastWeek: 0 }] },
  ],
};

describe("GET /v1/home/results", () => {
  it("counts the website booking and its new customer this week against the same span of last week (UTC, Monday)", () => {
    expect(results).toEqual({
      zone: "UTC", weekStart: "monday",
      thisWeek: { from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" },
      lastWeek: { from: "2026-10-12T00:00:00.000Z", to: "2026-10-14T12:00:00.000Z" },
      ...counts,
    });
  });

  it("takes an IANA zone and a Sunday week start", async () => {
    const token = await tokenOf(h.a);
    expect(await home(token, "?zone=America/New_York")).toEqual({
      zone: "America/New_York", weekStart: "monday",
      thisWeek: { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" },
      lastWeek: { from: "2026-10-12T04:00:00.000Z", to: "2026-10-14T12:00:00.000Z" },
      ...counts,
    });
    expect(await home(token, "?weekStart=sunday")).toEqual({
      zone: "UTC", weekStart: "sunday",
      thisWeek: { from: "2026-10-18T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z" },
      lastWeek: { from: "2026-10-11T00:00:00.000Z", to: "2026-10-14T12:00:00.000Z" },
      ...counts,
    });
  });

  it("refuses staff with 403 (reports is owners only, H-5)", async () => {
    const response = await call(h.app, "GET", "/v1/home/results", { token: await tokenOf(staff) });
    expect(response.status).toBe(403);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Forbidden");
  });

  it("shows another tenant only its own (empty) results", async () => {
    const theirs = await home(await tokenOf(h.b));
    expect(theirs).toMatchObject({
      leads: { thisWeek: 0, lastWeek: 0 }, bookings: { thisWeek: 0, lastWeek: 0 }, wonDeals: { thisWeek: 0, lastWeek: 0 }, revenue: [],
    });
  });

  it("answers a bad zone, week start or extra parameter with 400", async () => {
    const token = await tokenOf(h.a);
    for (const query of ["?zone=Mars/Olympus", "?weekStart=friday", "?tenantId=x"]) {
      const response = await call(h.app, "GET", `/v1/home/results${query}`, { token });
      expect(response.status, query).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
  });
});
