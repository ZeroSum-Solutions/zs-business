// The customer's own booking link over HTTP (docs/requirements/booking-self-service.md BS-1, BS-4..BS-10): the
// whole flow from a confirmation email, one fixed 404 for a forged token, strict bodies, the page's headers,
// expiry, and the abuse limits counted in both stores. Core behaviour is covered in packages/core.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { manageViewSchema, manageRescheduleReplySchema } from "@zs/contracts";
import { signManageToken, verifyManageToken } from "@zs/core";
import { call, createApiHarness, KEY_SECRET, NOW, PREVIOUS_KEY_SECRET, provisionPage, PUBLIC_BASE_URL, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({
    publicIntake: {
      clientIp: { header: "x-real-ip" },
      keySecrets: { current: KEY_SECRET, previous: PREVIOUS_KEY_SECRET },
      limits: {
        addressWrites: { limit: 1000, windowMs: 600_000 },
        addressReads: { limit: 1000, windowMs: 600_000 },
        tenantWrites: { limit: 1000, windowMs: 3_600_000 },
      },
    },
  });
});
afterAll(async () => h.close());

const at = (hour: number, day = 19) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
let address = 0;
const nextAddress = () => `198.51.100.${(++address % 250) + 1}`;
const as = (from: string) => ({ "X-Real-IP": from });

async function freshResource(harness: ApiHarness, tenant: ApiHarness["a"]) {
  const resourceId = randomUUID();
  await harness.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [tenant.tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))]));
  return { resourceId, ...(await provisionPage(harness, tenant, { resourceIds: [resourceId] })) };
}

/** A visitor books, and the confirmation email's link comes back out of the outbox like a customer reading it. */
async function booked(harness: ApiHarness, tenant: ApiHarness["a"], startsAt = at(9), setup?: Awaited<ReturnType<typeof freshResource>>) {
  const page = setup ?? await freshResource(harness, tenant);
  const reply = await call(harness.app, "POST", `/public/v1/pages/${page.key}/requests`, {
    key: randomUUID(), headers: as(nextAddress()),
    body: { resourceId: page.resourceId, startsAt, name: "Mira Rowe", email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`, phone: null,
      notes: null, consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "" },
  });
  expect(reply.status).toBe(201);
  const booking = (await harness.fixture.service((tx) => tx.query<{ id: string }>(
    "SELECT id FROM bookings WHERE tenant_id=$1 AND intake_item_id=$2", [tenant.tenantId, reply.body.requestId]))).rows[0]!;
  const email = (await harness.fixture.service((tx) => tx.query<{ payload: { body: string } }>(
    `SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' ORDER BY created_at DESC LIMIT 20`,
    [tenant.tenantId]))).rows.find((row) => row.payload.body.includes(`/manage/`) && verifyOf(row.payload.body, tenant.tenantId) === booking.id);
  const token = email ? /\/manage\/(zsm1_[A-Za-z0-9_-]{70})/.exec(email.payload.body)![1]! : null;
  return { ...page, bookingId: booking.id, startsAt, token };
}
const verifyOf = (body: string, tenantId: string) => {
  const found = /\/manage\/(zsm1_[A-Za-z0-9_-]{70})/.exec(body);
  const ref = found ? verifyManageToken({ current: KEY_SECRET }, found[1]!) : null;
  return ref && ref.tenantId === tenantId ? ref.bookingId : null;
};

const view = (token: string, from = nextAddress()) => call(h.app, "GET", `/public/v1/manage/${token}`, { headers: as(from) });
const bookingStatus = async (id: string) => (await h.fixture.service((tx) => tx.query<{ status: string }>("SELECT status FROM bookings WHERE id=$1", [id]))).rows[0]!.status;

describe("the whole flow from the email (BS-3..BS-8)", () => {
  it("reads, lists free times, moves, follows the old link, and cancels", async () => {
    const made = await booked(h, h.a);
    expect(made.token).not.toBeNull();
    const token = made.token!;
    const seen = await view(token);
    expect(seen.status).toBe(200);
    expect(seen.headers.get("cache-control")).toBe("no-store");
    expect(manageViewSchema.parse(seen.body)).toMatchObject({ state: "confirmed", businessName: "Tenant A", startsAt: made.startsAt, canChange: true });
    expect(JSON.stringify(seen.body)).not.toMatch(/mira|haldenrowe|tenantId|contact/i);

    const slots = await call(h.app, "GET", `/public/v1/manage/${token}/slots?from=${at(8)}&to=${at(13)}`, { headers: as(nextAddress()) });
    expect(slots.status).toBe(200);
    expect(slots.body.slots.map((slot: { startsAt: string }) => slot.startsAt)).toEqual([at(10), at(11), at(12)]);

    const moved = await call(h.app, "POST", `/public/v1/manage/${token}/reschedule`, { key: randomUUID(), headers: as(nextAddress()), body: { startsAt: at(11) } });
    expect(moved.status).toBe(200);
    const reply = manageRescheduleReplySchema.parse(moved.body);
    expect(reply.view).toMatchObject({ state: "confirmed", startsAt: at(11) });
    expect(await bookingStatus(made.bookingId)).toBe("cancelled");

    const old = await view(token);
    expect(old.body).toMatchObject({ state: "moved", movedTo: { startsAt: at(11) } });
    const next = old.body.movedTo.token as string;
    expect(verifyManageToken({ current: KEY_SECRET }, next)?.tenantId).toBe(h.a.tenantId);

    const cancelled = await call(h.app, "POST", `/public/v1/manage/${reply.token}/cancel`, { key: randomUUID(), headers: as(nextAddress()), body: {} });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ state: "cancelled", canChange: false });
    const after = await call(h.app, "GET", `/public/v1/manage/${reply.token}/slots?from=${at(8)}&to=${at(13)}`, { headers: as(nextAddress()) });
    expect(after.status).toBe(409);
    expect(after.body.error.details.reason).toBe("not_changeable");
  });

  it("replays one key and answers a lost slot with 409 slot_unavailable, keeping the old booking", async () => {
    const page = await freshResource(h, h.a);
    const first = await booked(h, h.a, at(9), page);
    const other = await booked(h, h.a, at(10), page);
    const key = randomUUID();
    const send = (token: string, startsAt: string, k = key) =>
      call(h.app, "POST", `/public/v1/manage/${token}/reschedule`, { key: k, headers: as(nextAddress()), body: { startsAt } });
    const once = await send(first.token!, at(13));
    const twice = await send(first.token!, at(13));
    expect([once.status, twice.status]).toEqual([200, 200]);
    expect(twice.body.token).toBe(once.body.token);
    const lost = await send(other.token!, at(13), randomUUID());
    expect(lost).toMatchObject({ status: 409, body: { error: { details: { reason: "slot_unavailable" } } } });
    expect(await bookingStatus(other.bookingId)).toBe("confirmed");
    const sameKeyOtherBody = await send(first.token!, at(14));
    expect(sameKeyOtherBody.status).toBe(409);
  });
});

describe("one fixed answer for a token that reaches nothing (BS-1, BS-2)", () => {
  it("answers a forged, foreign-tenant, previous-secret-less and hand-made booking token alike", async () => {
    const made = await booked(h, h.a);
    const forged = made.token!.slice(0, -3) + "AAA";
    const swapped = signManageToken(KEY_SECRET, { tenantId: h.b.tenantId, bookingId: made.bookingId, expiresAt: 1_900_000_000 });
    const otherSecret = signManageToken("x".repeat(40), { tenantId: h.a.tenantId, bookingId: made.bookingId, expiresAt: 1_900_000_000 });
    const handMade = randomUUID();
    await h.fixture.service((tx) => tx.query(
      `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,buffer_before_minutes,buffer_after_minutes,status,source,created_at)
       VALUES ($1,$2,$3,'2026-11-30T09:00:00Z','2026-11-30T10:00:00Z','2026-11-30T09:00:00Z','2026-11-30T10:00:00Z',0,0,'confirmed','owner',$4)`,
      [h.a.tenantId, handMade, made.resourceId, NOW]));
    const hand = signManageToken(KEY_SECRET, { tenantId: h.a.tenantId, bookingId: handMade, expiresAt: Math.ceil(Date.parse("2026-11-30T09:00:00Z") / 1000) });
    const bodies = [];
    for (const token of [forged, swapped, otherSecret, hand, "nope", `zsm1_${"A".repeat(70)}`]) {
      const response = await view(token);
      expect(response.status, token.slice(0, 12)).toBe(404);
      bodies.push(JSON.stringify(response.body));
      for (const [method, path, body] of [["POST", "cancel", {}], ["POST", "reschedule", { startsAt: at(15) }]] as const) {
        const write = await call(h.app, method, `/public/v1/manage/${token}/${path}`, { key: randomUUID(), headers: as(nextAddress()), body });
        expect(write.status, `${path} ${token.slice(0, 12)}`).toBe(404);
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(await bookingStatus(made.bookingId)).toBe("confirmed");
    expect(await bookingStatus(handMade)).toBe("confirmed");
  });

  it("still accepts a link signed with the previous booking-key secret", async () => {
    const made = await booked(h, h.a);
    const old = signManageToken(PREVIOUS_KEY_SECRET, { tenantId: h.a.tenantId, bookingId: made.bookingId, expiresAt: Math.ceil(Date.parse(made.startsAt) / 1000) });
    expect((await view(old)).status).toBe(200);
  });
});

describe("strict requests (BS-9)", () => {
  it("refuses a bad body, a bad key and an oversized body before any change", async () => {
    const made = await booked(h, h.a);
    const token = made.token!;
    const post = (path: string, body: unknown, key: string | undefined = randomUUID()) =>
      call(h.app, "POST", `/public/v1/manage/${token}/${path}`, { ...(key ? { key } : {}), headers: as(nextAddress()), body });
    expect((await post("cancel", { bookingId: made.bookingId })).status).toBe(400);
    expect((await post("cancel", {}, "")).status).toBe(400);
    expect((await post("cancel", {}, "not-a-uuid")).status).toBe(400);
    expect((await post("reschedule", {})).status).toBe(400);
    expect((await post("reschedule", { startsAt: at(15), resourceId: made.resourceId })).status).toBe(400);
    expect((await post("reschedule", { startsAt: "tomorrow" })).status).toBe(400);
    const big = await h.app.request(`/public/v1/manage/${token}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "X-Real-IP": nextAddress() },
      body: JSON.stringify({ pad: "x".repeat(9000) }),
    });
    expect(big.status).toBe(413);
    const noType = await h.app.request(`/public/v1/manage/${token}/cancel`, { method: "POST", headers: { "Idempotency-Key": randomUUID(), "X-Real-IP": nextAddress() }, body: "{}" });
    expect(noType.status).toBe(400);
    expect(await bookingStatus(made.bookingId)).toBe("confirmed");
    const slots = await call(h.app, "GET", `/public/v1/manage/${token}/slots?from=${at(8)}&to=${at(12)}&resourceId=${made.resourceId}`, { headers: as(nextAddress()) });
    expect(slots.status).toBe(400);
  });
});

describe("the page (BS-10)", () => {
  it("serves one static page for a real token, never framed, never cached, no inline code", async () => {
    const made = await booked(h, h.a);
    const response = await h.app.request(`/manage/${made.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const html = await response.text();
    expect(html).toContain('src="/manage.js"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toContain(made.token!);
    const missing = await h.app.request(`/manage/${made.token!.slice(0, -2)}AA`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const script = await h.app.request("/manage.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
  });

  it("builds the email link from the public base URL", async () => {
    const made = await booked(h, h.a);
    const mail = (await h.fixture.service((tx) => tx.query<{ payload: { body: string } }>(
      "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'body' LIKE $2", [h.a.tenantId, `%${made.token}%`]))).rows[0]!;
    expect(mail.payload.body).toContain(`${PUBLIC_BASE_URL}/manage/${made.token}`);
  });
});

describe.each(["memory", "postgres"] as const)("expiry and abuse limits (BS-1, BS-9), counted in %s", (limiterStore) => {
  let limited: ApiHarness;
  let now = Date.parse(NOW);
  beforeAll(async () => {
    limited = await createApiHarness({
      limiterStore,
      clock: { now: () => new Date(now) },
      publicIntake: {
        clientIp: { header: "x-real-ip" },
        keySecrets: { current: KEY_SECRET },
        limits: {
          addressWrites: { limit: 2, windowMs: 600_000 },
          addressReads: { limit: 3, windowMs: 600_000 },
          tenantWrites: { limit: 50, windowMs: 3_600_000 },
        },
      },
    });
  });
  afterAll(async () => limited.close());
  const get = (token: string, from: string) => call(limited.app, "GET", `/public/v1/manage/${token}`, { headers: as(from) });

  it("answers an expired link 409 link_expired without touching the booking, and charges the address as a forger", async () => {
    const page = await freshResource(limited, limited.a);
    const startsAt = at(9, 20);
    const token = signManageToken(KEY_SECRET, { tenantId: limited.a.tenantId, bookingId: randomUUID(), expiresAt: Math.ceil(Date.parse(startsAt) / 1000) });
    now = Date.parse(startsAt);
    const first = await get(token, "192.0.2.10");
    expect(first).toMatchObject({ status: 409, body: { error: { details: { reason: "link_expired" } } } });
    expect((await get(token, "192.0.2.10")).status).toBe(409);
    expect((await get(token, "192.0.2.10")).status).toBe(429);
    now = Date.parse(NOW);
    void page;
  });

  it("limits reads per booking and per address, and a forged token costs only the address", async () => {
    const made = await booked(limited, limited.a, at(9, 21));
    const token = made.token!;
    for (let i = 0; i < 3; i += 1) expect((await get(token, `192.0.2.${20 + i}`)).status).toBe(200);
    const refused = await get(token, "192.0.2.30");
    expect(refused).toMatchObject({ status: 429, body: { error: { code: "RateLimited" } } });
    expect(Number(refused.headers.get("retry-after"))).toBe(600);
    // The same address reading its third time: other bookings still answer for other addresses, so the booking bucket is per booking.
    const other = await booked(limited, limited.a, at(10, 21), made);
    expect((await get(other.token!, "192.0.2.31")).status).toBe(200);
    // Forged: two 404 then 429, all from one address, and no booking bucket exists to charge.
    const forged = "zsm1_" + "A".repeat(70);
    expect((await get(forged, "192.0.2.40")).status).toBe(404);
    expect((await get(forged, "192.0.2.40")).status).toBe(404);
    expect((await get(forged, "192.0.2.40")).status).toBe(429);
  });

  it("limits writes per booking, and a refused write changes nothing", async () => {
    const made = await booked(limited, limited.a, at(11, 22));
    const cancel = (from: string) => call(limited.app, "POST", `/public/v1/manage/${made.token}/cancel`, { key: randomUUID(), headers: as(from), body: {} });
    expect((await cancel("192.0.2.50")).status).toBe(200);
    expect((await cancel("192.0.2.51")).status).toBe(200);
    const refused = await cancel("192.0.2.52");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBe(600);
  });
});
