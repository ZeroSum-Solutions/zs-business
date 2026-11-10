// Booking self-service (docs/requirements/booking-self-service.md BS-3..BS-8). Original code. Three
// actions run for an anonymous holder of a signed per-booking link: cancel, reschedule, and the
// confirmation email. Each handler runs inside the shared dispatcher transaction, so the status
// change, the new booking, the action row and the outbox event commit together or not at all.
import {
  CONFIRMATION_SEND_ACTION,
  confirmationCommandSchema,
  Conflict,
  MESSAGE_SEND_REQUESTED,
  NotFound,
  SELF_CANCEL_ACTION,
  SELF_CANCEL_REASON,
  SELF_RESCHEDULE_ACTION,
  SELF_RESCHEDULE_REASON,
  selfCancelCommandSchema,
  selfRescheduleCommandSchema,
  ValidationFailed,
  type ConfirmationKind,
  type ConfirmationNotice,
  type ConfirmationResult,
  type JsonValue,
  type ManageView,
  type MessageSendRequested,
  type SelfCancelResult,
  type SelfRescheduleResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { usableEmail } from "../delivery/policy.js";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { firstName, localStart } from "../templates/send.js";
import { cancelBookingRow, oneLine } from "./cancel.js";
import { checkBookingSlot, currentTenant, insertBooking } from "./create.js";
import { manageExpiry, signManageToken } from "./manage-token.js";

export { CONFIRMATION_SEND_ACTION, SELF_CANCEL_ACTION, SELF_RESCHEDULE_ACTION };

/** What the confirmation handler needs from the server: the signing secret and the origin links point at. */
export interface ManageLinkConfig {
  readonly secret: string;
  readonly publicBaseUrl: string;
}
const manageConfig = (config: unknown): ManageLinkConfig => {
  const manage = (config as { manage?: Partial<ManageLinkConfig> } | null)?.manage;
  if (!manage || typeof manage.secret !== "string" || typeof manage.publicBaseUrl !== "string")
    throw new ValidationFailed("The booking link is not configured");
  return { secret: manage.secret, publicBaseUrl: manage.publicBaseUrl };
};

/** The link a customer opens: the origin, `/manage/`, the signed token. */
export function manageUrl(config: ManageLinkConfig, tenantId: string, bookingId: string, startsAt: Date | string): string {
  const token = signManageToken(config.secret, { tenantId, bookingId, expiresAt: manageExpiry(startsAt) });
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/manage/${token}`;
}

/** BS-2: a managed booking exists in the caller's tenant and came from the website. Anything else reads as missing. */
async function requireWebsiteBooking(tx: Transaction, target: Target, what: string): Promise<Target> {
  if (target.type !== "booking") throw new ValidationFailed(`${what} requires a booking target`);
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) throw new NotFound();
  const found = await tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2 AND source='website'", [tenantId, target.id]);
  if (found.rowCount !== 1) throw new NotFound();
  return { tenantId, type: "booking", id: target.id };
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const selfCancelHandler: ActionHandler = {
  resolveTarget: (tx, target) => requireWebsiteBooking(tx, target, "booking.self_cancel"),

  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(selfCancelCommandSchema, command);
    const cancelled = await cancelBookingRow(tx, binding.tenantId, payload.bookingId,
      { actorId: null, reason: SELF_CANCEL_REASON, notStarted: true }, clock);
    const result: SelfCancelResult = { booking: cancelled.record, changed: cancelled.changed };
    return { result: json(result) };
  },
};

export const selfRescheduleHandler: ActionHandler = {
  resolveTarget: (tx, target) => requireWebsiteBooking(tx, target, "booking.self_reschedule"),

  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(selfRescheduleCommandSchema, command);
    const tenantId = binding.tenantId;
    const old = (await tx.query<{ resource_id: string; starts_at: Date; status: string; intake_item_id: string }>(
      "SELECT resource_id, starts_at, status, intake_item_id FROM bookings WHERE tenant_id=$1 AND id=$2",
      [tenantId, payload.bookingId])).rows[0];
    if (!old) throw new NotFound();
    if (old.status !== "confirmed") throw new Conflict("The booking can no longer be changed", { reason: "not_changeable" });
    if (old.starts_at.getTime() === Date.parse(payload.startsAt))
      throw new Conflict("That is the time the booking already has", { reason: "same_time" });
    // BS-8: free the old time first (under the resource lock, on the clock read after it), then book the new one.
    // A failure below rolls the whole transaction back, so the old booking stays confirmed.
    const cancelled = await cancelBookingRow(tx, tenantId, payload.bookingId,
      { actorId: null, reason: SELF_RESCHEDULE_REASON, notStarted: true }, clock);
    if (!cancelled.changed) throw new Conflict("The booking can no longer be changed", { reason: "not_changeable" });
    const record = await checkBookingSlot(tx, tenantId,
      { bookingId: payload.newBookingId, resourceId: old.resource_id, startsAt: payload.startsAt }, clock());
    const created = await insertBooking(tx, record,
      { source: "website", intakeItemId: old.intake_item_id, rescheduledFrom: payload.bookingId });
    const result: SelfRescheduleResult = { previousBookingId: payload.bookingId, booking: created };
    return { result: json(result) };
  },
};

interface ConfirmationFacts {
  status: string; starts_at: Date; time_zone: string; business: string;
  submitted_name: string; submitted_email: string; intake_status: string; intake_contact_id: string | null;
  matched: string[];
}

/** BS-3: the contact a confirmation goes to, or why there is none. */
async function confirmationRecipient(tx: Transaction, tenantId: string, facts: ConfirmationFacts):
  Promise<{ contactId: string } | { notice: "no_customer" | "no_email" }> {
  let found: { id: string; email: string | null } | undefined;
  if ((facts.intake_status === "new_contact" || facts.intake_status === "linked") && facts.intake_contact_id) {
    found = (await tx.query<{ id: string; email: string | null }>(
      "SELECT id, normalized_email AS email FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, facts.intake_contact_id])).rows[0];
  } else if (facts.intake_status === "possible_match") {
    // Only a contact that already holds the address the visitor typed: nothing goes to an unreviewed address.
    found = (await tx.query<{ id: string; email: string | null }>(
      `SELECT id, normalized_email AS email FROM crm_contacts
        WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND normalized_email = $3 ORDER BY id LIMIT 1`,
      [tenantId, facts.matched, facts.submitted_email])).rows[0];
  }
  if (!found) return { notice: "no_customer" };
  if (usableEmail(found.email) === null) return { notice: "no_email" };
  return { contactId: found.id };
}

/** BS-3: the plain confirmation. It names the business, the local time and the private link, nothing else. */
export function confirmationMessage(input: {
  readonly messageId: string; readonly contactId: string; readonly displayName: string | null; readonly business: string;
  readonly startsAt: Date; readonly timeZone: string; readonly url: string; readonly kind: ConfirmationKind;
}): MessageSendRequested {
  const business = oneLine(input.business, 120) || "our business";
  const when = localStart(input.startsAt, input.timeZone);
  const moved = input.kind === "rescheduled";
  return {
    messageId: input.messageId,
    contactId: input.contactId,
    channel: "email",
    purpose: "transactional",
    subject: moved ? `Your appointment is moved to ${when}` : `Your appointment on ${when} is confirmed`,
    body: [
      `Hi ${firstName(input.displayName)},`,
      "",
      moved
        ? `Your appointment with ${business} is now on ${when} (${input.timeZone}).`
        : `Your appointment with ${business} is booked for ${when} (${input.timeZone}).`,
      "",
      "Need to change it? Use this private link to cancel it or pick another time:",
      input.url,
      "",
      "Please keep the link to yourself. It stops working when the appointment starts.",
      "",
      business,
    ].join("\n"),
  };
}

/** One confirmation per booking, ever: a repeat derives the same ID and delivery drops it (D-2). */
export const confirmationMessageId = (tenantId: string, bookingId: string) => derivedId(tenantId, bookingId, "booking-confirmation");

export const confirmationSendHandler: ActionHandler = {
  resolveTarget: (tx, target) => requireWebsiteBooking(tx, target, "booking.confirmation_send"),

  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(confirmationCommandSchema, command);
    const link = manageConfig(config);
    const tenantId = binding.tenantId;
    const facts = (await tx.query<ConfirmationFacts>(
      `SELECT b.status, b.starts_at, r.time_zone, t.name AS business,
              i.submitted_name, i.submitted_email, i.status AS intake_status, i.contact_id AS intake_contact_id,
              i.matched_contact_ids AS matched
         FROM bookings b
         JOIN tenants t ON t.tenant_id = b.tenant_id
         JOIN booking_resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
         JOIN intake_items i ON i.tenant_id = b.tenant_id AND i.id = b.intake_item_id
        WHERE b.tenant_id=$1 AND b.id=$2`, [tenantId, payload.bookingId])).rows[0];
    if (!facts) throw new NotFound();
    const done = (notice: ConfirmationNotice, event?: { type: string; payload: JsonValue }) => {
      const result: ConfirmationResult = { notice };
      return { result: json(result), ...(event ? { event } : {}) };
    };
    if (facts.status !== "confirmed" || facts.starts_at.getTime() <= now.getTime()) return done("not_confirmed");
    const recipient = await confirmationRecipient(tx, tenantId, facts);
    if ("notice" in recipient) return done(recipient.notice);
    const message = confirmationMessage({
      messageId: confirmationMessageId(tenantId, payload.bookingId), contactId: recipient.contactId,
      displayName: facts.submitted_name, business: facts.business, startsAt: facts.starts_at, timeZone: facts.time_zone,
      url: manageUrl(link, tenantId, payload.bookingId, facts.starts_at), kind: payload.kind,
    });
    return done("queued", { type: MESSAGE_SEND_REQUESTED, payload: { ...message } });
  },
};

export const bookingSelfServiceHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [SELF_CANCEL_ACTION]: selfCancelHandler,
  [SELF_RESCHEDULE_ACTION]: selfRescheduleHandler,
  [CONFIRMATION_SEND_ACTION]: confirmationSendHandler,
});

interface ViewRow {
  id: string; status: string; starts_at: Date; ends_at: Date; resource_id: string; resource_name: string | null;
  time_zone: string; slot_length_minutes: number; business: string; source: string;
}

/**
 * BS-4: what the link's holder may see, read under the tenant's RLS. `token` signs a fresh link for a
 * booking this one was moved to. A booking that is missing, or not from the website, is `NotFound`.
 */
export async function manageView(
  tx: Transaction, tenantId: string, bookingId: string, now: Date, link: ManageLinkConfig | null,
): Promise<{ view: ManageView; resourceId: string }> {
  const row = (await tx.query<ViewRow>(
    `SELECT b.id, b.status, b.starts_at, b.ends_at, b.resource_id, r.name AS resource_name, r.time_zone,
            r.slot_length_minutes, t.name AS business, b.source
       FROM bookings b
       JOIN booking_resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
       JOIN tenants t ON t.tenant_id = b.tenant_id
      WHERE b.tenant_id=$1 AND b.id=$2`, [tenantId, bookingId])).rows[0];
  if (!row || row.source !== "website") throw new NotFound();
  let state: ManageView["state"] = "confirmed";
  let movedTo: ManageView["movedTo"] = null;
  if (row.status === "cancelled") {
    state = "cancelled";
    const next = (await tx.query<{ id: string; starts_at: Date; ends_at: Date }>(
      "SELECT id, starts_at, ends_at FROM bookings WHERE tenant_id=$1 AND rescheduled_from=$2 ORDER BY created_at DESC, id LIMIT 1",
      [tenantId, bookingId])).rows[0];
    if (next && link) {
      state = "moved";
      movedTo = {
        startsAt: next.starts_at.toISOString(), endsAt: next.ends_at.toISOString(),
        token: signManageToken(link.secret, { tenantId, bookingId: next.id, expiresAt: manageExpiry(next.starts_at) }),
      };
    }
  } else if (row.starts_at.getTime() <= now.getTime()) {
    state = "started";
  }
  return {
    resourceId: row.resource_id,
    view: {
      state,
      businessName: row.business,
      serviceName: row.resource_name,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      timeZone: row.time_zone,
      slotLengthMinutes: row.slot_length_minutes,
      canChange: state === "confirmed",
      movedTo,
    },
  };
}
