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

describe("paging by cursor (W4)", () => {
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

  it("continues after the last contact shown when a newer one arrives between pages, where an offset repeats one", async () => {
    const first = contactPageSchema.parse((await get("/v1/crm/contacts?search=customer&limit=5")).body);
    const before = contactPageSchema.parse((await get("/v1/crm/contacts?search=customer&limit=5&offset=5")).body);
    expect(first.nextCursor).toEqual(expect.any(String));
    await h.fixture.service((tx) => tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at)
       VALUES ($1, gen_random_uuid(), 'Customer late', 'late@example.com', '2030-01-01', '2030-01-01')`,
      [h.a.tenantId],
    ));
    const byCursor = contactPageSchema.parse((await get(`/v1/crm/contacts?search=customer&limit=5&cursor=${first.nextCursor}`)).body);
    expect(ids(byCursor)).toEqual(ids(before));
    expect(byCursor.nextOffset).toBeNull();
    // The old way: the newcomer pushes the fifth contact onto the second page again.
    const byOffset = contactPageSchema.parse((await get("/v1/crm/contacts?search=customer&limit=5&offset=5")).body);
    expect(ids(byOffset)[0]).toBe(ids(first)[4]);
  });

  it("walks every contact in name order once, past 2,000 rows", async () => {
    const seen: string[] = [];
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `/v1/crm/contacts?search=customer&sort=name&limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const page = contactPageSchema.parse((await get(query)).body);
      seen.push(...ids(page));
      names.push(...page.items.map((item) => (item.displayName ?? "").toLowerCase()));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(HISTORY + 1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(names).toEqual([...names].sort());
  });

  it("keeps the deals after the cursor in place when an earlier deal moves to the front", async () => {
    const made: { contactId: string; dealId: string }[] = [];
    for (const n of [1, 2, 3, 4]) made.push(await contactAndDeal(h, h.a, `cursor-deal-${n}@example.com`));
    // Newest first: deal 1, 2, 3, 4.
    await h.fixture.service((tx) => tx.query(
      `UPDATE crm_deals SET updated_at = timestamptz '2028-01-01' - (array_position($2::uuid[], id) * interval '1 second')
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [h.a.tenantId, made.map((item) => item.dealId)],
    ));
    const path = `/v1/crm/deals?pipelineId=${h.a.pipelineId}&limit=2`;
    const first = dealPageSchema.parse((await get(path)).body);
    expect(ids(first)).toEqual([made[0]!.dealId, made[1]!.dealId]);
    // Deal 4 changes, so it now sorts first.
    await h.fixture.service((tx) => tx.query(
      "UPDATE crm_deals SET updated_at = timestamptz '2028-06-01' WHERE tenant_id = $1 AND id = $2", [h.a.tenantId, made[3]!.dealId],
    ));
    const next = dealPageSchema.parse((await get(`${path}&cursor=${first.nextCursor}`)).body);
    expect(ids(next)[0]).toBe(made[2]!.dealId);
    expect(ids(next)).not.toContain(made[1]!.dealId);
    const byOffset = dealPageSchema.parse((await get(`${path}&offset=2`)).body);
    expect(ids(byOffset)[0]).toBe(made[1]!.dealId);
  });

  it("pages a booking range by cursor, the running booking first, to the end", async () => {
    const path = "/v1/booking/bookings?from=2026-01-01T00:30:00.000Z&to=2026-01-01T05:00:00.000Z&limit=2";
    const starts: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = bookingPageSchema.parse((await get(`${path}${cursor ? `&cursor=${cursor}` : ""}`)).body);
      starts.push(...page.items.map((item) => item.startsAt));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(starts).toEqual([0, 1, 2, 3, 4].map((hour) => `2026-01-01T0${hour}:00:00.000Z`));
    const open = bookingPageSchema.parse((await get("/v1/booking/bookings?to=2026-01-01T03:00:00.000Z&limit=2")).body);
    const rest = bookingPageSchema.parse((await get(`/v1/booking/bookings?to=2026-01-01T03:00:00.000Z&limit=2&cursor=${open.nextCursor}`)).body);
    expect(rest.items.map((item) => item.startsAt)).toEqual(["2026-01-01T02:00:00.000Z"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("refuses a cursor from another list, a forged one, and a cursor with an offset", async () => {
    const contacts = contactPageSchema.parse((await get("/v1/crm/contacts?limit=1")).body);
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const query of [
      `/v1/crm/deals?cursor=${contacts.nextCursor}`,
      `/v1/crm/contacts?sort=name&cursor=${contacts.nextCursor}`,
      `/v1/crm/contacts?cursor=${contacts.nextCursor}&offset=1`,
      "/v1/crm/contacts?cursor=not-base64-json",
      `/v1/crm/contacts?cursor=${forged(["contacts.recent", "1; DROP TABLE x", randomUUID()])}`,
      `/v1/crm/contacts?sort=name&cursor=${forged(["contacts.name", "a\u0000b", randomUUID()])}`,
      `/v1/crm/contacts?cursor=${forged(["contacts.recent", "1", "not-a-uuid"])}`,
      "/v1/crm/contacts?cursor=has+plus",
    ]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
  });
});

describe("/v1/sites without a site store", () => {
  it("is an unknown route, and writes nothing", async () => {
    expect((await call(h.app, "GET", "/v1/sites", { token: h.a.token })).status).toBe(404);
    const create = await call(h.app, "POST", "/v1/sites", { token: h.a.token, key: randomUUID(), body: { name: "Main site" } });
    expect(create.status).toBe(404);
    const rows = await h.fixture.service(async (tx) => (await tx.query("SELECT 1 FROM sites WHERE tenant_id=$1", [h.a.tenantId])).rowCount);
    expect(rows).toBe(0);
  });
});
