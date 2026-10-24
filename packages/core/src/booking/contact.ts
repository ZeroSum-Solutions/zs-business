// The booking customer link (docs/requirements/booking-customer.md BC-2..BC-5): who an owner-made
// booking is for. Both actions run through the shared dispatcher; booking.create is unchanged
// (booking.md B-17), so the booking authority never holds customer data.
import {
  BOOKING_CONTACT_TARGET,
  Conflict,
  linkBookingContactCommandSchema,
  NotFound,
  unlinkBookingContactCommandSchema,
  ValidationFailed,
  type BookingContactResult,
  type JsonValue,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import { currentTenant } from "./create.js";

export const LINK_BOOKING_CONTACT_ACTION = "booking.contact.link";
export const UNLINK_BOOKING_CONTACT_ACTION = "booking.contact.unlink";

/** The booking is the caller's own, or it does not exist: tenant B never learns about tenant A's. */
async function resolveBooking(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== BOOKING_CONTACT_TARGET) throw new ValidationFailed("Booking contact actions require a booking target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  const owned = await tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, target.id]);
  if (owned.rowCount !== 1) throw new NotFound();
  return { tenantId, type: BOOKING_CONTACT_TARGET, id: target.id };
}

interface LinkState {
  readonly source: string;
  readonly contactId: string | null;
  readonly name: string | null;
  /** 0 while the booking has never had a link row (BC-3). */
  readonly revision: number;
  readonly hasRow: boolean;
}

/**
 * The booking's link state, after taking a per-booking lock so two changes to one booking
 * serialize (the first row's insert too, which a row lock cannot cover).
 */
async function lockedState(tx: Transaction, tenantId: string, bookingId: string): Promise<LinkState> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('booking-contact:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
    [tenantId, bookingId],
  );
  const row = (await tx.query<{ source: string; contact_id: string | null; name: string | null; revision: number | null }>(
    `SELECT b.source, bc.contact_id, c.display_name AS name, bc.revision
       FROM bookings b
       LEFT JOIN booking_contacts bc ON bc.tenant_id = b.tenant_id AND bc.booking_id = b.id
       LEFT JOIN crm_contacts c ON c.tenant_id = bc.tenant_id AND c.id = bc.contact_id
      WHERE b.tenant_id=$1 AND b.id=$2`,
    [tenantId, bookingId],
  )).rows[0];
  if (!row) throw new NotFound();
  return { source: row.source, contactId: row.contact_id, name: row.name, revision: row.revision ?? 0, hasRow: row.revision !== null };
}

const staleRevision = (currentRevision: number) =>
  new Conflict("The booking's customer changed", { reason: "stale_revision", currentRevision });

const resultOf = (bookingId: string, state: Pick<LinkState, "contactId" | "name">, revision: number): JsonValue => {
  const result: BookingContactResult = {
    bookingId,
    customer: state.contactId === null ? null : { contactId: state.contactId, name: state.name, status: "linked" },
    revision,
  };
  return JSON.parse(JSON.stringify(result)) as JsonValue;
};

/** Both actions need the calendar and the customers (BC-3); staff hold both, owners hold all. */
async function requireBoth(tx: Transaction, tenantId: string, actorId: string): Promise<void> {
  await requireMember(tx, tenantId, actorId, "calendar");
  await requireMember(tx, tenantId, actorId, "customers");
}

export const linkBookingContactHandler: ActionHandler = {
  resolveTarget: resolveBooking,
  async handle({ tx, command, binding, now }) {
    await requireBoth(tx, binding.tenantId, binding.actorId);
    const { payload } = parseOrFail(linkBookingContactCommandSchema, command);
    const at = clockInstant(now);
    const tenantId = binding.tenantId;
    const state = await lockedState(tx, tenantId, payload.bookingId);
    // BC-2: a website booking takes its customer from the intake review only.
    if (state.source !== "owner") throw new Conflict("A website booking takes its customer from the intake review", { reason: "intake_booking" });
    // BC-3: the contact must be the tenant's own, else it reads as missing.
    const contact = (await tx.query<{ display_name: string | null }>(
      "SELECT display_name FROM crm_contacts WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE", [tenantId, payload.contactId],
    )).rows[0];
    if (!contact) throw new NotFound();
    if (state.revision !== payload.expectedRevision) throw staleRevision(state.revision);
    // Naming the customer it already has is not a change, so the revision stays.
    if (state.contactId === payload.contactId) return { result: resultOf(payload.bookingId, state, state.revision) };

    if (state.hasRow) {
      await tx.query(
        `UPDATE booking_contacts SET contact_id=$3, linked_by=$4, linked_at=$5::timestamptz, revision=revision+1
          WHERE tenant_id=$1 AND booking_id=$2`,
        [tenantId, payload.bookingId, payload.contactId, binding.actorId, at],
      );
    } else {
      await tx.query(
        `INSERT INTO booking_contacts (tenant_id, booking_id, contact_id, linked_by, linked_at, revision)
         VALUES ($1, $2, $3, $4, $5::timestamptz, 1)`,
        [tenantId, payload.bookingId, payload.contactId, binding.actorId, at],
      );
    }
    return { result: resultOf(payload.bookingId, { contactId: payload.contactId, name: contact.display_name }, state.revision + 1) };
  },
};

export const unlinkBookingContactHandler: ActionHandler = {
  resolveTarget: resolveBooking,
  async handle({ tx, command, binding, now }) {
    await requireBoth(tx, binding.tenantId, binding.actorId);
    const { payload } = parseOrFail(unlinkBookingContactCommandSchema, command);
    const at = clockInstant(now);
    const tenantId = binding.tenantId;
    const state = await lockedState(tx, tenantId, payload.bookingId);
    if (state.revision !== payload.expectedRevision) throw staleRevision(state.revision);
    // BC-4: the row stays, so the revision only grows. Clearing no customer changes nothing.
    if (state.contactId === null) return { result: resultOf(payload.bookingId, { contactId: null, name: null }, state.revision) };
    await tx.query(
      `UPDATE booking_contacts SET contact_id=NULL, linked_by=$3, linked_at=$4::timestamptz, revision=revision+1
        WHERE tenant_id=$1 AND booking_id=$2`,
      [tenantId, payload.bookingId, binding.actorId, at],
    );
    return { result: resultOf(payload.bookingId, { contactId: null, name: null }, state.revision + 1) };
  },
};

export const bookingContactHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [LINK_BOOKING_CONTACT_ACTION]: linkBookingContactHandler,
  [UNLINK_BOOKING_CONTACT_ACTION]: unlinkBookingContactHandler,
});
