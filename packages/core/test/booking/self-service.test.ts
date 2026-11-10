// The customer's own booking link (docs/requirements/booking-self-service.md BS-1..BS-8) through the manage session, the
// public session and the shared dispatcher under the runtime role: the confirmation email, who a token reaches, cancel,
// reschedule (atomic, one of two concurrent moves loses), idempotency and two-tenant denial. The clock is injected.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionError, SELF_CANCEL_ACTION, SELF_RESCHEDULE_ACTION, type MessageSendRequested,
} from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { confirmBooking } from "../../src/edge/confirm-booking.js";
import { createManageSession } from "../../src/edge/manage-session.js";
import { createPublicSession, publicIntakeActorId } from "../../src/edge/public-session.js";
import { confirmationMessageId, createSession, directDispatch, signManageToken, verifyManageToken, type EdgeDependencies } from "../../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");
const SECRET = "k".repeat(40);
const BASE = "https://hub.example.com";

let database: TestDatabase;
let fixture: TwoTenantFixture;
let resourceId: string;
let fineResourceId: string;
let resourceIdB: string;
let pageId: string;
let pageIdB: string;
let owner: string;

const deps = (now = START, keys = true): EdgeDependencies => ({
  db: database.db, clock: { now: () => new Date(now) }, generateId: randomUUID,
  ...(keys ? { bookingKeys: { secret: SECRET, publicBaseUrl: BASE } } : {}),
});
const manage = (now = START) => createManageSession(deps(now), { current: SECRET }, BASE);
const tokenFor = (bookingId: string, startsAt: string, tenantId = fixture.a.tenantId) =>
  signManageToken(SECRET, { tenantId, bookingId, expiresAt: Math.ceil(Date.parse(startsAt) / 1000) });
const handleFor = (bookingId: string, startsAt: string, now = START) => {
  const handle = manage(now).open(tokenFor(bookingId, startsAt));
  if (!handle) throw new Error("token did not verify");
  return handle;
};
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

let hour = 0;
/** Each booking takes the next free hour from 2 November on (09:00..16:00 UTC, eight a day). */
const nextStart = () => `2026-11-${String(2 + Math.floor(hour / 8)).padStart(2, "0")}T${String(9 + (hour++ % 8)).padStart(2, "0")}:00:00.000Z`;

interface Made { readonly id: string; readonly startsAt: string; readonly intakeItemId: string; }
async function visitorBooks(over: { email?: string; phone?: string | null; startsAt?: string; resource?: string; keys?: boolean; key?: string; name?: string } = {}): Promise<Made> {
  const startsAt = over.startsAt ?? nextStart();
  const reply = await createPublicSession(deps(START, over.keys ?? true), { tenantId: fixture.a.tenantId, pageId }).request({
    resourceId: over.resource ?? resourceId, startsAt, name: over.name ?? "Web Visitor", email: over.email ?? `${randomUUID().slice(0, 8)}@example.com`,
    phone: over.phone ?? null, notes: null, consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, over.key ?? randomUUID());
  const row = (await fixture.service((tx) => tx.query<{ id: string }>(
    "SELECT id FROM bookings WHERE tenant_id=$1 AND intake_item_id=$2", [fixture.a.tenantId, reply.requestId]))).rows[0]!;
  return { id: row.id, startsAt, intakeItemId: reply.requestId };
}
const bookingRow = async (id: string) => (await fixture.service((tx) => tx.query<{
  status: string; source: string; cancelled_by: string | null; cancel_reason: string | null; cancelled_at: Date | null;
  intake_item_id: string; rescheduled_from: string | null; starts_at: Date; resource_id: string;
}>("SELECT status, source, cancelled_by, cancel_reason, cancelled_at, intake_item_id, rescheduled_from, starts_at, resource_id FROM bookings WHERE tenant_id=$1 AND id=$2",
  [fixture.a.tenantId, id]))).rows[0]!;
const confirmations = async (bookingId: string) => (await fixture.service((tx) => tx.query<{ payload: MessageSendRequested }>(
  "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId'=$2",
  [fixture.a.tenantId, confirmationMessageId(fixture.a.tenantId, bookingId)]))).rows.map((row) => row.payload);
const messageEventCount = async () => Number((await fixture.service((tx) => tx.query<{ n: string }>(
  "SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested'", [fixture.a.tenantId]))).rows[0]!.n);
const liveAt = async (resource: string, startsAt: string) => (await fixture.service((tx) => tx.query(
  "SELECT 1 FROM bookings WHERE tenant_id=$1 AND resource_id=$2 AND starts_at=$3 AND status='confirmed'", [fixture.a.tenantId, resource, startsAt]))).rowCount;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  resourceId = randomUUID(); fineResourceId = randomUUID(); resourceIdB = randomUUID(); pageId = randomUUID(); pageIdB = randomUUID();
  owner = randomUUID();
  const weekly = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })));
  await fixture.service(async (tx) => {
    for (const [tenantId, id, step] of [[fixture.a.tenantId, resourceId, 60], [fixture.a.tenantId, fineResourceId, 30], [fixture.b.tenantId, resourceIdB, 60]] as const) {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'Consult','UTC',$3::jsonb,'[]'::jsonb,60,$4,0,0,0,525600)`, [tenantId, id, weekly, step]);
    }
    await tx.query("UPDATE tenants SET name='Corner Clinic' WHERE tenant_id=$1", [fixture.a.tenantId]);
    for (const [tenantId, id, resources] of [[fixture.a.tenantId, pageId, [resourceId, fineResourceId]], [fixture.b.tenantId, pageIdB, [resourceIdB]]] as const) {
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)", [tenantId, id, new Date(START)]);
      for (const [position, resource] of resources.entries())
        await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,$4)", [tenantId, id, resource, position]);
    }
    await tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,'o@example.com',$3,'owner',$4,$4)",
      [fixture.a.tenantId, randomUUID(), owner, new Date(START)]);
  });
});
afterAll(async () => { await database?.close(); });

describe("the confirmation email (BS-3)", () => {
  it("queues one plain transactional email with the business, the local time and a link that opens the booking", async () => {
    const made = await visitorBooks({ name: "Ana Reyes" });
    const sent = await confirmations(made.id);
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message).toMatchObject({ channel: "email", purpose: "transactional" });
    expect(message.subject).toContain("is confirmed");
    expect(message.body).toContain("Hi Ana,");
    expect(message.body).toContain("Corner Clinic");
    expect(message.body).toContain("(UTC)");
    const link = message.body.match(/https:\/\/hub\.example\.com\/manage\/(zsm1_[A-Za-z0-9_-]{70})/);
    expect(link).not.toBeNull();
    expect(verifyManageToken({ current: SECRET }, link![1]!)).toEqual({
      tenantId: fixture.a.tenantId, bookingId: made.id, expiresAt: Math.ceil(Date.parse(made.startsAt) / 1000),
    });
    const view = await manage().open(link![1]!)!.view();
    expect(view).toMatchObject({ state: "confirmed", businessName: "Corner Clinic", startsAt: made.startsAt, canChange: true });
  });

  it("sends once per booking: the visitor's retry under the same key sends nothing more", async () => {
    const key = randomUUID();
    const same = { key, email: `${randomUUID().slice(0, 8)}@example.com`, startsAt: nextStart() };
    const made = await visitorBooks(same);
    const before = await messageEventCount();
    const again = await visitorBooks(same);
    expect(again.id).toBe(made.id);
    expect(await messageEventCount()).toBe(before);
    expect(await confirmations(made.id)).toHaveLength(1);
  });

  it("writes to a possible match only at the address the visitor typed", async () => {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const contact = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,'Known Person',$3,'+14155550123',$4,$4)`, [fixture.a.tenantId, contact, email, new Date(START)]));
    const matchedByEmail = await visitorBooks({ email });
    expect((await confirmations(matchedByEmail.id))[0]).toMatchObject({ contactId: contact });
    // Same person by phone but a different address: nothing goes to an unreviewed address.
    const matchedByPhone = await visitorBooks({ phone: "+14155550123" });
    expect(await confirmations(matchedByPhone.id)).toHaveLength(0);
  });

  it("sends nothing to an address that cannot receive mail, and nothing when the server has no link base", async () => {
    const bad = await visitorBooks({ email: `${randomUUID().slice(0, 8)}@example.invalid` });
    expect(await confirmations(bad.id)).toHaveLength(0);
    const unkeyed = await visitorBooks({ keys: false });
    expect(await confirmations(unkeyed.id)).toHaveLength(0);
    expect((await bookingRow(unkeyed.id)).status).toBe("confirmed");
  });

  it("never fails the visitor's booking when the confirmation cannot be built", async () => {
    const broken = { ...deps(), bookingKeys: { secret: 12345, publicBaseUrl: BASE } } as unknown as EdgeDependencies;
    const startsAt = nextStart();
    const reply = await createPublicSession(broken, { tenantId: fixture.a.tenantId, pageId }).request({
      resourceId, startsAt, name: "Quiet Visitor", email: `${randomUUID().slice(0, 8)}@example.com`, phone: null, notes: null,
      consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
    }, randomUUID());
    expect(reply).toMatchObject({ status: "confirmed", startsAt });
    expect(await liveAt(resourceId, startsAt)).toBe(1);
  });

  it("says not_confirmed for a booking that was cancelled before the email ran", async () => {
    const made = await visitorBooks({ keys: false });
    await handleFor(made.id, made.startsAt).cancel({}, randomUUID());
    const run = directDispatch(deps(), fixture.a.tenantId, publicIntakeActorId(fixture.a.tenantId), async () => undefined,
      { manage: { secret: SECRET, publicBaseUrl: BASE } });
    expect(await confirmBooking(run, fixture.a.tenantId, made.id, "booked")).toBe("not_confirmed");
    expect(await confirmations(made.id)).toHaveLength(0);
  });
});

describe("what a token reaches (BS-1, BS-2, BS-4)", () => {
  it("shows the booking and nothing else about it", async () => {
    const made = await visitorBooks();
    const view = await handleFor(made.id, made.startsAt).view();
    expect(Object.keys(view).sort()).toEqual(
      ["businessName", "canChange", "endsAt", "movedTo", "serviceName", "slotLengthMinutes", "startsAt", "state", "timeZone"]);
    expect(view).toMatchObject({ serviceName: "Consult", timeZone: "UTC", slotLengthMinutes: 60, movedTo: null });
    expect(view.endsAt).toBe(new Date(Date.parse(made.startsAt) + 3600_000).toISOString());
  });

  it("answers a forged token with no handle", () => {
    const token = tokenFor(randomUUID(), "2026-11-02T09:00:00.000Z");
    expect(manage().open(token.slice(0, -2) + "AA")).toBeNull();
    expect(createManageSession(deps(), { current: "z".repeat(40) }, BASE).open(token)).toBeNull();
  });

  it("reads a booking that is not in the token's tenant as missing, and changes nothing (two tenants)", async () => {
    const made = await visitorBooks();
    const foreign = manage().open(tokenFor(made.id, made.startsAt, fixture.b.tenantId))!;
    expect(await rejection(foreign.view())).toMatchObject({ code: "NotFound" });
    expect(await rejection(foreign.cancel({}, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect(await rejection(foreign.reschedule({ startsAt: nextStart() }, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect(await rejection(foreign.slots({ from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" }))).toMatchObject({ code: "NotFound" });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
    // A booking of tenant B cannot be reached through tenant A's token either.
    const startsAtB = "2026-12-01T09:00:00.000Z";
    const replyB = await createPublicSession(deps(), { tenantId: fixture.b.tenantId, pageId: pageIdB }).request({
      resourceId: resourceIdB, startsAt: startsAtB, name: "Other Tenant", email: `${randomUUID().slice(0, 8)}@example.com`, phone: null, notes: null,
      consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
    }, randomUUID());
    const idB = (await fixture.service((tx) => tx.query<{ id: string }>(
      "SELECT id FROM bookings WHERE tenant_id=$1 AND intake_item_id=$2", [fixture.b.tenantId, replyB.requestId]))).rows[0]!.id;
    const crossing = manage().open(tokenFor(idB, "2026-12-01T09:00:00.000Z", fixture.a.tenantId))!;
    expect(await rejection(crossing.view())).toMatchObject({ code: "NotFound" });
    expect(await rejection(crossing.cancel({}, randomUUID()))).toMatchObject({ code: "NotFound" });
    const own = await manage().open(tokenFor(idB, startsAtB, fixture.b.tenantId))!.view();
    expect(own.state).toBe("confirmed");
  });

  it("does not manage a booking the owner made by hand", async () => {
    const staff = createSession(deps(), { tenantId: fixture.a.tenantId, actorId: owner });
    const startsAt = nextStart();
    const hand = (await staff.createBooking({ resourceId, startsAt }, randomUUID())).result;
    const handle = handleFor(hand.id, startsAt);
    expect(await rejection(handle.view())).toMatchObject({ code: "NotFound" });
    expect(await rejection(handle.cancel({}, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect((await bookingRow(hand.id)).status).toBe("confirmed");
  });

  it("is dead from the booking's start: link_expired, before any other check", async () => {
    const made = await visitorBooks();
    const late = handleFor(made.id, made.startsAt, Date.parse(made.startsAt));
    expect(late.expired).toBe(true);
    for (const work of [late.view(), late.cancel({}, randomUUID()), late.reschedule({ startsAt: nextStart() }, randomUUID()),
      late.slots({ from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" })])
      expect(await rejection(work)).toMatchObject({ code: "Conflict", details: { reason: "link_expired" } });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });
});

describe("free times (BS-5)", () => {
  it("offers the booking's own resource without its own time, and nothing for a cancelled booking", async () => {
    const made = await visitorBooks();
    const day = made.startsAt.slice(0, 10);
    const handle = handleFor(made.id, made.startsAt);
    const slots = await handle.slots({ from: `${day}T00:00:00.000Z`, to: `${day}T23:00:00.000Z` });
    expect(slots.resourceId).toBe(resourceId);
    expect(slots.slots.length).toBeGreaterThan(0);
    expect(slots.slots.map((slot) => slot.startsAt)).not.toContain(made.startsAt);
    expect(await rejection(handle.slots({ from: `${day}T00:00:00.000Z`, to: `${day}T23:00:00.000Z`, resourceId }))).toMatchObject({ code: "ValidationFailed" });
    await handle.cancel({}, randomUUID());
    expect(await rejection(handle.slots({ from: `${day}T00:00:00.000Z`, to: `${day}T23:00:00.000Z` })))
      .toMatchObject({ code: "Conflict", details: { reason: "not_changeable" } });
  });
});

describe("cancelling (BS-6, BS-7)", () => {
  it("cancels as the customer, frees the slot, sends no email and replays", async () => {
    const made = await visitorBooks();
    const handle = handleFor(made.id, made.startsAt);
    const events = await messageEventCount();
    const key = randomUUID();
    const view = await handle.cancel({}, key);
    expect(view).toMatchObject({ state: "cancelled", canChange: false });
    expect(await bookingRow(made.id)).toMatchObject({ status: "cancelled", cancelled_by: null, cancel_reason: "Cancelled by the customer" });
    expect(await messageEventCount()).toBe(events);
    expect(await liveAt(resourceId, made.startsAt)).toBe(0);
    expect(await visitorBooks({ startsAt: made.startsAt })).toMatchObject({ startsAt: made.startsAt });
    // The same key replays, and a new key on a cancelled booking writes no change.
    const cancelledAt = (await bookingRow(made.id)).cancelled_at!.toISOString();
    expect(await handle.cancel({}, key)).toEqual(view);
    expect(await handle.cancel({}, randomUUID())).toMatchObject({ state: "cancelled" });
    expect((await bookingRow(made.id)).cancelled_at!.toISOString()).toBe(cancelledAt);
  });

  it("stores the action under a key a member's or a booking page's key can never equal", async () => {
    const made = await visitorBooks();
    const key = randomUUID();
    await handleFor(made.id, made.startsAt).cancel({}, key);
    const stored = (await fixture.service((tx) => tx.query<{ action_type: string }>(
      "SELECT action_type FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [fixture.a.tenantId, `manage:${made.id}:${key}`]))).rows;
    expect(stored.map((row) => row.action_type)).toEqual(["booking.self_cancel"]);
  });

  it("refuses a bad body or key before it writes anything", async () => {
    const made = await visitorBooks();
    const handle = handleFor(made.id, made.startsAt);
    for (const body of [{ bookingId: made.id }, { tenantId: fixture.a.tenantId }, { reason: "x" }, [], "x", null])
      expect(await rejection(handle.cancel(body, randomUUID())), JSON.stringify(body)).toMatchObject({ code: "ValidationFailed" });
    for (const key of [undefined, "", "not-a-uuid", 7])
      expect(await rejection(handle.cancel({}, key)), String(key)).toMatchObject({ code: "ValidationFailed" });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });

  it("refuses a booking that has started when the handler runs (too_late)", async () => {
    const made = await visitorBooks();
    const run = directDispatch(deps(Date.parse(made.startsAt) + 60_000), fixture.a.tenantId, publicIntakeActorId(fixture.a.tenantId), async () => undefined);
    const key = `manage:${made.id}:${randomUUID()}`;
    const send = (actionType: string, payload: object) => run({
      actionType, target: { tenantId: fixture.a.tenantId, type: "booking", id: made.id },
      approvalReference: { tenantId: fixture.a.tenantId, id: randomUUID() }, idempotencyKey: key + actionType, payload: JSON.parse(JSON.stringify(payload)),
    });
    expect(await rejection(send(SELF_CANCEL_ACTION, { bookingId: made.id }))).toMatchObject({ code: "Conflict", details: { reason: "too_late" } });
    expect(await rejection(send(SELF_RESCHEDULE_ACTION, { bookingId: made.id, newBookingId: randomUUID(), startsAt: nextStart() })))
      .toMatchObject({ code: "Conflict", details: { reason: "too_late" } });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });
});

describe("rescheduling (BS-8)", () => {
  it("moves the booking: the old one is cancelled by the customer, the new one keeps the source and the request, and a new email goes out", async () => {
    const made = await visitorBooks();
    const target = nextStart();
    const handle = handleFor(made.id, made.startsAt);
    const reply = await handle.reschedule({ startsAt: target }, randomUUID());
    expect(reply.view).toMatchObject({ state: "confirmed", startsAt: target, canChange: true });
    const ref = verifyManageToken({ current: SECRET }, reply.token)!;
    expect(ref).toMatchObject({ tenantId: fixture.a.tenantId, expiresAt: Math.ceil(Date.parse(target) / 1000) });
    expect(await bookingRow(made.id)).toMatchObject({ status: "cancelled", cancelled_by: null, cancel_reason: "Rescheduled by the customer" });
    expect(await bookingRow(ref.bookingId)).toMatchObject({
      status: "confirmed", source: "website", intake_item_id: made.intakeItemId, rescheduled_from: made.id, resource_id: resourceId,
    });
    const email = await confirmations(ref.bookingId);
    expect(email).toHaveLength(1);
    expect(email[0]!.subject).toContain("is moved to");
    expect(email[0]!.body).toContain(`/manage/${reply.token}`);
    // The old link still leads to the live booking.
    const old = await handle.view();
    expect(old.state).toBe("moved");
    expect(old.movedTo).toMatchObject({ startsAt: target });
    expect(verifyManageToken({ current: SECRET }, old.movedTo!.token)).toMatchObject({ bookingId: ref.bookingId });
  });

  it("replays one key to the same new booking, and refuses the same key with another time", async () => {
    const made = await visitorBooks();
    const target = nextStart();
    const handle = handleFor(made.id, made.startsAt);
    const key = randomUUID();
    const first = await handle.reschedule({ startsAt: target }, key);
    const again = await handle.reschedule({ startsAt: target }, key);
    expect(again.token).toBe(first.token);
    expect(await rejection(handle.reschedule({ startsAt: nextStart() }, key))).toMatchObject({ code: "IdempotencyConflict" });
    const moved = await fixture.service((tx) => tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND rescheduled_from=$2", [fixture.a.tenantId, made.id]));
    expect(moved.rowCount).toBe(1);
  });

  it("refuses the booking's own time before it changes anything", async () => {
    const made = await visitorBooks();
    expect(await rejection(handleFor(made.id, made.startsAt).reschedule({ startsAt: made.startsAt }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "same_time" } });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });

  it("rolls everything back when the new time is taken: the old booking stays confirmed", async () => {
    const made = await visitorBooks();
    const taken = await visitorBooks();
    expect(await rejection(handleFor(made.id, made.startsAt).reschedule({ startsAt: taken.startsAt }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    expect(await bookingRow(made.id)).toMatchObject({ status: "confirmed", cancel_reason: null, cancelled_at: null });
    expect((await fixture.service((tx) => tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND rescheduled_from=$2", [fixture.a.tenantId, made.id]))).rowCount).toBe(0);
    // A time outside the opening hours and one in the past fail the same way.
    for (const startsAt of ["2026-11-02T03:00:00.000Z", "2026-10-01T09:00:00.000Z"])
      expect(await rejection(handleFor(made.id, made.startsAt).reschedule({ startsAt }, randomUUID())), startsAt).toBeInstanceOf(ActionError);
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });

  it("may move into a time that overlaps its own old time, because the old time is freed first", async () => {
    const startsAt = "2026-12-07T10:00:00.000Z";
    const made = await visitorBooks({ resource: fineResourceId, startsAt });
    const overlapping = "2026-12-07T10:30:00.000Z";
    const reply = await handleFor(made.id, made.startsAt).reschedule({ startsAt: overlapping }, randomUUID());
    expect(reply.view).toMatchObject({ state: "confirmed", startsAt: overlapping });
    expect((await bookingRow(made.id)).status).toBe("cancelled");
    expect(await liveAt(fineResourceId, startsAt)).toBe(0);
    expect(await liveAt(fineResourceId, overlapping)).toBe(1);
  });

  it("lets two customers moving to one free slot race: one commits, the other keeps their old booking", async () => {
    const first = await visitorBooks();
    const second = await visitorBooks();
    const target = nextStart();
    const settled = await Promise.allSettled([
      handleFor(first.id, first.startsAt).reschedule({ startsAt: target }, randomUUID()),
      handleFor(second.id, second.startsAt).reschedule({ startsAt: target }, randomUUID()),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    expect(await liveAt(resourceId, target)).toBe(1);
    const winnerIndex = settled.findIndex((entry) => entry.status === "fulfilled");
    const [winner, loser] = winnerIndex === 0 ? [first, second] : [second, first];
    expect((await bookingRow(winner.id)).status).toBe("cancelled");
    expect((await bookingRow(loser.id)).status).toBe("confirmed");
  });

  it("refuses a booking that is already cancelled", async () => {
    const made = await visitorBooks();
    const handle = handleFor(made.id, made.startsAt);
    await handle.cancel({}, randomUUID());
    expect(await rejection(handle.reschedule({ startsAt: nextStart() }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "not_changeable" } });
  });

  it("refuses a body that names anything but the start", async () => {
    const made = await visitorBooks();
    const handle = handleFor(made.id, made.startsAt);
    for (const body of [{}, { startsAt: "tomorrow" }, { startsAt: nextStart(), resourceId }, { startsAt: nextStart(), tenantId: fixture.a.tenantId }, null])
      expect(await rejection(handle.reschedule(body, randomUUID())), JSON.stringify(body)).toMatchObject({ code: "ValidationFailed" });
    expect((await bookingRow(made.id)).status).toBe("confirmed");
  });
});

describe("storage (BS-11)", () => {
  it("lets a booking point at an earlier one in its tenant only, and never at itself", async () => {
    const made = await visitorBooks();
    const clash = async (id: string, from: string, tenantId = fixture.a.tenantId) => {
      try {
        await fixture.service((tx) => tx.query("UPDATE bookings SET rescheduled_from=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, id, from]));
      } catch (error) { return (error as { constraint?: string }).constraint; }
      return undefined;
    };
    expect(await clash(made.id, made.id)).toBe("bookings_rescheduled_from_other");
    expect(await clash(made.id, randomUUID())).toBe("bookings_rescheduled_from_fk");
  });
});
