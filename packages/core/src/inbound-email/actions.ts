// Inbound email receive (docs/requirements/inbound-email.md IE-9, IE-17). Runs in the shared
// dispatcher transaction as the runtime role; only the server's inbound-email principal may run it
// (edge/inbound-email-session.ts). Original code.
import {
  Conflict,
  INBOUND_ADMISSION_LIMIT,
  INBOUND_ADMISSION_WINDOW_MS,
  INBOUND_EMAIL_IDEMPOTENCY_PREFIX,
  INBOUND_EMAIL_RECEIVE_ACTION,
  INBOUND_EMAIL_RECEIVED_EVENT,
  ValidationFailed,
  inboundEmailReceiveCommandSchema,
  type InboundEmailReceivedEvent,
  type InboundEmailReceiveResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";

/** IE-9: one row per tenant and Resend `email_id`, so a replay or a second event names the same row. */
export const inboundEmailId = (tenantId: string, providerEmailId: string) =>
  derivedId(tenantId, `${INBOUND_EMAIL_IDEMPOTENCY_PREFIX}${providerEmailId}`, "inbound-email");
/** IE-21: one sender thread per tenant and normalised address. */
export const inboundSenderKey = (tenantId: string, fromAddress: string) => derivedId(tenantId, "inbound-sender", fromAddress);

/** The reason a receive is refused at the admission cap (IE-17); the session logs it and answers 200. */
export const OVER_ADMISSION = "over_admission";

async function resolveInboundEmail(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "inbound_email") throw new ValidationFailed("Inbound email actions require an inbound_email target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  return { tenantId, type: "inbound_email", id: target.id };
}

export const inboundEmailReceiveHandler: ActionHandler = {
  resolveTarget: resolveInboundEmail,
  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(inboundEmailReceiveCommandSchema, command);
    const tenantId = binding.tenantId;
    if (payload.inboundEmailId !== inboundEmailId(tenantId, payload.providerEmailId))
      throw new ValidationFailed("Target must name the provider email");
    // IE-17: per tenant at most 2,000 received rows in 24 hours by the injected clock. The lock makes
    // concurrent receives for one tenant count in turn, so the cap is never passed by a race.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`inbound-admission:${tenantId}`]);
    // The clock is read after the lock wait, so the window and the stored time are the same instant.
    const now = clock();
    const since = new Date(now.getTime() - INBOUND_ADMISSION_WINDOW_MS);
    const used = (await tx.query<{ used: number }>(
      "SELECT count(*)::int AS used FROM inbound_emails WHERE tenant_id=$1 AND received_at > $2",
      [tenantId, since])).rows[0]!.used;
    if (used >= INBOUND_ADMISSION_LIMIT) throw new Conflict("Inbound admission limit reached", { reason: OVER_ADMISSION });
    const senderKey = inboundSenderKey(tenantId, payload.fromAddress);
    // IE-9: status received, kind unclassified, body none (column defaults); never a body.
    await tx.query(
      `INSERT INTO inbound_emails (tenant_id, id, address_id, provider, provider_email_id, reply_ref, from_address, subject,
                                   received_at, sender_key, created_at)
       VALUES ($1,$2,$3,'resend',$4,$5,$6,$7,$8,$9,$8)`,
      [tenantId, payload.inboundEmailId, payload.addressId, payload.providerEmailId, payload.replyRef,
        payload.fromAddress, payload.subject, now, senderKey]);
    const result: InboundEmailReceiveResult = { inboundEmailId: payload.inboundEmailId, senderKey };
    const event: InboundEmailReceivedEvent = { inboundEmailId: payload.inboundEmailId };
    return { result: { ...result }, event: { type: INBOUND_EMAIL_RECEIVED_EVENT, payload: { ...event } } };
  },
};

export const inboundEmailHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [INBOUND_EMAIL_RECEIVE_ACTION]: inboundEmailReceiveHandler,
});
