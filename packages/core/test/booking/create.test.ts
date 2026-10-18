import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBookingCommandSchema,
  ValidationFailed,
  type ActionBinding,
  type BookingResource,
  type CreateBookingCommand,
} from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { bookingHandlers, createBooking, createDispatcher, crmHandlers, getAvailableSlots, type DispatchContext } from "../../src/index.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(undefined, { nonSuperuserMigrator: true }); });
afterAll(async () => { await database?.close(); });

const MONDAY_8AM = "2026-10-19T08:00:00.000Z";
const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers });

function resourceFor(tenantId: string, overrides: Partial<BookingResource> = {}): BookingResource {
  return {
    tenantId, id: randomUUID(), timeZone: "UTC",
    weekly: [
      { weekday: 7, windows: [{ startMinute: 1380, endMinute: 1440 }] },
      { weekday: 1, windows: [{ startMinute: 0, endMinute: 120 }, { startMinute: 540, endMinute: 1020 }] },
    ],
    overrides: [], slotLengthMinutes: 30, slotStepMinutes: 30,
    bufferBeforeMinutes: 15, bufferAfterMinutes: 15,
    minimumNoticeMinutes: 60, bookingHorizonMinutes: 10080,
    ...overrides,
  };
}

interface World {
  fixture: TwoTenantFixture;
  a: BookingResource;
  b: BookingResource;
}
async function world(overrides: Partial<BookingResource> = {}): Promise<World> {
  const fixture = await createTwoTenantFixture(database);
  const a = resourceFor(fixture.a.tenantId, overrides);
  const b = resourceFor(fixture.b.tenantId, overrides);
  await fixture.service(async (tx) => {
    for (const r of [a, b]) {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
        [r.tenantId, r.id, r.timeZone, JSON.stringify(r.weekly), JSON.stringify(r.overrides), r.slotLengthMinutes,
          r.slotStepMinutes, r.bufferBeforeMinutes, r.bufferAfterMinutes, r.minimumNoticeMinutes, r.bookingHorizonMinutes],
      );
    }
  });
  return { fixture, a, b };
}

function command(tenantId: string, resourceId: string, startsAt: string, extra: { bookingId?: string; key?: string } = {}): CreateBookingCommand {
  const bookingId = extra.bookingId ?? randomUUID();
  return createBookingCommandSchema.parse({
    actionType: "booking.create",
    target: { tenantId, type: "booking", id: bookingId },
    payload: { bookingId, resourceId, startsAt },
    approvalReference: { tenantId, id: randomUUID() },
    idempotencyKey: extra.key ?? randomUUID(),
  });
}

const actorIds = new Map<string, string>();
const actorFor = (tenantId: string) => {
  if (!actorIds.has(tenantId)) actorIds.set(tenantId, randomUUID());
  return actorIds.get(tenantId)!;
};

/** Bind the shared dispatcher at the "server edge"; the approval store approves the exact binding. */
function book(cmd: CreateBookingCommand, now = MONDAY_8AM, options: Partial<DispatchContext> = {}) {
  const tenantId = cmd.target.tenantId;
  const ctx: DispatchContext = {
    tenantId, actor: { tenantId, id: actorFor(tenantId) }, db: database.db,
    clock: { now: () => new Date(now) }, config: {}, generateId: randomUUID,
    resolveApproval: async (): Promise<ActionBinding> => ({
      tenantId, actorId: actorFor(tenantId), actionType: cmd.actionType,
      target: cmd.target, payload: cmd.payload, approvalReference: cmd.approvalReference,
    }),
    ...options,
  };
  return createBooking(cmd, { dispatch: (parsed) => dispatch(ctx, parsed) });
}

async function counts(fixture: TwoTenantFixture, tenantId: string) {
  return fixture.service(async (tx) => {
    const one = async (sql: string) => Number((await tx.query<{ n: string }>(sql, [tenantId])).rows[0]!.n);
    return {
      bookings: await one("SELECT count(*) AS n FROM bookings WHERE tenant_id=$1"),
      actions: await one("SELECT count(*) AS n FROM actions WHERE tenant_id=$1"),
      outbox: await one("SELECT count(*) AS n FROM outbox WHERE tenant_id=$1"),
    };
  });
}

async function addExternal(fixture: TwoTenantFixture, r: BookingResource, startsAt: string, endsAt: string) {
  await fixture.service((tx) => tx.query(
    `INSERT INTO booking_external_blocks (tenant_id,id,resource_id,starts_at,ends_at,source,created_at)
     VALUES ($1,$2,$3,$4,$5,'calendar-sync',$6)`, [r.tenantId, randomUUID(), r.id, startsAt, endsAt, MONDAY_8AM]));
}

const rejection = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as { code?: string; details?: Record<string, unknown> }; }
  throw new Error("expected a rejection");
};

describe("booking.create through the shared dispatcher (B-17..B-23)", () => {
  it("commits state, action and outbox together and returns the saved buffers", async () => {
    const { fixture, a } = await world();
    const cmd = command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z");
    const out = await book(cmd);
    expect(out.result).toEqual({
      id: cmd.payload.bookingId, tenantId: a.tenantId, resourceId: a.id,
      startsAt: "2026-10-19T10:00:00.000Z", endsAt: "2026-10-19T10:30:00.000Z",
      occupiedStartsAt: "2026-10-19T09:45:00.000Z", occupiedEndsAt: "2026-10-19T10:45:00.000Z",
      bufferBeforeMinutes: 15, bufferAfterMinutes: 15, status: "confirmed", createdAt: MONDAY_8AM,
    });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 1, actions: 1, outbox: 1 });
    const stored = await fixture.service(async (tx) => (await tx.query(
      `SELECT b.status, b.created_at, o.event_type, o.payload->'result'->>'id' AS event_booking
         FROM bookings b JOIN actions x ON x.tenant_id=b.tenant_id JOIN outbox o ON o.action_id=x.id
        WHERE b.tenant_id=$1`, [a.tenantId])).rows[0]);
    expect(stored).toMatchObject({ status: "confirmed", event_type: "booking.create", event_booking: cmd.payload.bookingId });
    expect((stored.created_at as Date).toISOString()).toBe(MONDAY_8AM);
  });

  it("returns the stored action for an identical retry and rejects a changed payload", async () => {
    const { fixture, a } = await world();
    const cmd = command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z");
    const first = await book(cmd);
    expect(await book(cmd, "2026-10-19T09:00:00.000Z")).toEqual(first);
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 1, actions: 1, outbox: 1 });
    const changed = createBookingCommandSchema.parse({ ...cmd, payload: { ...cmd.payload, startsAt: "2026-10-19T11:00:00.000Z" } });
    expect(await rejection(book(changed))).toMatchObject({ code: "IdempotencyConflict" });
  });

  it("lets exactly one of two concurrent overlapping creates commit (B-20)", async () => {
    const { fixture, a } = await world();
    // Occupied 09:45-10:45 and 10:15-11:15 overlap through their buffers.
    const results = await Promise.allSettled([
      book(command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z")),
      book(command(a.tenantId, a.id, "2026-10-19T10:30:00.000Z")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: "Conflict" });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 1, actions: 1, outbox: 1 });
  });

  it("serializes a wider race of identical slot requests to one winner", async () => {
    const { fixture, a } = await world();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      book(command(a.tenantId, a.id, "2026-10-19T13:00:00.000Z"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "Conflict" });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 1, actions: 1, outbox: 1 });
  });

  it("rechecks a slot that was shown before an external block arrived (stale availability)", async () => {
    const { fixture, a } = await world();
    const shown = getAvailableSlots({ resource: a, range: { startsAt: "2026-10-19T13:00:00.000Z", endsAt: "2026-10-19T13:30:00.000Z" }, busy: [] },
      { clock: { now: () => new Date(MONDAY_8AM) } });
    expect(shown.slots).toHaveLength(1);
    await addExternal(fixture, a, "2026-10-19T13:40:00.000Z", "2026-10-19T14:00:00.000Z");
    expect(await rejection(book(command(a.tenantId, a.id, "2026-10-19T13:00:00.000Z"))))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  it.each([
    ["misaligned start", "2026-10-19T10:10:00.000Z", MONDAY_8AM],
    ["outside working hours", "2026-10-19T17:00:00.000Z", MONDAY_8AM],
    ["one millisecond short of notice", "2026-10-19T09:00:00.000Z", "2026-10-19T08:00:00.001Z"],
    ["start in the past", "2026-10-19T09:00:00.000Z", "2026-10-19T12:00:00.000Z"],
    ["start exactly at the horizon", "2026-10-26T09:00:00.000Z", "2026-10-19T09:00:00.000Z"],
  ])("rejects %s with slot_unavailable", async (_name, startsAt, now) => {
    const { fixture, a } = await world();
    expect(await rejection(book(command(a.tenantId, a.id, startsAt), now)))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  it("accepts a start exactly at the notice bound and just inside the horizon", async () => {
    const { a } = await world();
    await expect(book(command(a.tenantId, a.id, "2026-10-19T09:00:00.000Z"), MONDAY_8AM)).resolves.toBeDefined();
    await expect(book(command(a.tenantId, a.id, "2026-10-26T09:00:00.000Z"), "2026-10-19T09:00:00.001Z")).resolves.toBeDefined();
  });

  it("blocks through a previous-day booking's after-buffer (B-15)", async () => {
    const { fixture, a } = await world();
    const sunday = "2026-10-18T20:00:00.000Z";
    await book(command(a.tenantId, a.id, "2026-10-18T23:30:00.000Z"), sunday); // occupied Sun 23:15 - Mon 00:15
    expect(await rejection(book(command(a.tenantId, a.id, "2026-10-19T00:00:00.000Z"), sunday)))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    await book(command(a.tenantId, a.id, "2026-10-19T00:30:00.000Z"), sunday); // touches at 00:15
    expect(await counts(fixture, a.tenantId)).toMatchObject({ bookings: 2 });
  });

  it("blocks a late-evening slot whose after-buffer reaches a next-day external block (B-15)", async () => {
    const { fixture, a } = await world();
    const sunday = "2026-10-18T20:00:00.000Z";
    await addExternal(fixture, a, "2026-10-19T00:10:00.000Z", "2026-10-19T00:20:00.000Z");
    expect(await rejection(book(command(a.tenantId, a.id, "2026-10-18T23:30:00.000Z"), sunday)))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    await expect(book(command(a.tenantId, a.id, "2026-10-18T23:00:00.000Z"), sunday)).resolves.toBeDefined();
  });

  it("keeps saved buffers when the resource configuration changes later (B-22)", async () => {
    const { fixture, a } = await world();
    await book(command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z")); // occupied 09:45-10:45
    await fixture.service((tx) => tx.query(
      "UPDATE booking_resources SET buffer_before_minutes=0, buffer_after_minutes=0 WHERE tenant_id=$1", [a.tenantId]));
    const row = await fixture.service(async (tx) => (await tx.query(
      "SELECT occupied_starts_at, occupied_ends_at, buffer_before_minutes, buffer_after_minutes FROM bookings WHERE tenant_id=$1",
      [a.tenantId])).rows[0]);
    expect(row).toMatchObject({ buffer_before_minutes: 15, buffer_after_minutes: 15 });
    expect((row.occupied_ends_at as Date).toISOString()).toBe("2026-10-19T10:45:00.000Z");
    // 10:30 is free of the appointment but not of its saved after-buffer.
    expect(await rejection(book(command(a.tenantId, a.id, "2026-10-19T10:30:00.000Z"))))
      .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    const next = await book(command(a.tenantId, a.id, "2026-10-19T11:00:00.000Z"));
    expect(next.result).toMatchObject({ bufferBeforeMinutes: 0, occupiedStartsAt: "2026-10-19T11:00:00.000Z" });
  });

  it("denies another tenant's resource and an absent resource (B-19)", async () => {
    const { a, b } = await world();
    expect(await rejection(book(command(a.tenantId, b.id, "2026-10-19T10:00:00.000Z")))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(book(command(a.tenantId, randomUUID(), "2026-10-19T10:00:00.000Z")))).toMatchObject({ code: "TenantDenied" });
  });

  it("reports id_in_use for an owned booking ID but allows an ID used only by another tenant", async () => {
    const { a, b } = await world();
    const first = command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z");
    await book(first);
    expect(await rejection(book(command(a.tenantId, a.id, "2026-10-19T14:00:00.000Z", { bookingId: first.payload.bookingId }))))
      .toMatchObject({ code: "Conflict", details: { reason: "id_in_use" } });
    const reused = await book(command(b.tenantId, b.id, "2026-10-19T10:00:00.000Z", { bookingId: first.payload.bookingId }));
    expect(reused.result).toMatchObject({ id: first.payload.bookingId, tenantId: b.tenantId });
  });

  it("rolls back the booking row when the action fails after the handler ran", async () => {
    const { fixture, a } = await world();
    let calls = 0;
    // The dispatcher mints the action ID after the handler inserted the booking.
    const failing = await rejection(book(command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z"), MONDAY_8AM,
      { generateId: () => (++calls === 1 ? "not-a-uuid" : randomUUID()) }));
    expect(failing).toMatchObject({ code: "ValidationFailed" });
    const mismatched = command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z");
    expect(await rejection(book(mismatched, MONDAY_8AM, {
      resolveApproval: async () => ({
        tenantId: a.tenantId, actorId: actorIds.get(a.tenantId)!, actionType: "booking.create",
        target: mismatched.target, payload: { ...mismatched.payload, startsAt: "2026-10-19T11:00:00.000Z" },
        approvalReference: mismatched.approvalReference,
      }),
    }))).toMatchObject({ code: "BindingMismatch" });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  it("holds the B-21 resource lock: a create waits for a concurrent block writer and sees its block", async () => {
    const { fixture, a } = await world();
    const writer = await database.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock(hashtextextended('booking-resource:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
        [a.tenantId.toUpperCase(), a.id.toUpperCase()]);
      await writer.query(`INSERT INTO booking_external_blocks (tenant_id,id,resource_id,starts_at,ends_at,source,created_at)
        VALUES ($1,$2,$3,'2026-10-19T15:00:00Z','2026-10-19T15:30:00Z','calendar-sync',$4)`, [a.tenantId, randomUUID(), a.id, MONDAY_8AM]);
      let settled = false;
      const pending = rejection(book(command(a.tenantId, a.id, "2026-10-19T15:00:00.000Z"))).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await writer.query("COMMIT");
      expect(await pending).toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    } finally {
      writer.release();
    }
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  it("reports a stored resource that fails schema parsing as a typed ValidationFailed", async () => {
    // SQL now rejects unknown zones, so model a row stored before that check (or under an
    // older tzdata): the table owner disables only that trigger, in one transaction.
    const { fixture, a } = await world();
    const owner = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      // Act as the non-superuser owner, as hosted Supabase's postgres would. Forced RLS
      // hides every row from the owner too, so lift it with the trigger.
      await owner.query(`SET LOCAL ROLE "${database.migrator!}"`);
      await owner.query(`ALTER TABLE booking_resources NO FORCE ROW LEVEL SECURITY,
        DISABLE TRIGGER booking_resources_time_zone_known`);
      const planted = await owner.query("UPDATE booking_resources SET time_zone='Not/AZone' WHERE tenant_id=$1", [a.tenantId]);
      expect(planted.rowCount).toBe(1);
      await owner.query(`ALTER TABLE booking_resources FORCE ROW LEVEL SECURITY,
        ENABLE TRIGGER booking_resources_time_zone_known`);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    } finally { owner.release(); }
    const error = await rejection(book(command(a.tenantId, a.id, "2026-10-19T10:00:00.000Z")));
    expect(error).toBeInstanceOf(ValidationFailed);
    expect(error).toMatchObject({ code: "ValidationFailed" });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  it.each([
    ["appointment end", { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }],
    ["occupied end (after buffer)", { slotLengthMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 30 }],
  ])("rejects a start whose derived %s leaves the supported instant range with ValidationFailed", async (_name, change) => {
    const { fixture, a } = await world({
      weekly: [{ weekday: 5, windows: [{ startMinute: 0, endMinute: 1440 }] }],
      slotLengthMinutes: 60, minimumNoticeMinutes: 0, ...change,
    });
    // 9999-12-31 is a Friday; 23:30 plus the slot or buffer passes the end of year 9999.
    const error = await rejection(book(command(a.tenantId, a.id, "9999-12-31T23:30:00.000Z"), "9999-12-31T00:00:00.000Z"));
    expect(error).toBeInstanceOf(ValidationFailed);
    expect(error).toMatchObject({ code: "ValidationFailed" });
    expect(await counts(fixture, a.tenantId)).toEqual({ bookings: 0, actions: 0, outbox: 0 });
  });

  describe("sub-millisecond busy rows (B-13/B-15, half-open [start,end))", () => {
    // Candidate 10:00-10:30 with 15 minute buffers occupies exactly [09:45:00.000, 10:45:00.000).
    const START = "2026-10-19T10:00:00.000Z";
    const addBooking = (fixture: TwoTenantFixture, r: BookingResource, from: string, to: string) => fixture.service((tx) => tx.query(
      `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,
         buffer_before_minutes,buffer_after_minutes,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$4,$5,0,0,'confirmed',$6)`, [r.tenantId, randomUUID(), r.id, from, to, MONDAY_8AM]));

    it.each([
      ["booking ending exactly at the occupied start, with microsecond start", "2026-10-19T09:00:00.000123Z", "2026-10-19T09:45:00.000000Z"],
      ["booking ending a microsecond before the occupied start", "2026-10-19T09:00:00.000123Z", "2026-10-19T09:44:59.999999Z"],
      ["booking starting exactly at the occupied end, with microsecond end", "2026-10-19T10:45:00.000000Z", "2026-10-19T11:00:00.000789Z"],
      ["booking starting a microsecond after the occupied end", "2026-10-19T10:45:00.000001Z", "2026-10-19T11:00:00.000789Z"],
    ])("accepts a %s", async (_name, from, to) => {
      const { fixture, a } = await world();
      await addBooking(fixture, a, from, to);
      await expect(book(command(a.tenantId, a.id, START))).resolves.toBeDefined();
    });

    it("accepts external blocks that touch with microsecond precision", async () => {
      const { fixture, a } = await world();
      await addExternal(fixture, a, "2026-10-19T09:00:00.000123Z", "2026-10-19T09:45:00.000000Z");
      await addExternal(fixture, a, "2026-10-19T10:45:00.000000Z", "2026-10-19T11:00:00.000789Z");
      await expect(book(command(a.tenantId, a.id, START))).resolves.toBeDefined();
    });

    it.each([
      ["booking ending a microsecond after the occupied start", "2026-10-19T09:00:00.000000Z", "2026-10-19T09:45:00.000001Z"],
      ["booking starting a microsecond before the occupied end", "2026-10-19T10:44:59.999999Z", "2026-10-19T11:00:00.000000Z"],
    ])("still rejects a %s", async (_name, from, to) => {
      const { fixture, a } = await world();
      await addBooking(fixture, a, from, to);
      expect(await rejection(book(command(a.tenantId, a.id, START))))
        .toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    });
  });

  it("rejects an invalid command without dispatching and validates the returned envelope (B-18)", async () => {
    const dispatchSpy = vi.fn();
    const bad = { ...command(randomUUID(), randomUUID(), "2026-10-19T10:00:00.000Z"), payload: { bookingId: randomUUID() } };
    expect(await rejection(createBooking(bad as unknown as CreateBookingCommand, { dispatch: dispatchSpy })))
      .toMatchObject({ code: "ValidationFailed" });
    expect(dispatchSpy).not.toHaveBeenCalled();
    const cmd = command(randomUUID(), randomUUID(), "2026-10-19T10:00:00.000Z");
    expect(await rejection(createBooking(cmd, { dispatch: async () => ({ actionId: randomUUID(), result: { id: "x" } }) })))
      .toMatchObject({ code: "ValidationFailed" });
  });
});

describe("booking tables under the runtime role (B-21/B-25/B-28)", () => {
  const row = (tenantId: string, resourceId: string, start: string, end: string) => [
    tenantId, randomUUID(), resourceId, start, end, start, end, 0, 0, MONDAY_8AM,
  ];
  const insert = `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,
    buffer_before_minutes,buffer_after_minutes,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10)`;

  it("rejects an overlapping direct insert through the exclusion constraint alone", async () => {
    const { fixture, a } = await world();
    await fixture.a.run((tx) => tx.query(insert, row(a.tenantId, a.id, "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")));
    await fixture.a.run((tx) => tx.query(insert, row(a.tenantId, a.id, "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z")));
    expect(await rejection(fixture.a.run((tx) => tx.query(insert, row(a.tenantId, a.id, "2026-10-20T09:30:00Z", "2026-10-20T10:30:00Z")))))
      .toMatchObject({ code: "23P01", constraint: "bookings_resource_occupied_excl" });
  });

  it("arbitrates two concurrent overlapping direct inserts without any application lock", async () => {
    const { fixture, a } = await world();
    let release!: () => void;
    let inserted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstInserted = new Promise<void>((resolve) => { inserted = resolve; });
    const first = fixture.a.run(async (tx) => {
      await tx.query(insert, row(a.tenantId, a.id, "2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z"));
      inserted();
      await held; // keep the first insert uncommitted while the second one arrives
    });
    await firstInserted;
    let secondSettled = false;
    const second = fixture.a.run((tx) => tx.query(insert, row(a.tenantId, a.id, "2026-10-21T09:30:00Z", "2026-10-21T10:30:00Z")))
      .finally(() => { secondSettled = true; });
    const results = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondSettled).toBe(false); // waits on the uncommitted conflicting row
    release();
    const [won, lost] = await results;
    expect(won.status).toBe("fulfilled");
    expect(lost).toMatchObject({ status: "rejected", reason: { code: "23P01", constraint: "bookings_resource_occupied_excl" } });
    expect(await counts(fixture, a.tenantId)).toMatchObject({ bookings: 1 });
  });

  it("rejects a cross-tenant insert through RLS WITH CHECK and hides other tenants' rows", async () => {
    const { fixture, a, b } = await world();
    expect(await rejection(fixture.a.run((tx) => tx.query(insert, row(b.tenantId, b.id, "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")))))
      .toMatchObject({ code: "42501" });
    await fixture.b.run((tx) => tx.query(insert, row(b.tenantId, b.id, "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")));
    for (const table of ["booking_resources", "bookings", "booking_external_blocks"]) {
      expect((await fixture.a.run((tx) => tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [b.tenantId]))).rowCount, table).toBe(0);
    }
    expect(await rejection(fixture.a.run((tx) => tx.query("UPDATE booking_resources SET slot_length_minutes=60"))))
      .toMatchObject({ code: "42501" });
  });

  it("enables and forces RLS on every booking table, which the catalog isolation test then covers", async () => {
    const { fixture } = await world();
    const tables = await fixture.service(async (tx) => (await tx.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relname IN ('booking_resources','bookings','booking_external_blocks') ORDER BY relname`)).rows);
    expect(tables).toEqual([
      { relname: "booking_external_blocks", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "booking_resources", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "bookings", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it.each([
    ["weekly is not an array", { weekly: "{}" }],
    ["window has an extra key", { weekly: JSON.stringify([{ weekday: 1, windows: [{ startMinute: 1, endMinute: 2, x: 1 }] }]) }],
    ["duplicate weekday", { weekly: JSON.stringify([{ weekday: 1, windows: [] }, { weekday: 1, windows: [] }]) }],
    ["impossible override date", { overrides: JSON.stringify([{ date: "2026-02-30", windows: [] }]) }],
    ["zone without a slash", { time_zone: "EST5EDT" }],
    ["zero step", { slot_step_minutes: 0 }],
  ])("rejects stored resource configuration where %s", async (_name, change) => {
    const fixture = await createTwoTenantFixture(database);
    const values = {
      time_zone: "UTC", weekly: "[]", overrides: JSON.stringify([{ date: "2026-10-19", windows: [] }]),
      slot_step_minutes: 30, ...change,
    };
    expect(await rejection(fixture.service((tx) => tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,30,$6,0,0,0,60)`,
      [fixture.a.tenantId, randomUUID(), values.time_zone, values.weekly, values.overrides, values.slot_step_minutes],
    )))).toMatchObject({ code: "23514" });
  });
});
