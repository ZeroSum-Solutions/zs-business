// M3c Home (docs/requirements/inbox-home.md H-1..H-5, H-8): week ranges in a zone across DST,
// results with a fixed injected clock under the runtime role, deal details with C-14's
// compare-and-set, and the won date that follows the stage.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, type MemberRole, type StageOutcome } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../src/edge/public-session.js";
import { mapError } from "../src/edge/errors.js";
import { createSession, type EdgeDependencies, type Session } from "../src/edge/session.js";
import { firstInstantAtOrAfter, weekRanges } from "../src/home/week.js";

const ms = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();
const ranges = (now: string, zone: string, weekStart: "monday" | "sunday") => {
  const { thisWeek, lastWeek } = weekRanges(ms(now), zone, weekStart);
  return { thisWeek: [iso(thisWeek.from), iso(thisWeek.to)], lastWeek: [iso(lastWeek.from), iso(lastWeek.to)] };
};
/** A wall-clock label: the local date and time read as if it were UTC. */
const label = (local: string) => ms(`${local}Z`);

describe("firstInstantAtOrAfter", () => {
  it("returns the instant of a label that exists once", () => {
    expect(iso(firstInstantAtOrAfter("UTC", label("2026-10-20T09:00:00.000")))).toBe("2026-10-20T09:00:00.000Z");
    expect(iso(firstInstantAtOrAfter("America/New_York", label("2026-10-20T09:00:00.000")))).toBe("2026-10-20T13:00:00.000Z");
    expect(iso(firstInstantAtOrAfter("America/New_York", label("2026-12-20T09:00:00.000")))).toBe("2026-12-20T14:00:00.000Z");
  });

  it("returns the earlier instant of a label that clocks fall back over", () => {
    // New York repeats 01:00-01:59 on 2026-11-01: 05:30Z (EDT) and 06:30Z (EST).
    expect(iso(firstInstantAtOrAfter("America/New_York", label("2026-11-01T01:30:00.000")))).toBe("2026-11-01T05:30:00.000Z");
    // Havana repeats 00:00-00:59 on 2026-11-01, so that midnight happens twice.
    expect(iso(firstInstantAtOrAfter("America/Havana", label("2026-11-01T00:00:00.000")))).toBe("2026-11-01T04:00:00.000Z");
  });

  it("returns the jump for a label in a spring-forward gap, a skipped midnight included", () => {
    expect(iso(firstInstantAtOrAfter("America/New_York", label("2026-03-08T02:30:00.000")))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(firstInstantAtOrAfter("America/New_York", label("2026-03-08T03:00:00.000")))).toBe("2026-03-08T07:00:00.000Z");
    // Santiago and Havana skip midnight itself in 2026 (checked against Intl below).
    expect(iso(firstInstantAtOrAfter("America/Santiago", label("2026-09-06T00:00:00.000")))).toBe("2026-09-06T04:00:00.000Z");
    expect(iso(firstInstantAtOrAfter("America/Havana", label("2026-03-08T00:00:00.000")))).toBe("2026-03-08T05:00:00.000Z");
  });

  it("agrees with Intl that those midnights are skipped", () => {
    const local = (zone: string, instant: string) => new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(instant));
    expect(local("America/Santiago", "2026-09-06T03:59:00.000Z")).toBe("2026-09-05, 23:59");
    expect(local("America/Santiago", "2026-09-06T04:00:00.000Z")).toBe("2026-09-06, 01:00");
    expect(local("America/Havana", "2026-03-08T04:59:00.000Z")).toBe("2026-03-07, 23:59");
    expect(local("America/Havana", "2026-03-08T05:00:00.000Z")).toBe("2026-03-08, 01:00");
  });
});

describe("weekRanges (H-3)", () => {
  it("UTC, Monday and Sunday starts: this week whole, last week up to the same moment", () => {
    expect(ranges("2026-10-21T15:30:00.000Z", "UTC", "monday")).toEqual({
      thisWeek: ["2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
      lastWeek: ["2026-10-12T00:00:00.000Z", "2026-10-14T15:30:00.000Z"],
    });
    expect(ranges("2026-10-21T15:30:00.000Z", "UTC", "sunday")).toEqual({
      thisWeek: ["2026-10-18T00:00:00.000Z", "2026-10-25T00:00:00.000Z"],
      lastWeek: ["2026-10-11T00:00:00.000Z", "2026-10-14T15:30:00.000Z"],
    });
  });

  it("puts a Sunday in the week it ends (Monday start) or begins (Sunday start)", () => {
    expect(ranges("2026-10-25T10:00:00.000Z", "UTC", "monday").thisWeek).toEqual(["2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
    expect(ranges("2026-10-25T10:00:00.000Z", "UTC", "sunday").thisWeek).toEqual(["2026-10-25T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    // At the very first instant of a week, last week's span is empty.
    expect(ranges("2026-10-19T00:00:00.000Z", "UTC", "monday")).toEqual({
      thisWeek: ["2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
      lastWeek: ["2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"],
    });
  });

  it("America/New_York across the 2026-11-01 DST end", () => {
    // Wednesday 10:00 EST. Last week's end is Wednesday 10:00 EDT, one hour earlier in UTC.
    expect(ranges("2026-11-04T15:00:00.000Z", "America/New_York", "monday")).toEqual({
      thisWeek: ["2026-11-02T05:00:00.000Z", "2026-11-09T05:00:00.000Z"],
      lastWeek: ["2026-10-26T04:00:00.000Z", "2026-10-28T14:00:00.000Z"],
    });
    expect(ranges("2026-11-04T15:00:00.000Z", "America/New_York", "sunday")).toEqual({
      thisWeek: ["2026-11-01T04:00:00.000Z", "2026-11-08T05:00:00.000Z"],
      lastWeek: ["2026-10-25T04:00:00.000Z", "2026-10-28T14:00:00.000Z"],
    });
    // The week that holds the change is 169 hours long.
    const holding = weekRanges(ms("2026-11-01T12:00:00.000Z"), "America/New_York", "monday");
    expect([iso(holding.thisWeek.from), iso(holding.thisWeek.to)]).toEqual(["2026-10-26T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
    expect(holding.thisWeek.to - holding.thisWeek.from).toBe(169 * 3_600_000);
    expect([iso(holding.lastWeek.from), iso(holding.lastWeek.to)]).toEqual(["2026-10-19T04:00:00.000Z", "2026-10-25T11:00:00.000Z"]);
    // In the repeated hour (01:30 EST, the second time), last week ends at 01:30 local a week earlier.
    expect(ranges("2026-11-01T06:30:00.000Z", "America/New_York", "monday").lastWeek[1]).toBe("2026-10-25T05:30:00.000Z");
  });

  it("America/New_York across the 2026-03-08 DST start", () => {
    expect(ranges("2026-03-11T16:00:00.000Z", "America/New_York", "monday")).toEqual({
      thisWeek: ["2026-03-09T04:00:00.000Z", "2026-03-16T04:00:00.000Z"],
      lastWeek: ["2026-03-02T05:00:00.000Z", "2026-03-04T17:00:00.000Z"],
    });
    const holding = weekRanges(ms("2026-03-08T12:00:00.000Z"), "America/New_York", "monday");
    expect(holding.thisWeek.to - holding.thisWeek.from).toBe(167 * 3_600_000);
  });

  it("a week whose first local midnight is skipped starts at the jump", () => {
    // Santiago, Sunday 2026-09-06: clocks go from 23:59:59 Saturday to 01:00 Sunday.
    expect(ranges("2026-09-09T15:00:00.000Z", "America/Santiago", "sunday")).toEqual({
      thisWeek: ["2026-09-06T04:00:00.000Z", "2026-09-13T03:00:00.000Z"],
      lastWeek: ["2026-08-30T04:00:00.000Z", "2026-09-02T16:00:00.000Z"],
    });
    // Havana, Sunday 2026-03-08, the same way; and its doubled midnight of 2026-11-01 starts at the first one.
    expect(ranges("2026-03-11T16:00:00.000Z", "America/Havana", "sunday")).toEqual({
      thisWeek: ["2026-03-08T05:00:00.000Z", "2026-03-15T04:00:00.000Z"],
      lastWeek: ["2026-03-01T05:00:00.000Z", "2026-03-04T17:00:00.000Z"],
    });
    expect(ranges("2026-11-04T17:00:00.000Z", "America/Havana", "sunday").thisWeek[0]).toBe("2026-11-01T04:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------------------------
// Database: results, deal details and the won date, through the edge session as zs_runtime.

let now = ms("2026-10-20T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const at = (instant: string) => { now = ms(instant); };

let database: TestDatabase;
let fixture: TwoTenantFixture;
interface Seeded {
  tenantId: string;
  ownerId: string;
  resourceId: string;
  pageId: string;
  pipelineId: string;
  stages: Record<"open" | "won" | "wonAgain" | "lost", string>;
}
let A: Seeded;
let B: Seeded;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (tenant: Seeded, actorId = tenant.ownerId): Session => createSession(deps(), { tenantId: tenant.tenantId, actorId });

async function addMember(tenantId: string, role: MemberRole): Promise<string> {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(now)],
  ));
  return userId;
}

async function seed(tenantId: string): Promise<Seeded> {
  const resourceId = randomUUID();
  const pageId = randomUUID();
  const pipelineId = randomUUID();
  const stages = { open: randomUUID(), won: randomUUID(), wonAgain: randomUUID(), lost: randomUUID() };
  const outcomes: [keyof typeof stages, string, StageOutcome][] = [
    ["open", "New", "open"], ["won", "Won", "won"], ["wonAgain", "Paid", "won"], ["lost", "Lost", "lost"],
  ];
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
      [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [tenantId, pageId, new Date(now)],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, resourceId]);
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
    for (const [index, [key, name, outcome]] of outcomes.entries())
      await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,$4,$5,$6)",
        [tenantId, stages[key], pipelineId, name, index, outcome]);
  });
  return { tenantId, ownerId: await addMember(tenantId, "owner"), resourceId, pageId, pipelineId, stages };
}

/** Website requests take the next free hour in December, after every clock these tests set. */
let slot = 0;
const nextSlot = () => {
  const n = slot++;
  return `2026-12-${String(1 + Math.floor(n / 8)).padStart(2, "0")}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
};
async function website(tenant: Seeded, email: string, when: string) {
  at(when);
  const reply = await createPublicSession(deps(), { tenantId: tenant.tenantId, pageId: tenant.pageId }).request({
    resourceId: tenant.resourceId, startsAt: nextSlot(), name: "Website Visitor", email,
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "booking_page", website: "",
  }, randomUUID());
  return reply.requestId;
}
async function manualContact(tenant: Seeded, when: string, email = `${randomUUID()}@example.com`) {
  at(when);
  return (await sessionFor(tenant).upsertContact({ displayName: "Manual Lead", email }, randomUUID())).result.contact.id;
}
async function ownerBooking(tenant: Seeded, when: string, startsAt = nextSlot()) {
  at(when);
  return sessionFor(tenant).createBooking({ resourceId: tenant.resourceId, startsAt }, randomUUID());
}

/** A deal, created (with its contact) on 2026-10-20, outside every range the results test reads. */
async function newDeal(tenant: Seeded, stage: keyof Seeded["stages"] = "open", when = "2026-10-20T12:00:00.000Z") {
  const contactId = await manualContact(tenant, "2026-10-20T12:00:00.000Z");
  at(when);
  const deal = await sessionFor(tenant).createDeal(
    { contactId, pipelineId: tenant.pipelineId, stageId: tenant.stages[stage], title: "Commission" }, randomUUID());
  return deal.result;
}
async function setDetails(tenant: Seeded, dealId: string, revision: number,
  value: { amountMinor: number; currency: string } | null, leadSource: string | null, session = sessionFor(tenant)) {
  return (await session.setDealDetails(dealId, { expectedRevision: revision, value, leadSource }, randomUUID())).result;
}
async function move(tenant: Seeded, deal: { id: string; revision: number }, stage: keyof Seeded["stages"], when: string) {
  at(when);
  return (await sessionFor(tenant).moveDealStage(deal.id,
    { pipelineId: tenant.pipelineId, stageId: tenant.stages[stage], expectedRevision: deal.revision }, randomUUID())).result;
}
async function listed(tenant: Seeded, dealId: string) {
  return (await sessionFor(tenant).listDeals({ limit: 100 })).items.find((deal) => deal.id === dealId)!;
}
/** A deal with details, won at `wonAt`. */
async function wonDeal(tenant: Seeded, value: { amountMinor: number; currency: string } | null, source: string | null, wonAt: string) {
  const deal = await newDeal(tenant);
  const detailed = await setDetails(tenant, deal.id, deal.revision, value, source);
  return move(tenant, detailed, "won", wonAt);
}
async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<ActionError> {
  try { await (typeof promise === "function" ? promise() : promise); }
  catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  A = await seed(fixture.a.tenantId);
  B = await seed(fixture.b.tenantId);
});
afterAll(async () => { await database?.close(); });

describe("homeResults (H-3, H-4, H-5)", () => {
  // Wednesday 2026-11-04 10:00 in New York, the week after DST ended.
  const NOW = "2026-11-04T15:00:00.000Z";

  it("counts leads, bookings and won revenue by source in this week and the same span of last week", async () => {
    // Leads. Website: a request that created the contact.
    await website(A, "new.this@example.com", "2026-11-03T12:00:00.000Z");
    await website(A, "new.last@example.com", "2026-10-27T12:00:00.000Z");
    // Manual: created by hand, including one a website request was later linked to.
    const linkedTo = await manualContact(A, "2026-11-02T06:00:00.000Z", "known@example.com");
    const request = await website(A, "known@example.com", "2026-11-03T13:00:00.000Z");
    await sessionFor(A).linkIntakeItem(request, { contactId: linkedTo }, randomUUID());
    await manualContact(A, "2026-10-28T13:59:59.999Z");
    // Written at the very instant the results are read: this week holds it.
    await manualContact(A, NOW);
    // Outside both ranges: last week's end (exclusive, 10:00 EDT) and before its start.
    await manualContact(A, "2026-10-28T14:00:00.000Z");
    await manualContact(A, "2026-10-28T14:30:00.000Z");
    await manualContact(A, "2026-10-26T03:59:59.999Z");

    // Bookings by created_at: the three website requests above, plus the owner's.
    await ownerBooking(A, "2026-11-04T10:00:00.000Z");
    await ownerBooking(A, "2026-10-27T09:00:00.000Z");
    await ownerBooking(A, "2026-10-28T15:00:00.000Z");
    // Taken before both ranges, for a time inside this week: not counted.
    await ownerBooking(A, "2026-10-20T12:00:00.000Z", "2026-11-03T09:00:00.000Z");

    // Revenue: deals won in each range (their contacts were created on 2026-10-20).
    await wonDeal(A, { amountMinor: 50_000, currency: "USD" }, "website", "2026-11-03T10:00:00.000Z");
    await wonDeal(A, { amountMinor: 20_000, currency: "USD" }, "referral", "2026-11-04T09:00:00.000Z");
    await wonDeal(A, { amountMinor: 7_000, currency: "USD" }, "website", "2026-10-27T10:00:00.000Z");
    await wonDeal(A, { amountMinor: 9_900, currency: "EUR" }, null, "2026-11-02T08:00:00.000Z");
    await wonDeal(A, null, "ads", "2026-11-03T11:00:00.000Z");
    await wonDeal(A, { amountMinor: 100_000, currency: "USD" }, "website", "2026-10-28T15:00:00.000Z");
    // Created straight into a won stage last week, then given a value.
    const direct = await newDeal(A, "won", "2026-10-27T11:00:00.000Z");
    at("2026-10-27T11:00:00.000Z");
    await setDetails(A, direct.id, direct.revision, { amountMinor: 3_000, currency: "USD" }, "website");
    // Open, and won-then-reopened: no revenue.
    const open = await newDeal(A);
    await setDetails(A, open.id, open.revision, { amountMinor: 1, currency: "USD" }, "website");
    const reopened = await wonDeal(A, { amountMinor: 444, currency: "USD" }, "phone", "2026-11-03T12:00:00.000Z");
    await move(A, reopened, "open", "2026-11-03T13:00:00.000Z");

    // Tenant B's records in the same weeks never reach A's results.
    await website(B, "b.lead@example.com", "2026-11-03T12:00:00.000Z");
    await manualContact(B, "2026-10-27T12:00:00.000Z");
    await wonDeal(B, { amountMinor: 999_999, currency: "USD" }, "website", "2026-11-03T10:00:00.000Z");

    at(NOW);
    const results = await sessionFor(A).homeResults({ zone: "America/New_York", weekStart: "monday" });
    expect(results).toEqual({
      zone: "America/New_York",
      weekStart: "monday",
      thisWeek: { from: "2026-11-02T05:00:00.000Z", to: "2026-11-09T05:00:00.000Z" },
      lastWeek: { from: "2026-10-26T04:00:00.000Z", to: "2026-10-28T14:00:00.000Z" },
      leads: { thisWeek: 3, lastWeek: 2, bySource: [
        { source: "website", thisWeek: 1, lastWeek: 1 },
        { source: "manual", thisWeek: 2, lastWeek: 1 },
      ] },
      bookings: { thisWeek: 3, lastWeek: 2, bySource: [
        { source: "website", thisWeek: 2, lastWeek: 1 },
        { source: "owner", thisWeek: 1, lastWeek: 1 },
      ] },
      wonDeals: { thisWeek: 4, lastWeek: 2 },
      revenue: [
        { currency: "USD", thisWeek: 70_000, lastWeek: 10_000, bySource: [
          { source: "website", thisWeek: 50_000, lastWeek: 10_000 },
          { source: "referral", thisWeek: 20_000, lastWeek: 0 },
        ] },
        { currency: "EUR", thisWeek: 9_900, lastWeek: 0, bySource: [{ source: "unset", thisWeek: 9_900, lastWeek: 0 }] },
      ],
    });

    // The clock is read once per call: moving it moves both ranges.
    at("2026-11-11T15:00:00.000Z");
    const next = await sessionFor(A).homeResults({ zone: "America/New_York" });
    expect(next.lastWeek).toEqual({ from: "2026-11-02T05:00:00.000Z", to: "2026-11-04T15:00:00.000Z" });
    // Last week now ends at 2026-11-04 10:00 EST exclusive, so the lead written at that instant drops out.
    expect(next.leads).toMatchObject({ thisWeek: 0, lastWeek: 2 });
    expect(next.revenue).toEqual([
      { currency: "USD", thisWeek: 0, lastWeek: 70_000, bySource: [
        { source: "website", thisWeek: 0, lastWeek: 50_000 },
        { source: "referral", thisWeek: 0, lastWeek: 20_000 },
      ] },
      { currency: "EUR", thisWeek: 0, lastWeek: 9_900, bySource: [{ source: "unset", thisWeek: 0, lastWeek: 9_900 }] },
    ]);
    const b = await sessionFor(B).homeResults({ zone: "America/New_York" });
    expect(b.leads).toMatchObject({ thisWeek: 0, lastWeek: 1 });
  });

  it("defaults to UTC and Monday, and refuses a bad zone or week start", async () => {
    at("2026-10-21T15:30:00.000Z");
    const results = await sessionFor(A).homeResults({});
    expect(results).toMatchObject({
      zone: "UTC", weekStart: "monday",
      thisWeek: { from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" },
      lastWeek: { from: "2026-10-12T00:00:00.000Z", to: "2026-10-14T15:30:00.000Z" },
    });
    for (const query of [{ zone: "Mars/Olympus" }, { weekStart: "friday" }, { zone: "UTC", extra: 1 }]) {
      const error = await rejection(() => sessionFor(A).homeResults(query));
      expect(error.code).toBe("ValidationFailed");
      expect(mapError(error).status).toBe(400);
    }
  });

  it("is owners only: staff and strangers are refused", async () => {
    at(NOW);
    const staff = await addMember(A.tenantId, "staff");
    expect((await rejection(sessionFor(A, staff).homeResults({}))).code).toBe("TenantDenied");
    expect((await rejection(sessionFor(A, randomUUID()).homeResults({}))).code).toBe("TenantDenied");
    expect((await rejection(sessionFor(A, B.ownerId).homeResults({}))).code).toBe("TenantDenied");
    // Staff keep the rest of Home: the calendar.
    await expect(sessionFor(A, staff).listBookings({})).resolves.toBeDefined();
  });
});

describe("crm.deal.set-details (H-1)", () => {
  it("sets value and lead source, bumps the revision once and stamps the injected clock", async () => {
    const deal = await newDeal(A);
    at("2026-10-21T09:15:00.000Z");
    const updated = await setDetails(A, deal.id, deal.revision, { amountMinor: 12_345, currency: "USD" }, "phone");
    expect(updated).toMatchObject({
      id: deal.id, revision: deal.revision + 1, updatedAt: "2026-10-21T09:15:00.000Z",
      value: { amountMinor: 12_345, currency: "USD" }, leadSource: "phone", wonAt: null, stageId: deal.stageId,
    });
    expect(await listed(A, deal.id)).toEqual(updated);

    // Stale revision: 409 with the current revision, nothing changed.
    const stale = await rejection(setDetails(A, deal.id, deal.revision, { amountMinor: 1, currency: "EUR" }, "ads"));
    expect(stale).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: deal.revision + 1 } });
    expect(mapError(stale).body.error.details).toEqual({ reason: "stale_revision", currentRevision: deal.revision + 1 });
    expect(await listed(A, deal.id)).toEqual(updated);

    // Null clears both.
    at("2026-10-21T09:16:00.000Z");
    const cleared = await setDetails(A, deal.id, updated.revision, null, null);
    expect(cleared).toMatchObject({ revision: deal.revision + 2, value: null, leadSource: null, updatedAt: "2026-10-21T09:16:00.000Z" });

    // The largest exact amount round-trips.
    const max = await setDetails(A, deal.id, cleared.revision, { amountMinor: Number.MAX_SAFE_INTEGER, currency: "JPY" }, "other");
    expect((await listed(A, deal.id)).value).toEqual({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "JPY" });
    expect(max.revision).toBe(deal.revision + 3);
  });

  it("enforces value and currency as one pair, and the documented sources", async () => {
    const deal = await newDeal(A);
    const session = sessionFor(A);
    for (const body of [
      { value: { amountMinor: 100 } },
      { value: { currency: "USD" } },
      { value: { amountMinor: 100, currency: "usd" } },
      { value: { amountMinor: 100, currency: "USDX" } },
      { value: { amountMinor: -1, currency: "USD" } },
      { value: { amountMinor: 1.5, currency: "USD" } },
      { value: { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" } },
      { value: null, leadSource: "billboard" },
      { leadSource: null, value: undefined },
      { value: null, leadSource: null, expectedRevision: 0 },
    ]) {
      const error = await rejection(() => session.setDealDetails(deal.id,
        { expectedRevision: deal.revision, leadSource: null, ...body }, randomUUID()));
      expect(error.code, JSON.stringify(body)).toBe("ValidationFailed");
    }
    expect((await listed(A, deal.id)).revision).toBe(deal.revision);
    // Under the runtime role directly, the table refuses half a value too.
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE crm_deals SET value_minor=5 WHERE tenant_id=$1 AND id=$2", [A.tenantId, deal.id]))).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE crm_deals SET won_at=now() WHERE tenant_id=$1 AND id=$2", [A.tenantId, deal.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("staff may set details; strangers and another tenant may not", async () => {
    const deal = await newDeal(A);
    const staff = await addMember(A.tenantId, "staff");
    const done = await setDetails(A, deal.id, deal.revision, { amountMinor: 10, currency: "GBP" }, "walk_in", sessionFor(A, staff));
    expect(done.leadSource).toBe("walk_in");
    for (const session of [sessionFor(A, randomUUID()), sessionFor(B)])
      expect((await rejection(setDetails(A, deal.id, done.revision, null, null, session))).code).toBe("TenantDenied");
    expect((await listed(A, deal.id)).revision).toBe(done.revision);
  });
});

describe("won date (H-2)", () => {
  it("is stamped on entering a won stage, kept between won stages, and cleared on leaving", async () => {
    const deal = await newDeal(A);
    const won = await move(A, deal, "won", "2026-10-22T10:00:00.000Z");
    expect(await listed(A, deal.id)).toMatchObject({ wonAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" });
    const paid = await move(A, won, "wonAgain", "2026-10-23T10:00:00.000Z");
    expect(await listed(A, deal.id)).toMatchObject({ stageId: A.stages.wonAgain, wonAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-23T10:00:00.000Z" });
    // Setting details on a won deal keeps its date.
    at("2026-10-23T11:00:00.000Z");
    const detailed = await setDetails(A, deal.id, paid.revision, { amountMinor: 5, currency: "USD" }, "email");
    expect(detailed.wonAt).toBe("2026-10-22T10:00:00.000Z");
    const reopened = await move(A, detailed, "open", "2026-10-24T10:00:00.000Z");
    expect((await listed(A, deal.id)).wonAt).toBeNull();
    const rewon = await move(A, reopened, "won", "2026-10-25T10:00:00.000Z");
    expect((await listed(A, deal.id)).wonAt).toBe("2026-10-25T10:00:00.000Z");
    await move(A, rewon, "lost", "2026-10-26T10:00:00.000Z");
    expect((await listed(A, deal.id)).wonAt).toBeNull();
  });

  it("is set when a deal is created directly in a won stage", async () => {
    const deal = await newDeal(A, "won", "2026-10-22T08:30:00.000Z");
    expect(await listed(A, deal.id)).toMatchObject({ wonAt: "2026-10-22T08:30:00.000Z", value: null, leadSource: null });
    const lost = await newDeal(A, "lost", "2026-10-22T08:31:00.000Z");
    expect((await listed(A, lost.id)).wonAt).toBeNull();
  });
});

describe("lists (H-1, H-2)", () => {
  it("listDeals shows value, lead source and won date; listPipelines shows each stage's outcome", async () => {
    const deal = await wonDeal(A, { amountMinor: 2_500, currency: "CAD" }, "social", "2026-10-22T12:00:00.000Z");
    expect(await listed(A, deal.id)).toEqual({
      id: deal.id, tenantId: A.tenantId, contactId: deal.contactId, pipelineId: A.pipelineId, stageId: A.stages.won,
      title: "Commission", revision: deal.revision, createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-22T12:00:00.000Z",
      value: { amountMinor: 2_500, currency: "CAD" }, leadSource: "social", wonAt: "2026-10-22T12:00:00.000Z",
    });
    expect(await sessionFor(A).listPipelines()).toEqual([{
      id: A.pipelineId, name: "Sales", stages: [
        { id: A.stages.open, name: "New", position: 0, outcome: "open" },
        { id: A.stages.won, name: "Won", position: 1, outcome: "won" },
        { id: A.stages.wonAgain, name: "Paid", position: 2, outcome: "won" },
        { id: A.stages.lost, name: "Lost", position: 3, outcome: "lost" },
      ],
    }]);
  });
});
