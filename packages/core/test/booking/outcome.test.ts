// booking.outcome.set (docs/requirements/booking.md B-37..B-46) through the session and the shared dispatcher under the
// runtime role: who may mark, the injected clock, replacing a mark, the audit trail, idempotent replay, the cancelled
// booking, validation and two-tenant denial. The clock is injected and never moves on its own.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, IdempotencyConflict, type MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, type EdgeDependencies, type Session } from "../../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");

let database: TestDatabase;
let fixture: TwoTenantFixture;
let resourceId: string;
let resourceIdB: string;
let owner: string;
let staff: string;
let ownerB: string;
let a: Session;
let b: Session;

const deps = (now = START): EdgeDependencies => ({ db: database.db, clock: { now: () => new Date(now) }, generateId: randomUUID });
const sessionFor = (actorId: string, tenantId = fixture.a.tenantId, now = START): Session => createSession(deps(now), { tenantId, actorId });
/** The same member, with the clock at an instant: bookings are made at START and marked later. */
const at = (instant: string | number, actorId = staff, tenantId = fixture.a.tenantId): Session =>
  sessionFor(actorId, tenantId, typeof instant === "number" ? instant : Date.parse(instant));
const ms = (instant: string) => Date.parse(instant);

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
async function book(session: Session = a, resource = resourceId) {
  return (await session.createBooking({ resourceId: resource, startsAt: slotFor(hour++) }, randomUUID())).result;
}
/** A moment while the booking is running: marking is allowed from its start (B-39). */
const during = (booking: { startsAt: string }) => ms(booking.startsAt) + 30 * 60_000;

const rowOf = async (id: string) => (await fixture.service((tx) => tx.query<{
  status: string; outcome: string | null; outcome_set_at: Date | null; outcome_set_by: string | null;
}>("SELECT status, outcome, outcome_set_at, outcome_set_by FROM bookings WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, id]))).rows[0]!;
const outcomeActions = async (bookingId: string) => (await fixture.service((tx) => tx.query<{
  actor_id: string; payload: { outcome: string }; result: { outcome: string; changed: boolean };
}>(
  `SELECT actor_id, payload, result FROM actions
    WHERE tenant_id=$1 AND action_type='booking.outcome.set' AND target->>'id'=$2 ORDER BY created_at, id`,
  [fixture.a.tenantId, bookingId],
))).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  resourceId = randomUUID();
  resourceIdB = randomUUID();
  const weekly = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })));
  await fixture.service(async (tx) => {
    for (const [tenantId, id] of [[fixture.a.tenantId, resourceId], [fixture.b.tenantId, resourceIdB]] as const) {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`, [tenantId, id, weekly]);
    }
  });
  owner = await addMember(fixture.a.tenantId, "owner");
  staff = await addMember(fixture.a.tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
  a = sessionFor(staff);
  b = sessionFor(ownerB, fixture.b.tenantId);
});
afterAll(async () => { await database?.close(); });

describe("marking (B-37, B-38)", () => {
  it("a staff member marks a started booking completed: the row, the result and the audit columns agree", async () => {
    const booking = await book();
    const now = during(booking);
    const done = await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    expect(done.result).toMatchObject({
      booking: { id: booking.id, status: "confirmed", startsAt: booking.startsAt }, outcome: "completed",
      outcomeAt: new Date(now).toISOString(), changed: true,
    });
    expect(await rowOf(booking.id)).toMatchObject({ status: "confirmed", outcome: "completed", outcome_set_by: staff });
    expect((await rowOf(booking.id)).outcome_set_at?.toISOString()).toBe(new Date(now).toISOString());
    const action = (await fixture.service((tx) => tx.query<{ action_type: string }>(
      "SELECT action_type FROM actions WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, done.actionId],
    ))).rows[0]!;
    expect(action.action_type).toBe("booking.outcome.set");
  });

  it("an owner marks a no-show", async () => {
    const booking = await book();
    const done = await at(during(booking), owner).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    expect(done.result).toMatchObject({ outcome: "no_show", changed: true });
    expect(await rowOf(booking.id)).toMatchObject({ outcome: "no_show", outcome_set_by: owner });
  });

  it("a booking nobody marked reads as unknown (no outcome key, B-47) and the reads show the mark once set", async () => {
    const booking = await book();
    const now = during(booking);
    const reader = at(now);
    const window = { from: booking.startsAt, to: booking.endsAt };
    expect((await reader.listBookings(window)).items.find((item) => item.id === booking.id)).not.toHaveProperty("outcome");
    expect(await reader.getBooking(booking.id)).not.toHaveProperty("outcome");
    expect(await reader.getBooking(booking.id)).not.toHaveProperty("outcomeAt");
    await reader.setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    expect((await reader.listBookings(window)).items.find((item) => item.id === booking.id)).toMatchObject({ outcome: "completed" });
    expect(await reader.getBooking(booking.id)).toMatchObject({ outcome: "completed", outcomeAt: new Date(now).toISOString() });
  });
});

describe("the clock (B-39)", () => {
  it("rejects a mark before the start time by the injected clock, and writes nothing", async () => {
    const booking = await book();
    const early = at(ms(booking.startsAt) - 1);
    expect(await rejection(early.setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "booking_not_started" } });
    expect(await rowOf(booking.id)).toMatchObject({ outcome: null, outcome_set_at: null, outcome_set_by: null });
    expect(await outcomeActions(booking.id)).toHaveLength(0);
  });

  it("accepts a mark exactly at the start time", async () => {
    const booking = await book();
    const done = await at(booking.startsAt).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    expect(done.result).toMatchObject({ outcome: "no_show", outcomeAt: booking.startsAt, changed: true });
  });

  it("has no upper bound: a booking from long ago can still be marked", async () => {
    const booking = await book();
    const done = await at(ms(booking.endsAt) + 400 * 86_400_000).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    expect(done.result.changed).toBe(true);
  });
});

describe("the outbox (B-42)", () => {
  const outboxFor = async (actionId: string) => (await fixture.service((tx) => tx.query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type, payload FROM outbox WHERE tenant_id=$1 AND action_id=$2 ORDER BY created_at, id", [fixture.a.tenantId, actionId],
  ))).rows;

  it("writes one booking.outcome.set row with the mark, in the same commit as the state and the action", async () => {
    const booking = await book();
    const now = during(booking);
    const done = await at(now).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    const events = await outboxFor(done.actionId);
    expect(events.map((event) => event.event_type)).toEqual(["booking.outcome.set"]);
    expect(events[0]!.payload).toMatchObject({
      actionId: done.actionId, actionType: "booking.outcome.set", target: { type: "booking", id: booking.id }, result: { outcome: "no_show", changed: true },
    });
  });

  it("writes one for a repeated mark too, saying changed: false (the call is recorded like a repeat cancel)", async () => {
    const booking = await book();
    const now = during(booking);
    await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    const again = await at(now + 60_000).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    const events = await outboxFor(again.actionId);
    expect(events.map((event) => event.event_type)).toEqual(["booking.outcome.set"]);
    expect(events[0]!.payload).toMatchObject({ actionId: again.actionId, result: { outcome: "completed", changed: false } });
  });
});

describe("replacing a mark (B-39, B-40)", () => {
  it("lets completed become no_show and back, each change in its own actions row", async () => {
    const booking = await book();
    const now = during(booking);
    const first = await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    const second = await at(now + 60_000, owner).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    const third = await at(now + 120_000).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    expect([first, second, third].map((done) => done.result.changed)).toEqual([true, true, true]);
    expect(second.result.outcomeAt).toBe(new Date(now + 60_000).toISOString());
    expect(await rowOf(booking.id)).toMatchObject({ outcome: "completed", outcome_set_by: staff });
    const trail = await outcomeActions(booking.id);
    expect(trail.map((row) => row.payload.outcome)).toEqual(["completed", "no_show", "completed"]);
    expect(trail.map((row) => row.actor_id)).toEqual([staff, owner, staff]);
  });

  it("changes nothing when the booking already has that mark: changed false, the first stamp stays", async () => {
    const booking = await book();
    const now = during(booking);
    await at(now).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    const again = await at(now + 3_600_000, owner).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    expect(again.result).toMatchObject({ outcome: "no_show", outcomeAt: new Date(now).toISOString(), changed: false });
    expect(await rowOf(booking.id)).toMatchObject({ outcome: "no_show", outcome_set_by: staff });
    expect((await rowOf(booking.id)).outcome_set_at?.toISOString()).toBe(new Date(now).toISOString());
    // The call is still recorded, like a repeat cancel (B-42).
    expect((await outcomeActions(booking.id)).map((row) => row.result.changed)).toEqual([true, false]);
  });

  it("never clears a mark back to unknown", async () => {
    const booking = await book();
    const now = during(booking);
    await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    for (const outcome of [null, "unknown", ""]) {
      expect(await rejection(at(now).setBookingOutcome(booking.id, { outcome }, randomUUID())), String(outcome))
        .toMatchObject({ code: "ValidationFailed" });
    }
    expect((await rowOf(booking.id)).outcome).toBe("completed");
  });
});

describe("idempotency (B-38)", () => {
  it("replays the first answer for the same key: same action, one actions row, no second write", async () => {
    const booking = await book();
    const now = during(booking);
    const key = randomUUID();
    const first = await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, key);
    const replay = await at(now + 600_000).setBookingOutcome(booking.id, { outcome: "completed" }, key);
    expect(replay).toEqual({ ...first });
    expect(await outcomeActions(booking.id)).toHaveLength(1);
  });

  it("answers the same key with another body as IdempotencyConflict and leaves the mark alone", async () => {
    const booking = await book();
    const now = during(booking);
    const key = randomUUID();
    await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, key);
    await expect(at(now).setBookingOutcome(booking.id, { outcome: "no_show" }, key)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect((await rowOf(booking.id)).outcome).toBe("completed");
    expect(await outcomeActions(booking.id)).toHaveLength(1);
  });

  it("serializes two concurrent marks for the same booking under different keys: both succeed, the row is one of them", async () => {
    const booking = await book();
    const now = during(booking);
    const settled = await Promise.allSettled([
      at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID()),
      at(now, owner).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID()),
    ]);
    expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    const stored = (await rowOf(booking.id)).outcome;
    expect(["completed", "no_show"]).toContain(stored);
    expect(await outcomeActions(booking.id)).toHaveLength(2);
  });
});

describe("a cancelled booking has no outcome (B-39, B-41)", () => {
  it("refuses to mark a cancelled booking with booking_cancelled", async () => {
    const booking = await book();
    await a.cancelBooking(booking.id, {}, randomUUID());
    expect(await rejection(at(during(booking)).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "booking_cancelled" } });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", outcome: null });
  });

  it("clears the mark when a marked booking is then cancelled", async () => {
    const booking = await book();
    const now = during(booking);
    await at(now).setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID());
    expect((await rowOf(booking.id)).outcome).toBe("completed");
    await at(now + 60_000).cancelBooking(booking.id, { reason: "Changed mind" }, randomUUID());
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", outcome: null, outcome_set_at: null, outcome_set_by: null });
    const cancelled = (await at(now).listBookings({ status: "cancelled", from: booking.startsAt, to: booking.endsAt })).items
      .find((item) => item.id === booking.id);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled).not.toHaveProperty("outcome");
  });
});

describe("validation and unknown bookings (B-38)", () => {
  it("rejects a bad body before it writes anything", async () => {
    const booking = await book();
    const now = during(booking);
    const bad: unknown[] = [
      undefined, null, {}, { outcome: "COMPLETED" }, { outcome: "cancelled" }, { outcome: 1 }, { outcome: "completed", extra: true },
      { outcome: ["completed"] }, "completed",
    ];
    for (const body of bad) {
      expect(await rejection(at(now).setBookingOutcome(booking.id, body, randomUUID())), JSON.stringify(body)).toMatchObject({ code: "ValidationFailed" });
    }
    expect(await rejection(at(now).setBookingOutcome("not-an-id", { outcome: "completed" }, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect(await rowOf(booking.id)).toMatchObject({ outcome: null });
  });

  it("refuses an unknown booking as NotFound", async () => {
    expect(await rejection(a.setBookingOutcome(randomUUID(), { outcome: "completed" }, randomUUID()))).toMatchObject({ code: "NotFound" });
  });
});

describe("two tenants (B-45)", () => {
  it("tenant B cannot mark tenant A's booking, read its mark or list it, and learns nothing about it", async () => {
    const booking = await book();
    const now = during(booking);
    const bNow = at(now, ownerB, fixture.b.tenantId);
    expect(await rejection(bNow.setBookingOutcome(booking.id, { outcome: "completed" }, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect((await rowOf(booking.id)).outcome).toBeNull();
    // After tenant A marks it, tenant B still sees nothing of the mark.
    await at(now).setBookingOutcome(booking.id, { outcome: "no_show" }, randomUUID());
    expect(await rejection(bNow.getBooking(booking.id))).toMatchObject({ code: "NotFound" });
    expect((await bNow.listBookings({ status: "all", limit: 100 })).items).toHaveLength(0);
    // Tenant B's own booking is marked by tenant B only, and tenant A cannot touch it.
    const own = (await b.createBooking({ resourceId: resourceIdB, startsAt: slotFor(hour++) }, randomUUID())).result;
    expect(await rejection(at(during(own)).setBookingOutcome(own.id, { outcome: "completed" }, randomUUID()))).toMatchObject({ code: "NotFound" });
    const done = await at(during(own), ownerB, fixture.b.tenantId).setBookingOutcome(own.id, { outcome: "completed" }, randomUUID());
    expect(done.result.outcome).toBe("completed");
  });

  it("the runtime role cannot cross tenants with SQL, mark a cancelled row or set a mark without its stamp", async () => {
    const booking = await book();
    // Another tenant's session updates zero rows.
    const crossed = await fixture.b.run((tx) => tx.query(
      "UPDATE bookings SET outcome='completed', outcome_set_at=now(), outcome_set_by=$2 WHERE id=$1", [booking.id, ownerB]));
    expect(crossed.rowCount).toBe(0);
    // A mark needs its stamp, and a stamp needs a mark.
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE bookings SET outcome='completed' WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "23514", constraint: "bookings_outcome_fields" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE bookings SET outcome_set_at=now() WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "23514", constraint: "bookings_outcome_fields" });
    // Only the two values are stored.
    expect(await sqlRejection(fixture.a.run((tx) => tx.query(
      "UPDATE bookings SET outcome='unknown', outcome_set_at=now(), outcome_set_by=$2 WHERE id=$1", [booking.id, staff]))))
      .toMatchObject({ code: "23514" });
    // A cancelled row stays frozen for the runtime role: no mark, no other change.
    await a.cancelBooking(booking.id, {}, randomUUID());
    expect(await sqlRejection(fixture.a.run((tx) => tx.query(
      "UPDATE bookings SET outcome='completed', outcome_set_at=now(), outcome_set_by=$2 WHERE id=$1", [booking.id, staff]))))
      .toMatchObject({ code: "42501" });
    expect(await rowOf(booking.id)).toMatchObject({ status: "cancelled", outcome: null });
  });

  it("the runtime role cannot store a mark without the member who set it, nor a member without a mark (B-40)", async () => {
    const booking = await book();
    expect(await sqlRejection(fixture.a.run((tx) => tx.query(
      "UPDATE bookings SET outcome='completed', outcome_set_at=now(), outcome_set_by=NULL WHERE id=$1", [booking.id]))))
      .toMatchObject({ code: "23514", constraint: "bookings_outcome_fields" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE bookings SET outcome_set_by=$2 WHERE id=$1", [booking.id, staff]))))
      .toMatchObject({ code: "23514", constraint: "bookings_outcome_fields" });
    expect(await rowOf(booking.id)).toMatchObject({ outcome: null, outcome_set_at: null, outcome_set_by: null });
  });

  it("the runtime role can set the three outcome columns together on a confirmed row of its own tenant, and no other column", async () => {
    const booking = await book();
    const updated = await fixture.a.run((tx) => tx.query(
      "UPDATE bookings SET outcome='no_show', outcome_set_at=now(), outcome_set_by=$2 WHERE id=$1", [booking.id, staff]));
    expect(updated.rowCount).toBe(1);
    await expect(fixture.a.run((tx) => tx.query("UPDATE bookings SET starts_at=starts_at WHERE id=$1", [booking.id]))).rejects.toMatchObject({ code: "42501" });
  });
});
