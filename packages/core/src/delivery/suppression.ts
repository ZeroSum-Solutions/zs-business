// Suppression list writes (delivery.md D-9). Original code. Both actions run through the
// shared dispatcher with a server-built principal; no member session can reach them
// (edge/session.ts ACTION_PERMISSIONS leaves them out).
import {
  inboundSmsReplySchema,
  liftSuppressionCommandSchema,
  recordSuppressionCommandSchema,
  SMS_REPLY_RECORD_ACTION,
  smsReplyCommandSchema,
  suppressionResultSchema,
  SUPPRESSION_LIFT_ACTION,
  SUPPRESSION_RECORD_ACTION,
  ValidationFailed,
  type ActionCommand,
  type ActionResult,
  type DeliveryChannel,
  type InboundSmsReply,
  type SuppressionResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";

/** One target per channel and address, so every write about one address names the same target. */
export const suppressionTargetId = (tenantId: string, channel: DeliveryChannel, address: string) =>
  derivedId(tenantId, channel, address, "suppression");

async function resolveSuppression(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "suppression") throw new ValidationFailed("Suppression actions require a suppression target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  return { tenantId, type: "suppression", id: target.id };
}

function requireTarget(command: { target: Target }, tenantId: string, channel: DeliveryChannel, address: string) {
  if (command.target.id !== suppressionTargetId(tenantId, channel, address))
    throw new ValidationFailed("Target must name the suppressed address");
}

const isSuppressed = async (tx: Transaction, tenantId: string, channel: DeliveryChannel, address: string) =>
  (await tx.query("SELECT 1 FROM suppressions WHERE tenant_id=$1 AND channel=$2::crm_consent_channel AND address=$3",
    [tenantId, channel, address])).rowCount === 1;

export const recordSuppressionHandler: ActionHandler = {
  resolveTarget: resolveSuppression,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(recordSuppressionCommandSchema, command);
    requireTarget(command, binding.tenantId, payload.channel, payload.address);
    // The first reason stays, except that a lasting reason (bounce, complaint, manual,
    // unsubscribe) replaces `stop`, so a later START cannot lift it.
    const written = await tx.query(
      `INSERT INTO suppressions (tenant_id, channel, address, reason, source, created_at)
       VALUES ($1,$2::crm_consent_channel,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, channel, address) DO UPDATE SET reason=EXCLUDED.reason, source=EXCLUDED.source
         WHERE suppressions.reason='stop' AND EXCLUDED.reason<>'stop'`,
      [binding.tenantId, payload.channel, payload.address, payload.reason, payload.source, now]);
    const result: SuppressionResult = { channel: payload.channel, suppressed: true, changed: written.rowCount === 1 };
    return { result: { ...result } };
  },
};

export const liftSuppressionHandler: ActionHandler = {
  resolveTarget: resolveSuppression,
  async handle({ tx, command, binding }) {
    const { payload } = parseOrFail(liftSuppressionCommandSchema, command);
    requireTarget(command, binding.tenantId, payload.channel, payload.address);
    const deleted = await tx.query(
      "DELETE FROM suppressions WHERE tenant_id=$1 AND channel='sms' AND address=$2 AND reason='stop'",
      [binding.tenantId, payload.address]);
    const result: SuppressionResult = {
      channel: "sms",
      suppressed: await isSuppressed(tx, binding.tenantId, "sms", payload.address),
      changed: deleted.rowCount === 1,
    };
    return { result: { ...result } };
  },
};

/** twilio.md T-8: the action row is the record; its stored result is what a repeat gets back. */
export const recordSmsReplyHandler: ActionHandler = {
  resolveTarget: resolveSuppression,
  async handle({ command, binding }) {
    const { payload } = parseOrFail(smsReplyCommandSchema, command);
    requireTarget(command, binding.tenantId, "sms", payload.address);
    const result: InboundSmsReply = { keyword: payload.keyword, reply: payload.reply };
    return { result: { ...result } };
  },
};

export const suppressionHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [SUPPRESSION_RECORD_ACTION]: recordSuppressionHandler,
  [SUPPRESSION_LIFT_ACTION]: liftSuppressionHandler,
  [SMS_REPLY_RECORD_ACTION]: recordSmsReplyHandler,
});

interface WriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
export async function recordSuppression(command: ActionCommand, ctx: WriteContext): Promise<SuppressionResult> {
  const parsed = parseOrFail(recordSuppressionCommandSchema, command);
  const output = await ctx.dispatch(parsed);
  return parseOrFail(suppressionResultSchema, output.result);
}
export async function recordSmsReply(command: ActionCommand, ctx: WriteContext): Promise<InboundSmsReply> {
  const parsed = parseOrFail(smsReplyCommandSchema, command);
  const output = await ctx.dispatch(parsed);
  return parseOrFail(inboundSmsReplySchema, output.result);
}
export async function liftSuppression(command: ActionCommand, ctx: WriteContext): Promise<SuppressionResult> {
  const parsed = parseOrFail(liftSuppressionCommandSchema, command);
  const output = await ctx.dispatch(parsed);
  return parseOrFail(suppressionResultSchema, output.result);
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

const EDGE_CHARACTER = /^[\s\p{P}]$/u;
const KEYWORD_MAX_LENGTH = 64;

/** D-9: the keyword an inbound SMS consists of, ignoring case, spaces and punctuation around it. */
export function smsKeyword(body: string): "stop" | "start" | "help" | null {
  // Linear scans, no backtracking regex: the body is whatever a sender typed (its length is
  // capped at ingress). The bound applies to what is left once the padding is gone.
  let start = 0;
  let end = body.length;
  while (start < end && EDGE_CHARACTER.test(body[start]!)) start += 1;
  while (end > start && EDGE_CHARACTER.test(body[end - 1]!)) end -= 1;
  if (end - start > KEYWORD_MAX_LENGTH) return null;
  const word = body.slice(start, end).toLowerCase().replace(/[\s-]/g, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}
