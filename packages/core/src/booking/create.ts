// F1 booking.create (B-17..B-23). Original code; the handler runs inside the shared
// dispatcher transaction and never commits or announces anything itself.
import {
  bookingInstantSchema,
  bookingResourceSchema,
  Conflict,
  createBookingCommandSchema,
  createBookingOutputSchema,
  TenantDenied,
  ValidationFailed,
  type BookingRecord,
  type CreateBooking,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { compileRules, evaluateSlots, type Span } from "./slots.js";
import { MINUTE_MS } from "./time-zone.js";

const ACTION_TYPE = "booking.create";

const currentTenant = async (tx: Transaction): Promise<string | undefined> =>
  (await tx.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM tenants WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
  )).rows[0]?.tenant_id;

const isSupportedInstant = (instant: number): boolean => {
  const date = new Date(instant);
  return Number.isFinite(date.getTime()) && bookingInstantSchema.safeParse(date.toISOString()).success;
};

async function assertBookingIdUnused(tx: Transaction, tenantId: string, bookingId: string): Promise<void> {
  const used = await tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, bookingId]);
  if (used.rowCount) throw new Conflict("Booking ID is already in use", { reason: "id_in_use" });
}

async function loadResource(tx: Transaction, tenantId: string, resourceId: string) {
  const row = (await tx.query(
    `SELECT tenant_id, id, time_zone, weekly, overrides, slot_length_minutes, slot_step_minutes,
       buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_horizon_minutes
     FROM booking_resources WHERE tenant_id=$1 AND id=$2`,
    [tenantId, resourceId],
  )).rows[0];
  if (!row) throw new TenantDenied("Booking resource is not owned by this tenant");
  const parsed = bookingResourceSchema.safeParse({
    tenantId: row.tenant_id, id: row.id, timeZone: row.time_zone,
    weekly: row.weekly, overrides: row.overrides,
    slotLengthMinutes: row.slot_length_minutes, slotStepMinutes: row.slot_step_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes, bufferAfterMinutes: row.buffer_after_minutes,
    minimumNoticeMinutes: row.minimum_notice_minutes, bookingHorizonMinutes: row.booking_horizon_minutes,
  });
  // SQL constraints check stored configuration; a failure here is corrupt state, reported as a typed error.
  if (!parsed.success) throw new ValidationFailed(`Stored booking resource ${resourceId} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Busy spans intersecting [from,to) (B-13/B-15). Intersection uses the same half-open semantics as
 * bookings_resource_occupied_excl, in SQL at full timestamptz precision, and every span is clipped to the
 * whole-millisecond window first. Rounding a sub-millisecond bound to milliseconds therefore stays inside
 * a window the row really overlaps, so an exact touch never becomes an overlap and an overlap never vanishes.
 */
async function loadBusy(tx: Transaction, tenantId: string, resourceId: string, from: number, to: number): Promise<Span[]> {
  const rows = (await tx.query<{ start_ms: string; end_ms: string }>(
    `SELECT floor(extract(epoch FROM greatest(occupied_starts_at, $3::timestamptz)) * 1000)::bigint AS start_ms,
            ceil(extract(epoch FROM least(occupied_ends_at, $4::timestamptz)) * 1000)::bigint AS end_ms
       FROM bookings
      WHERE tenant_id=$1 AND resource_id=$2
        AND tstzrange(occupied_starts_at, occupied_ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
     UNION ALL
     SELECT floor(extract(epoch FROM greatest(starts_at, $3::timestamptz)) * 1000)::bigint,
            ceil(extract(epoch FROM least(ends_at, $4::timestamptz)) * 1000)::bigint
       FROM booking_external_blocks
      WHERE tenant_id=$1 AND resource_id=$2
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [tenantId, resourceId, new Date(from).toISOString(), new Date(to).toISOString()],
  )).rows;
  return rows.map((row) => ({ start: Number(row.start_ms), end: Number(row.end_ms) }));
}

export const createBookingHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "booking") throw new ValidationFailed("booking.create requires a booking target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    await assertBookingIdUnused(tx, tenantId, target.id);
    return { tenantId, type: "booking", id: target.id };
  },

  async handle({ tx, command, binding, now }) {
    const parsed = createBookingCommandSchema.safeParse(command);
    if (!parsed.success) throw new ValidationFailed(parsed.error.message);
    const { bookingId, resourceId, startsAt } = parsed.data.payload;
    const tenantId = binding.tenantId;
    // B-21: the shared per-resource lock, taken after the dispatcher's idempotency lock.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('booking-resource:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
      [tenantId, resourceId],
    );
    const resource = await loadResource(tx, tenantId, resourceId);
    await assertBookingIdUnused(tx, tenantId, bookingId);

    const rules = compileRules(resource);
    const start = Date.parse(startsAt);
    const end = start + rules.slotLengthMinutes * MINUTE_MS;
    const occupiedStart = start - rules.bufferBeforeMinutes * MINUTE_MS;
    const occupiedEnd = end + rules.bufferAfterMinutes * MINUTE_MS;
    // The derived bounds must be valid instants too, or Postgres rejects them with a raw SQLSTATE.
    for (const bound of [start, end, occupiedStart, occupiedEnd])
      if (!isSupportedInstant(bound)) throw new ValidationFailed("Booking interval leaves the supported instant range");
    const busy = await loadBusy(tx, tenantId, resourceId, occupiedStart, occupiedEnd);
    // B-19: re-evaluate exactly this appointment; the query range is the appointment itself.
    if (!evaluateSlots(rules, start, end, busy, now.getTime()).includes(start))
      throw new Conflict("Requested slot is unavailable", { reason: "slot_unavailable" });

    const record: BookingRecord = {
      id: bookingId,
      tenantId,
      resourceId: resource.id,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      occupiedStartsAt: new Date(occupiedStart).toISOString(),
      occupiedEndsAt: new Date(occupiedEnd).toISOString(),
      bufferBeforeMinutes: rules.bufferBeforeMinutes,
      bufferAfterMinutes: rules.bufferAfterMinutes,
      status: "confirmed",
      createdAt: now.toISOString(),
    };
    // bookings_resource_occupied_excl (B-20) arbitrates anything the lock did not serialize.
    await tx.query(
      `INSERT INTO bookings (tenant_id, id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
         buffer_before_minutes, buffer_after_minutes, status, created_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9, 'confirmed', $10::timestamptz)`,
      [record.tenantId, record.id, record.resourceId, record.startsAt, record.endsAt, record.occupiedStartsAt,
        record.occupiedEndsAt, record.bufferBeforeMinutes, record.bufferAfterMinutes, record.createdAt],
    );
    return { result: { ...record } };
  },
};

export const bookingHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [ACTION_TYPE]: createBookingHandler,
});

export const createBooking: CreateBooking = async (command, ctx) => {
  const parsed = createBookingCommandSchema.safeParse(command);
  if (!parsed.success) throw new ValidationFailed(parsed.error.message);
  const output = createBookingOutputSchema.safeParse(await ctx.dispatch(parsed.data));
  if (!output.success) throw new ValidationFailed(output.error.message);
  return output.data;
};
