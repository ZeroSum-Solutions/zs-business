// Server-side read filters (audit W4/W8): a date range, a search or one contact is answered
// by SQL, so it never depends on how many older rows come first.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, bookingPageSchema, contactPageSchema, contactRecordSchema, dealPageSchema } from "@zs/contracts";
import { call, contactAndDeal, createApiHarness, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
const HISTORY = 2_100;
const HOUR = 3_600_000;
/** Well after the history; the one booking the calendar must show for that day. */
const CURRENT = "2027-03-01T10:00:00.000Z";

beforeAll(async () => {
  h = await createApiHarness();
  await h.fixture.service(async (tx) => {
    // Hourly bookings from 2026-01-01 on, then one far later, all on tenant A's resource.
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const starts = [...Array.from({ length: HISTORY }, (_, index) => new Date(start + index * HOUR).toISOString()), CURRENT];
    await tx.query(
      `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,created_at)
       SELECT $1, gen_random_uuid(), $2, s, s + interval '1 hour', s, s + interval '1 hour', s
         FROM unnest($3::timestamptz[]) AS s`,
      [h.a.tenantId, h.a.resourceId, starts],
    );
    // More contacts than the old dashboard cap read, with the one to find created first (oldest).
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       SELECT $1, gen_random_uuid(), 'Customer ' || n, 'customer' || n || '@example.com', NULL,
              timestamptz '2026-02-01' + n * interval '1 minute', timestamptz '2026-02-01' + n * interval '1 minute'
         FROM generate_series(1, $2::int) AS n`,
      [h.a.tenantId, HISTORY],
    );
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1, gen_random_uuid(), 'Zelda 100% O_Brien', 'zelda@example.com', '+12025550142', '2026-01-01', '2026-01-01')`,
      [h.a.tenantId],
    );
  });
}, 60_000);
afterAll(async () => { await h?.close(); });

const get = (path: string, token = h.a.token) => call(h.app, "GET", path, { token });

describe("GET /v1/booking/bookings with a range", () => {
  it("returns the bookings of one day in one request, however many older ones exist", async () => {
    const response = await get(`/v1/booking/bookings?resourceId=${h.a.resourceId}&from=2027-03-01T00:00:00.000Z&to=2027-03-02T00:00:00.000Z`);
    expect(response.status).toBe(200);
    const page = bookingPageSchema.parse(response.body);
    expect(page.items.map((item) => item.startsAt)).toEqual([CURRENT]);
    expect(page.nextOffset).toBeNull();
  });

  it("includes a booking that started before the range and is still running", async () => {
    const page = bookingPageSchema.parse((await get("/v1/booking/bookings?from=2026-01-01T00:30:00.000Z&to=2026-01-01T01:00:00.000Z")).body);
    expect(page.items.map((item) => item.startsAt)).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  it("leaves either bound open, and pages within the range", async () => {
    const after = bookingPageSchema.parse((await get("/v1/booking/bookings?from=2027-01-01T00:00:00.000Z")).body);
    expect(after.items.map((item) => item.startsAt)).toEqual([CURRENT]);
    const before = bookingPageSchema.parse((await get("/v1/booking/bookings?to=2026-01-01T03:00:00.000Z&limit=2")).body);
    expect(before.items).toHaveLength(2);
    expect(before.nextOffset).toBe(2);
  });

  it("rejects an empty or malformed range with 400", async () => {
    for (const query of ["from=2027-03-02T00:00:00.000Z&to=2027-03-01T00:00:00.000Z", "from=yesterday"]) {
      const response = await get(`/v1/booking/bookings?${query}`);
      expect(response.status).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
  });

  it("never returns another tenant's bookings", async () => {
    const page = bookingPageSchema.parse((await get("/v1/booking/bookings?from=2027-03-01T00:00:00.000Z", h.b.token)).body);
    expect(page.items).toEqual([]);
  });
});

describe("GET /v1/crm/contacts with a search", () => {
  it("finds a match that is older than every other contact", async () => {
    const page = contactPageSchema.parse((await get("/v1/crm/contacts?search=zelda")).body);
    expect(page.items.map((item) => item.displayName)).toEqual(["Zelda 100% O_Brien"]);
  });

  it("matches email and phone, case-insensitively, and treats % and _ as text", async () => {
    const names = async (search: string) => contactPageSchema.parse((await get(`/v1/crm/contacts?search=${encodeURIComponent(search)}`)).body)
      .items.map((item) => item.displayName);
    expect(await names("ZELDA@EXAMPLE")).toEqual(["Zelda 100% O_Brien"]);
    expect(await names("5550142")).toEqual(["Zelda 100% O_Brien"]);
    expect(await names("100%")).toEqual(["Zelda 100% O_Brien"]);
    expect(await names("o_b")).toEqual(["Zelda 100% O_Brien"]);
    expect(await names("_")).toEqual(["Zelda 100% O_Brien"]);
    expect(await names("no such person")).toEqual([]);
  });

  it("pages through the matches only, in name order when asked", async () => {
    const first = contactPageSchema.parse((await get("/v1/crm/contacts?search=customer&sort=name&limit=3")).body);
    expect(first.items.map((item) => item.displayName)).toEqual(["Customer 1", "Customer 10", "Customer 100"]);
    expect(first.nextOffset).toBe(3);
    const blank = contactPageSchema.parse((await get("/v1/crm/contacts?search=%20%20&limit=1")).body);
    expect(blank.items).toHaveLength(1);
  });

  it("reads only the listed contacts, and rejects a malformed ID list", async () => {
    const all = contactPageSchema.parse((await get("/v1/crm/contacts?limit=2")).body).items;
    const ids = all.map((item) => item.id);
    const picked = contactPageSchema.parse((await get(`/v1/crm/contacts?ids=${ids.join(",")}`)).body);
    expect(picked.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    expect((await get("/v1/crm/contacts?ids=not-an-id")).status).toBe(400);
    expect((await get(`/v1/crm/contacts?ids=${Array.from({ length: 101 }, () => randomUUID()).join(",")}`)).status).toBe(400);
    const foreign = contactPageSchema.parse((await get(`/v1/crm/contacts?ids=${ids.join(",")}`, h.b.token)).body);
    expect(foreign.items).toEqual([]);
  });
});

describe("GET /v1/crm/contacts/:id", () => {
  it("returns one contact, and 404 for an unknown or another tenant's one", async () => {
    const [first] = contactPageSchema.parse((await get("/v1/crm/contacts?search=zelda")).body).items;
    const response = await get(`/v1/crm/contacts/${first!.id}`);
    expect(response.status).toBe(200);
    expect(contactRecordSchema.parse(response.body)).toEqual(first);
    for (const [id, token] of [[randomUUID(), h.a.token], [first!.id, h.b.token]] as const) {
      const missing = await get(`/v1/crm/contacts/${id}`, token);
      expect(missing.status).toBe(404);
      expect(apiErrorBodySchema.parse(missing.body).error.code).toBe("NotFound");
    }
    expect((await get("/v1/crm/contacts/not-a-uuid")).status).toBe(400);
  });
});

describe("GET /v1/crm/deals with a contact", () => {
  it("returns that contact's deals only", async () => {
    const one = await contactAndDeal(h, h.a, "owner-one@example.com");
    await contactAndDeal(h, h.a, "owner-two@example.com");
    const page = dealPageSchema.parse((await get(`/v1/crm/deals?contactId=${one.contactId}`)).body);
    expect(page.items.map((item) => item.id)).toEqual([one.dealId]);
    expect(dealPageSchema.parse((await get(`/v1/crm/deals?contactId=${one.contactId}`, h.b.token)).body).items).toEqual([]);
  });
});
