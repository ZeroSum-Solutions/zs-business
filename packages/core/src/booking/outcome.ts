// booking.outcome.set (booking.md B-37..B-46). Original code, in the style of booking.cancel: the handler runs inside
// the shared dispatcher transaction, so the mark, the action row and the default outbox event commit together or not at
// all. Review requests read the mark (templates/send.ts, B-43); nothing here sends a message.
import {
  Conflict,
  NotFound,
  SET_BOOKING_OUTCOME_ACTION,
  setBookingOutcomeCommandSchema,
  ValidationFailed,
  type BookingOutcome,
  type JsonValue,
  type SetBookingOutcomeResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail } from "../crm/rows.js";
import { bookingRecord } from "../reads/booking.js";
import { lockResource } from "./cancel.js";
import { currentTenant } from "./create.js";

export { SET_BOOKING_OUTCOME_ACTION };

interface OutcomeRow {
  id: string; tenant_id: string; resource_id: string; starts_at: Date; ends_at: Date; occupied_starts_at: Date;
  occupied_ends_at: Date; buffer_before_minutes: number; buffer_after_minutes: number;
  status: "confirmed" | "cancelled"; created_at: Date; outcome: BookingOutcome | null; outcome_set_at: Date | null;
}
const OUTCOME_COLUMNS = `id, tenant_id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
  buffer_before_minutes, buffer_after_minutes, status, created_at, outcome, outcome_set_at`;

/**
 * B-39: mark one booking in the caller's transaction, under the resource lock (the same lock order as a cancel, so a
 * mark and a cancel serialize). The clock is read once after the lock is held: the booking must have started by then
 * (`booking_not_started`). A cancelled booking has no outcome (`booking_cancelled`). The same value again changes
 * nothing; the other value replaces the mark.
 */
export async function setBookingOutcomeRow(
  tx: Transaction, tenantId: string, bookingId: string,
  by: { readonly actorId: string | null; readonly outcome: BookingOutcome }, clock: () => Date,
): Promise<SetBookingOutcomeResult> {
  const found = (await tx.query<{ resource_id: string }>(
    "SELECT resource_id FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, bookingId],
  )).rows[0];
  if (!found) throw new NotFound();
  await lockResource(tx, tenantId, found.resource_id);
  const row = (await tx.query<OutcomeRow>(
    `SELECT ${OUTCOME_COLUMNS} FROM bookings WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, bookingId],
  )).rows[0];
  if (!row) throw new NotFound();
  const now = clock();
  if (row.status === "cancelled") throw new Conflict("A cancelled booking has no outcome", { reason: "booking_cancelled" });
  if (row.starts_at.getTime() > now.getTime())
    throw new Conflict("The appointment has not started yet", { reason: "booking_not_started" });
  if (row.outcome === by.outcome && row.outcome_set_at)
    return { booking: bookingRecord(row), outcome: by.outcome, outcomeAt: row.outcome_set_at.toISOString(), changed: false };
  const at = clockInstant(now);
  const updated = (await tx.query<OutcomeRow>(
    `UPDATE bookings SET outcome=$3, outcome_set_at=$4::timestamptz, outcome_set_by=$5
      WHERE tenant_id=$1 AND id=$2 AND status='confirmed'
      RETURNING ${OUTCOME_COLUMNS}`,
    [tenantId, bookingId, by.outcome, at, by.actorId],
  )).rows[0];
  if (!updated) throw new Conflict("The booking changed while it was being marked", { reason: "stale_booking" });
  return { booking: bookingRecord(updated), outcome: by.outcome, outcomeAt: at, changed: true };
}

export const setBookingOutcomeHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "booking") throw new ValidationFailed("booking.outcome.set requires a booking target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    // Tenant B learns nothing about tenant A's booking: a foreign ID reads as missing.
    const owned = await tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, target.id]);
    if (owned.rowCount !== 1) throw new NotFound();
    return { tenantId, type: "booking", id: target.id };
  },

  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(setBookingOutcomeCommandSchema, command);
    const result = await setBookingOutcomeRow(tx, binding.tenantId, payload.bookingId,
      { actorId: binding.actorId, outcome: payload.outcome }, clock);
    return { result: JSON.parse(JSON.stringify(result)) as JsonValue };
  },
};

export const bookingOutcomeHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [SET_BOOKING_OUTCOME_ACTION]: setBookingOutcomeHandler,
});
