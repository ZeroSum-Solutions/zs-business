// booking.cancel (docs/requirements/booking.md B-29..B-35) through the session and the shared dispatcher under the
// runtime role: who may cancel, the one-way status change, the freed slot, the customer notice, idempotency, the
// booking_over refusal, validation, and two-tenant denial. The clock is injected and never moves on its own.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, IdempotencyConflict, type MemberRole, type MessageSendRequested } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../../src/edge/public-session.js";
import { lockResource } from "../../src/booking/cancel.js";
import { createSession, type EdgeDependencies, type Session } from "../../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");

let database: TestDatabase;
let fixture: TwoTenantFixture;
let resourceId: string;
let resourceIdB: string;
let pageId: string;
let owner: string;
let staff: string;
let ownerB: string;
let a: Session;
let b: Session;

const deps = (now = START): EdgeDependencies => ({ db: database.db, clock: { now: () => new Date(now) }, generateId: randomUUID });
const sessionFor = (actorId: string, tenantId = fixture.a.tenantId, now = START): Session => createSession(deps(now), { tenantId, actorId });

async function addMember(tenantId: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}
async function sqlRejection(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try { await promise; } catch (error) { return error as { code?: string; constraint?: string }; }
  throw new Error("Expected a rejection");
}

/** Each booking takes the next free hour, from 2 November on, so none overlaps another. */
let hour = 0;
const slotFor = (n: number) =>
  `2026-11-${String(2 + Math.floor(n / 8)).padStart(2, "0")}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
const nextStart = () => slotFor(hour++);
async function book(session: Session = a, startsAt = nextStart(), resource = resourceId) {
  return (await session.createBooking({ resourceId: resource, startsAt }, randomUUID())).result;
}
async function contact(session: Session, displayName: string, email: string | null = `${randomUUID().slice(0, 8)}@example.com`) {
  return (await session.upsertContact({ displayName, ...(email ? { email } : {}) }, randomUUID())).result.contact.id;
}
async function websiteBooking(): Promise<string> {
  const reply = await createPublicSession(deps(), { tenantId: fixture.a.tenantId, pageId }).request({
    resourceId, startsAt: nextStart(), name: "Web Visitor", email: `${randomUUID().slice(0, 8)}@example.com`, phone: null, notes: null,
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  return (await fixture.service((tx) => tx.query<{ id: string }>(
    "SELECT id FROM bookings WHERE tenant_id=$1 AND intake_item_id=$2", [fixture.a.tenantId, reply.requestId],
  ))).rows[0]!.id;
}
async function outboxFor(actionId: string) {
  return (await fixture.service((tx) => tx.query<{ event_type: string; payload: MessageSendRequested }>(
    "SELECT event_type, payload FROM outbox WHERE tenant_id=$1 AND action_id=$2", [fixture.a.tenantId, actionId],
  ))).rows;
}
const rowOf = async (id: string) => (await fixture.service((tx) => tx.query<{
  status: string; cancelled_at: Date | null; cancelled_by: string | null; cancel_reason: string | null;
}>("SELECT status, cancelled_at, cancelled_by, cancel_reason FROM bookings WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, id]))).rows[0]!;
const messageEvents = async () => Number((await fixture.service((tx) => tx.query<{ n: string }>(
  "SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested'", [fixture.a.tenantId],
))).rows[0]!.n);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  resourceId = randomUUID();
  resourceIdB = randomUUID();
  pageId = randomUUID();
  const weekly = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })));
  await fixture.service(async (tx) => {
    for (const [tenantId, id] of [[fixture.a.tenantId, resourceId], [fixture.b.tenantId, resourceIdB]] as const) {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`, [tenantId, id, weekly]);
    }
    await tx.query("UPDATE tenants SET name='Corner Clinic' WHERE tenant_id=$1", [fixture.a.tenantId]);
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [fixture.a.tenantId, pageId, new Date(START)],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [fixture.a.tenantId, pageId, resourceId]);
  });
  owner = await addMember(fixture.a.tenantId, "owner");
  staff = await addMember(fixture.a.tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
  a = sessionFor(staff);
  b = sessionFor(ownerB, fixture.b.tenantId);
});
afterAll(async () => { await database?.close(); });

describe("cancelling (B-29, B-30)", () => {
  it("a staff member cancels: the row, the result and the audit columns agree", async () => {
    const booking = await book();
    const done = await a.cancelBooking(booking.id, { reason: "  Staff sick  " }, randomUUID());
    expect(done.result).toMatchObject({
      booking: { id: booking.id, status: "cancelled", startsAt: booking.startsAt }, cancelledAt: new Date(START).toISOString(),
      reason: "Staff sick", customerNotice: "no_customer",
    });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: staff, cancel_reason: "Staff sick" });
    expect((await rowOf(booking.id)).cancelled_at?.toISOString()).toBe(new Date(START).toISOString());
    // The action row is the audit record: it names the action and the booking.
    const action = (await fixture.service((tx) => tx.query<{ action_type: string }>(
      "SELECT action_type FROM actions WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, done.actionId],
    ))).rows[0]!;
    expect(action.action_type).toBe("booking.cancel");
  });

  it("an owner cancels without a reason or a body", async () => {
    const booking = await book();
    const done = await sessionFor(owner).cancelBooking(booking.id, undefined, randomUUID());
    expect(done.result).toMatchObject({ booking: { status: "cancelled" }, reason: null });
    expect(await rowOf(booking.id)).toMatchObject({ cancelled_by: owner, cancel_reason: null });
  });

  it("a cancelled booking leaves the default list, shows under cancelled and all, and the detail says why", async () => {
    const [kept, gone] = [await book(), await book()];
    await a.cancelBooking(gone.id, { reason: "Moved away" }, randomUUID());
    const window = { from: kept.startsAt, to: new Date(Date.parse(gone.endsAt) + 86400_000).toISOString() };
    const ids = async (status?: "confirmed" | "cancelled" | "all") =>
      (await a.listBookings({ limit: 100, ...window, ...(status ? { status } : {}) })).items.map((item) => item.id);
    expect(await ids()).toContain(kept.id);
    expect(await ids()).not.toContain(gone.id);
    expect(await ids("confirmed")).not.toContain(gone.id);
    expect(await ids("cancelled")).toContain(gone.id);
    expect(await ids("cancelled")).not.toContain(kept.id);
    const all = await ids("all");
    expect(all).toEqual(expect.arrayContaining([kept.id, gone.id]));
    expect(await a.getBooking(gone.id)).toMatchObject({
      id: gone.id, cancelledAt: new Date(START).toISOString(), cancellationReason: "Moved away",
    });
    const live = await a.getBooking(kept.id);
    expect(live).not.toHaveProperty("cancelledAt");
    expect(live).not.toHaveProperty("cancellationReason");
  });

  it("refuses a booking that already ended with booking_over and writes nothing", async () => {
    const booking = await book();
    const later = sessionFor(staff, fixture.a.tenantId, Date.parse(booking.endsAt) + 1000);
    expect(await rejection(later.cancelBooking(booking.id, {}, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "booking_over" } });
    expect(await rowOf(booking.id)).toMatchObject({ status: "confirmed", cancelled_at: null });
  });

  it("refuses an unknown booking as NotFound", async () => {
    expect(await rejection(a.cancelBooking(randomUUID(), {}, randomUUID()))).toMatchObject({ code: "NotFound" });
  });
});

describe("the freed slot (B-32)", () => {
  it("shows the slot again, and the same hour can be booked again", async () => {
    const startsAt = nextStart();
    const first = await book(a, startsAt);
    const range = { resourceId, from: startsAt, to: new Date(Date.parse(startsAt) + 3600_000).toISOString() };
    expect((await a.findSlots(range)).slots.map((slot) => slot.startsAt)).not.toContain(startsAt);
    expect(await rejection(a.createBooking({ resourceId, startsAt }, randomUUID()))).toMatchObject({ code: "Conflict" });
    await a.cancelBooking(first.id, {}, randomUUID());
    expect((await a.findSlots(range)).slots.map((slot) => slot.startsAt)).toContain(startsAt);
    const second = await book(a, startsAt);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("confirmed");
  });

  it("lets two concurrent creates for the freed slot race: one wins, one gets Conflict", async () => {
    const startsAt = nextStart();
    const first = await book(a, startsAt);
    await a.cancelBooking(first.id, {}, randomUUID());
    const settled = await Promise.allSettled([
      sessionFor(staff).createBooking({ resourceId, startsAt }, randomUUID()),
      sessionFor(owner).createBooking({ resourceId, startsAt }, randomUUID()),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const lost = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "Conflict" });
    const live = await fixture.service((tx) => tx.query(
      "SELECT 1 FROM bookings WHERE tenant_id=$1 AND resource_id=$2 AND starts_at=$3 AND status='confirmed'", [fixture.a.tenantId, resourceId, startsAt]));
    expect(live.rowCount).toBe(1);
  });
});

describe("concurrency (B-21, B-31)", () => {
  it("two cancels under different keys: one cancels and queues the notice, the other is already_cancelled", async () => {
    const id = await contact(a, "Dee Race");
    const booking = await book();
    await a.linkBookingContact(booking.id, { contactId: id, expectedRevision: 0 }, randomUUID());
    const before = await messageEvents();
    const settled = await Promise.all([
      sessionFor(staff).cancelBooking(booking.id, { reason: "one" }, randomUUID()),
      sessionFor(owner).cancelBooking(booking.id, { reason: "two" }, randomUUID()),
    ]);
    expect(settled.map((done) => done.result.customerNotice).sort()).toEqual(["already_cancelled", "queued"]);
    expect(await messageEvents()).toBe(before + 1);
    // Both answers describe the one stored cancellation.
    expect(new Set(settled.map((done) => done.result.reason)).size).toBe(1);
    expect((await rowOf(booking.id)).cancel_reason).toBe(settled[0]!.result.reason);
  });

  it("a cancel racing a create for the same slot leaves at most one confirmed booking, and both answers are valid", async () => {
    const startsAt = nextStart();
    const first = await book(a, startsAt);
    const settled = await Promise.allSettled([
      sessionFor(staff).cancelBooking(first.id, {}, randomUUID()),
      sessionFor(owner).createBooking({ resourceId, startsAt }, randomUUID()),
    ]);
    expect(settled[0]!.status).toBe("fulfilled");
    if (settled[1]!.status === "rejected") expect(settled[1]!.reason).toMatchObject({ code: "Conflict" });
    const live = await fixture.service((tx) => tx.query(
      "SELECT 1 FROM bookings WHERE tenant_id=$1 AND resource_id=$2 AND starts_at=$3 AND status='confirmed'", [fixture.a.tenantId, resourceId, startsAt]));
    expect(live.rowCount).toBe(settled[1]!.status === "fulfilled" ? 1 : 0);
    expect((await rowOf(first.id)).status).toBe("cancelled");
  });

  it("decides on the time after the resource lock: a wait that crosses the end refuses with booking_over", async () => {
    const booking = await book();
    let now = START;
    const slow = createSession({ db: database.db, clock: { now: () => new Date(now) }, generateId: randomUUID }, { tenantId: fixture.a.tenantId, actorId: staff });
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = fixture.service(async (tx) => { await lockResource(tx, fixture.a.tenantId, resourceId); locked(); await held; });
    await hasLock;
    const attempt = rejection(slow.cancelBooking(booking.id, {}, randomUUID()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    now = Date.parse(booking.endsAt) + 1000;
    release();
    await holder;
    expect(await attempt).toMatchObject({ code: "Conflict", details: { reason: "booking_over" } });
    expect((await rowOf(booking.id)).status).toBe("confirmed");
  });
});

describe("idempotency (B-31)", () => {
  it("replays one key to the same action and writes once", async () => {
    const booking = await book();
    const key = randomUUID();
    const one = await a.cancelBooking(booking.id, { reason: "Once" }, key);
    const two = await a.cancelBooking(booking.id, { reason: "Once" }, key);
    expect(two.actionId).toBe(one.actionId);
    expect(two.result).toEqual(one.result);
  });

  it("the same key with a different body is an idempotency conflict", async () => {
    const booking = await book();
    const key = randomUUID();
    await a.cancelBooking(booking.id, { reason: "First" }, key);
    expect(await rejection(a.cancelBooking(booking.id, { reason: "Second" }, key))).toBeInstanceOf(IdempotencyConflict);
    expect((await rowOf(booking.id)).cancel_reason).toBe("First");
  });

  it("a new key on a cancelled booking changes nothing, sends nothing and says already_cancelled", async () => {
    const customerId = await contact(a, "Ana Ruiz");
    const booking = await book();
    await a.linkBookingContact(booking.id, { contactId: customerId, expectedRevision: 0 }, randomUUID());
    const first = await a.cancelBooking(booking.id, { reason: "First reason" }, randomUUID());
    expect(first.result.customerNotice).toBe("queued");
    const before = await messageEvents();
    const again = await a.cancelBooking(booking.id, { reason: "Other reason" }, randomUUID());
    expect(again.actionId).not.toBe(first.actionId);
    expect(again.result).toMatchObject({
      customerNotice: "already_cancelled", reason: "First reason", cancelledAt: first.result.cancelledAt,
    });
    expect(await messageEvents()).toBe(before);
    expect(await rowOf(booking.id)).toMatchObject({ cancel_reason: "First reason", cancelled_by: staff });
  });
});

describe("the customer notice (B-33)", () => {
  it("queues one transactional email with the local time, the business and no reason", async () => {
    const customerId = await contact(a, "Ana Ruiz");
    const booking = await book(a, "2026-11-20T11:00:00.000Z");
    await a.linkBookingContact(booking.id, { contactId: customerId, expectedRevision: 0 }, randomUUID());
    const done = await a.cancelBooking(booking.id, { reason: "Private: the doctor quit" }, randomUUID());
    expect(done.result.customerNotice).toBe("queued");
    const events = await outboxFor(done.actionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("message.send_requested");
    const message = events[0]!.payload;
    expect(message).toMatchObject({ contactId: customerId, channel: "email", purpose: "transactional" });
    expect(message.subject).toContain("is cancelled");
    expect(message.subject).toContain("11:00 AM");
    expect(message.body).toContain("Hi Ana,");
    expect(message.body).toContain("Corner Clinic");
    expect(message.body).toContain("(UTC)");
    expect(JSON.stringify(message)).not.toContain("doctor quit");
  });

  it("sends nothing when the owner turns the notice off", async () => {
    const customerId = await contact(a, "Ben Okafor");
    const booking = await book();
    await a.linkBookingContact(booking.id, { contactId: customerId, expectedRevision: 0 }, randomUUID());
    const done = await a.cancelBooking(booking.id, { notifyCustomer: false }, randomUUID());
    expect(done.result.customerNotice).toBe("off");
    const events = await outboxFor(done.actionId);
    expect(events.map((event) => event.event_type)).toEqual(["booking.cancel"]);
  });

  it("says no_customer when nobody is linked and no_email when the contact has no address", async () => {
    const bare = await book();
    expect((await a.cancelBooking(bare.id, {}, randomUUID())).result.customerNotice).toBe("no_customer");
    const phoneOnly = (await a.upsertContact({ displayName: "Cy Dole", phone: "+14155550100" }, randomUUID())).result.contact.id;
    const booking = await book();
    await a.linkBookingContact(booking.id, { contactId: phoneOnly, expectedRevision: 0 }, randomUUID());
    const done = await a.cancelBooking(booking.id, {}, randomUUID());
    expect(done.result.customerNotice).toBe("no_email");
    expect((await outboxFor(done.actionId)).map((event) => event.event_type)).toEqual(["booking.cancel"]);
  });

  it("writes to the person who booked on the website", async () => {
    const id = await websiteBooking();
    const done = await a.cancelBooking(id, {}, randomUUID());
    expect(done.result.customerNotice).toBe("queued");
    const events = await outboxFor(done.actionId);
    expect(events[0]!.payload.body).toContain("Hi Web,");
  });
});

describe("validation (B-29)", () => {
  it("rejects a bad body before it writes anything", async () => {
    const booking = await book();
    const bad: unknown[] = [
      { reason: "x".repeat(501) }, { reason: "" }, { notifyCustomer: "yes" }, { extra: true }, { reason: "bad\u0000text" },
      { reason: "two\nlines" }, { reason: "two\r\nlines" }, { reason: "para\u2029sep" }, null,
    ];
    for (const body of bad) {
      expect(await rejection(a.cancelBooking(booking.id, body, randomUUID())), JSON.stringify(body)).toMatchObject({ code: "ValidationFailed" });
    }
    expect(await rejection(a.cancelBooking("not-an-id", {}, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect((await rowOf(booking.id)).status).toBe("confirmed");
  });
});

describe("two tenants (B-35)", () => {
  it("tenant B cannot cancel tenant A's booking and learns nothing about it", async () => {
    const booking = await book();
    expect(await rejection(b.cancelBooking(booking.id, {}, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect((await rowOf(booking.id)).status).toBe("confirmed");
    expect((await b.listBookings({ status: "all", limit: 100 })).items).toHaveLength(0);
    // Once it is cancelled, tenant B still cannot read the cancellation or find it in the history.
    await a.cancelBooking(booking.id, { reason: "Private" }, randomUUID());
    expect(await rejection(b.getBooking(booking.id))).toMatchObject({ code: "NotFound" });
    expect((await b.listBookings({ status: "cancelled", limit: 100 })).items).toHaveLength(0);
  });

  it("the runtime role cannot cross tenants with SQL, reopen a cancelled booking or cancel without a stamp", async () => {
    const booking = await book();
    // Another tenant's session updates zero rows.
    const crossed = await fixture.b.run((tx) => tx.query(
      "UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1", [booking.id]));
    expect(crossed.rowCount).toBe(0);
    // A cancel needs its stamp.
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "23514", constraint: "bookings_cancelled_fields" });
    // A cancelled row cannot be reopened, and it cannot change other fields.
    await a.cancelBooking(booking.id, {}, randomUUID());
    expect(await sqlRejection(fixture.a.run((tx) => tx.query(
      "UPDATE bookings SET status='confirmed', cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "42501" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE bookings SET starts_at=starts_at WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "42501" });
    expect((await rowOf(booking.id)).status).toBe("cancelled");
  });

  it("holds for the API's own login after RESET ROLE (G-4 pattern), not only for `authenticated`", async () => {
    const booking = await book();
    await a.cancelBooking(booking.id, {}, randomUUID());
    const reopen = fixture.a.run(async (tx) => {
      await tx.query("RESET ROLE");
      expect((await tx.query("SELECT current_user AS u")).rows[0]).toEqual({ u: "zs_runtime" });
      return tx.query("UPDATE bookings SET status='confirmed', cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL WHERE id=$1", [booking.id]);
    });
    expect(await sqlRejection(reopen)).toMatchObject({ code: "42501" });
    expect((await rowOf(booking.id)).status).toBe("cancelled");
  });
});

describe("the exclusion constraint (B-32)", () => {
  const insert = `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,
    buffer_before_minutes,buffer_after_minutes,status,created_at,cancelled_at)
    VALUES ($1,$2,$3,$4,$5,$4,$5,0,0,$6,$7,$8)`;

  it("lets a row overlap a cancelled one but not a confirmed one", async () => {
    const start = "2027-03-01T09:00:00Z";
    const end = "2027-03-01T10:00:00Z";
    const row = (status: string, stamp: Date | null) => [fixture.a.tenantId, randomUUID(), resourceId, start, end, status, new Date(START), stamp];
    await fixture.service((tx) => tx.query(insert, row("cancelled", new Date(START))));
    await fixture.service((tx) => tx.query(insert, row("confirmed", null)));
    expect(await sqlRejection(fixture.service((tx) => tx.query(insert, row("confirmed", null)))))
      .toMatchObject({ code: "23P01", constraint: "bookings_resource_occupied_excl" });
    await fixture.service((tx) => tx.query(insert, row("cancelled", new Date(START))));
  });
});
