// SMS status evidence (docs/requirements/twilio.md T-5, T-7). Original code. The status-callback
// session records each signed status through the dispatcher; the delivery worker reads the
// evidence back (service role) to settle an unknown outcome, and reads the tenant's number to
// send from. No member session can reach the action (edge/session.ts ACTION_PERMISSIONS).
import {
  Conflict,
  SMS_STATUS_RECORD_ACTION,
  smsStatusCommandSchema,
  smsStatusResultSchema,
  ValidationFailed,
  type ActionCommand,
  type ActionResult,
  type SmsStatusResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";

export const smsStatusHandler: ActionHandler = {
  async resolveTarget(tx: Transaction, target: Target): Promise<Target | null> {
    if (target.type !== "delivery") throw new ValidationFailed("SMS status actions require a delivery target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    const found = await tx.query("SELECT 1 FROM message_deliveries WHERE tenant_id=$1 AND id=$2 AND channel='sms'",
      [tenantId, target.id]);
    return found.rowCount === 1 ? { tenantId, type: "delivery", id: target.id } : null;
  },
  async handle({ tx, command, binding, now, generateId }) {
    const { payload } = parseOrFail(smsStatusCommandSchema, command);
    if (payload.deliveryId !== command.target.id) throw new ValidationFailed("Target must name the delivery");
    // One delivery is one provider message: a send only follows a definite refusal (D-8).
    const other = await tx.query(
      `SELECT 1 FROM message_deliveries WHERE tenant_id=$1 AND id=$2 AND provider_message_id IS NOT NULL AND provider_message_id<>$3
       UNION ALL SELECT 1 FROM sms_status_events WHERE tenant_id=$1 AND delivery_id=$2 AND provider_message_id<>$3 LIMIT 1`,
      [binding.tenantId, payload.deliveryId, payload.providerMessageId]);
    if (other.rowCount) throw new Conflict("The delivery names another provider message", { reason: "message_mismatch" });
    const written = await tx.query(
      `INSERT INTO sms_status_events (tenant_id, id, delivery_id, provider_message_id, status, error_code, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, provider_message_id, status) DO NOTHING`,
      [binding.tenantId, generateId(), payload.deliveryId, payload.providerMessageId, payload.status, payload.errorCode, now]);
    const result: SmsStatusResult = { deliveryId: payload.deliveryId, status: payload.status, recorded: written.rowCount === 1 };
    return { result: { ...result } };
  },
};

export const smsStatusHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [SMS_STATUS_RECORD_ACTION]: smsStatusHandler,
});

export async function recordSmsStatus(command: ActionCommand, ctx: {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}): Promise<SmsStatusResult> {
  const parsed = parseOrFail(smsStatusCommandSchema, command);
  const output = await ctx.dispatch(parsed);
  return parseOrFail(smsStatusResultSchema, output.result);
}

/**
 * T-5: the provider message a signed status proved, for the worker's lookup. Runs as the service
 * role, naming tenant_id; a delivery with statuses for two messages proves nothing.
 */
export async function smsStatusEvidence(tx: Transaction, input: { readonly tenantId: string; readonly deliveryId: string }):
  Promise<{ messageSid: string } | null> {
  const rows = (await tx.query<{ provider_message_id: string }>(
    "SELECT DISTINCT provider_message_id FROM sms_status_events WHERE tenant_id=$1 AND delivery_id=$2 LIMIT 2",
    [input.tenantId, input.deliveryId])).rows;
  return rows.length === 1 ? { messageSid: rows[0]!.provider_message_id } : null;
}

/** T-3, T-7: the tenant's own sending number, or null when it has none. */
export async function smsSenderNumber(tx: Transaction, tenantId: string): Promise<string | null> {
  return (await tx.query<{ phone_number: string }>(
    "SELECT phone_number FROM sms_numbers WHERE tenant_id=$1", [tenantId])).rows[0]?.phone_number ?? null;
}

/**
 * T-7: an operator assigns (or with `phoneNumber: null` removes) a tenant's sending number, as the
 * service role. A number another tenant holds is refused by the unique key.
 */
export async function assignSmsNumber(tx: Transaction, input: {
  readonly tenantId: string;
  readonly phoneNumber: string | null;
  readonly helpReply?: string | null;
  readonly now: Date;
}): Promise<{ phoneNumber: string | null; helpReply: string | null }> {
  if (input.phoneNumber === null) {
    await tx.query("DELETE FROM sms_numbers WHERE tenant_id=$1", [input.tenantId]);
    return { phoneNumber: null, helpReply: null };
  }
  if (!/^\+[1-9][0-9]{1,14}$/.test(input.phoneNumber)) throw new ValidationFailed("The number must be E.164, like +15555550100");
  const helpReply = input.helpReply ?? null;
  if (helpReply !== null && (helpReply.length < 1 || helpReply.length > 320)) throw new ValidationFailed("The HELP reply must be 1 to 320 characters");
  await tx.query(
    `INSERT INTO sms_numbers (tenant_id, phone_number, help_reply, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET phone_number=EXCLUDED.phone_number, help_reply=EXCLUDED.help_reply, updated_at=EXCLUDED.updated_at`,
    [input.tenantId, input.phoneNumber, helpReply, input.now]);
  return { phoneNumber: input.phoneNumber, helpReply };
}
