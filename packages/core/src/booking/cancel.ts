// booking.cancel (booking.md B-29..B-35). Original code. The handler runs inside the shared
// dispatcher transaction: the status change, the action row and the one outbox event (the customer's
// notice, when there is one) commit together or not at all.
import {
  cancelBookingCommandSchema,
  CANCEL_BOOKING_ACTION,
  Conflict,
  MESSAGE_SEND_REQUESTED,
  NotFound,
  ValidationFailed,
  type BookingRecord,
  type CancelBookingResult,
  type CancelNotice,
  type JsonValue,
  type MessageSendRequested,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { usableEmail } from "../delivery/policy.js";
import { clockInstant, parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { bookingRecord } from "../reads/booking.js";
import { firstName, localStart } from "../templates/send.js";
import { currentTenant } from "./create.js";

export { CANCEL_BOOKING_ACTION };

/** B-21: the shared per-resource lock, taken after the dispatcher's idempotency lock. */
export const lockResource = (tx: Transaction, tenantId: string, resourceId: string) =>
  tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('booking-resource:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
    [tenantId, resourceId],
  );

interface CancelRow {
  id: string; tenant_id: string; resource_id: string; starts_at: Date; ends_at: Date; occupied_starts_at: Date;
  occupied_ends_at: Date; buffer_before_minutes: number; buffer_after_minutes: number;
  status: "confirmed" | "cancelled"; created_at: Date; cancelled_at: Date | null; cancel_reason: string | null;
}
const CANCEL_COLUMNS = `id, tenant_id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
  buffer_before_minutes, buffer_after_minutes, status, created_at, cancelled_at, cancel_reason`;

export interface CancelledBooking {
  readonly record: BookingRecord;
  readonly cancelledAt: string;
  readonly reason: string | null;
  /** False when the booking was already cancelled: nothing changed. */
  readonly changed: boolean;
}

/**
 * B-30, B-31: cancel one booking in the caller's transaction, under the resource lock. A confirmed booking that has not
 * ended becomes `cancelled`; one already cancelled is returned as it is; one that ended is `Conflict` `booking_over`.
 * `actorId` is null when the customer cancels through their own link (booking-self-service.md). `clock` is read once,
 * after the resource lock is held, so a long wait cannot cancel a booking that has since ended.
 */
export async function cancelBookingRow(
  tx: Transaction, tenantId: string, bookingId: string,
  by: { readonly actorId: string | null; readonly reason: string | null }, clock: () => Date,
): Promise<CancelledBooking> {
  const found = (await tx.query<{ resource_id: string }>(
    "SELECT resource_id FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, bookingId],
  )).rows[0];
  if (!found) throw new NotFound();
  await lockResource(tx, tenantId, found.resource_id);
  const row = (await tx.query<CancelRow>(
    `SELECT ${CANCEL_COLUMNS} FROM bookings WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, bookingId],
  )).rows[0];
  if (!row) throw new NotFound();
  // The wait on the lock may have been long: decide on the time now that the lock is held (B-31).
  const now = clock();
  const at = clockInstant(now);
  if (row.status === "cancelled")
    return { record: bookingRecord(row), cancelledAt: row.cancelled_at!.toISOString(), reason: row.cancel_reason, changed: false };
  if (row.ends_at.getTime() <= now.getTime())
    throw new Conflict("The booking is already over", { reason: "booking_over" });
  const updated = (await tx.query<CancelRow>(
    `UPDATE bookings SET status='cancelled', cancelled_at=$3::timestamptz, cancelled_by=$4, cancel_reason=$5
      WHERE tenant_id=$1 AND id=$2 AND status='confirmed'
      RETURNING ${CANCEL_COLUMNS}`,
    [tenantId, bookingId, at, by.actorId, by.reason],
  )).rows[0];
  if (!updated) throw new Conflict("The booking changed while it was being cancelled", { reason: "stale_booking" });
  return { record: bookingRecord(updated), cancelledAt: at, reason: by.reason, changed: true };
}

/** B-33: the customer a booking is for: an owner's link, or the contact of the website request that made it. */
export async function bookingCustomer(tx: Transaction, tenantId: string, bookingId: string) {
  return (await tx.query<{
    contact_id: string | null; display_name: string | null; email: string | null;
    business: string; time_zone: string; starts_at: Date;
  }>(
    `SELECT c.id AS contact_id, c.display_name, c.normalized_email AS email, t.name AS business, r.time_zone, b.starts_at
       FROM bookings b
       JOIN tenants t ON t.tenant_id = b.tenant_id
       JOIN booking_resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
       LEFT JOIN booking_contacts l ON l.tenant_id = b.tenant_id AND l.booking_id = b.id
       LEFT JOIN intake_items i ON i.tenant_id = b.tenant_id AND i.id = b.intake_item_id AND i.status IN ('new_contact','linked')
       LEFT JOIN crm_contacts c ON c.tenant_id = b.tenant_id AND c.id = coalesce(l.contact_id, i.contact_id)
      WHERE b.tenant_id=$1 AND b.id=$2`,
    [tenantId, bookingId],
  )).rows[0];
}

const oneLine = (text: string, max: number): string => [...text.replace(/\s+/g, " ").trim()].slice(0, max).join("");

/** B-33: the plain cancellation email. It never carries the owner's reason (B-29). */
export function cancellationNotice(input: {
  readonly messageId: string; readonly contactId: string; readonly displayName: string | null;
  readonly business: string; readonly startsAt: Date; readonly timeZone: string;
}): MessageSendRequested {
  const business = oneLine(input.business, 120) || "our business";
  const when = localStart(input.startsAt, input.timeZone);
  return {
    messageId: input.messageId,
    contactId: input.contactId,
    channel: "email",
    purpose: "transactional",
    subject: `Your appointment on ${when} is cancelled`,
    body: [
      `Hi ${firstName(input.displayName)},`,
      "",
      `${business} has cancelled your appointment on ${when} (${input.timeZone}).`,
      "",
      `If you would still like to be seen, please contact ${business} to book another time.`,
      "",
      `${business}`,
    ].join("\n"),
  };
}

/** One notice per booking, ever: a later cancellation path derives the same ID and delivery drops the repeat (D-2). */
export const cancellationMessageId = (tenantId: string, bookingId: string) => derivedId(tenantId, bookingId, "booking-cancel-notice");

/** B-33: decide the notice for a booking that was just cancelled. */
export async function queueCancellationNotice(
  tx: Transaction, tenantId: string, bookingId: string,
): Promise<{ notice: CancelNotice; event?: { type: string; payload: JsonValue } }> {
  const customer = await bookingCustomer(tx, tenantId, bookingId);
  if (!customer?.contact_id) return { notice: "no_customer" };
  if (usableEmail(customer.email) === null) return { notice: "no_email" };
  const message = cancellationNotice({
    messageId: cancellationMessageId(tenantId, bookingId), contactId: customer.contact_id, displayName: customer.display_name,
    business: customer.business, startsAt: customer.starts_at, timeZone: customer.time_zone,
  });
  return { notice: "queued", event: { type: MESSAGE_SEND_REQUESTED, payload: { ...message } } };
}

export const cancelBookingHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "booking") throw new ValidationFailed("booking.cancel requires a booking target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    // Tenant B learns nothing about tenant A's booking: a foreign ID reads as missing.
    const owned = await tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, target.id]);
    if (owned.rowCount !== 1) throw new NotFound();
    return { tenantId, type: "booking", id: target.id };
  },

  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(cancelBookingCommandSchema, command);
    const tenantId = binding.tenantId;
    const cancelled = await cancelBookingRow(tx, tenantId, payload.bookingId, { actorId: binding.actorId, reason: payload.reason }, clock);
    let notice: CancelNotice = "already_cancelled";
    let event: { type: string; payload: JsonValue } | undefined;
    if (cancelled.changed) {
      if (!payload.notifyCustomer) notice = "off";
      else ({ notice, event } = await queueCancellationNotice(tx, tenantId, payload.bookingId));
    }
    const result: CancelBookingResult = {
      booking: cancelled.record, cancelledAt: cancelled.cancelledAt, reason: cancelled.reason, customerNotice: notice,
    };
    return { result: JSON.parse(JSON.stringify(result)) as JsonValue, ...(event ? { event } : {}) };
  },
};

export const bookingCancelHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CANCEL_BOOKING_ACTION]: cancelBookingHandler,
});
