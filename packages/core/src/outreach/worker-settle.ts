// Settling a send attempt (outreach-sequencer.md OS-15, OS-16). `markSent` is the one place an accepted or recovered send
// advances its prospect's schedule (OS-11); the probe finds a message whose answer was lost by its `X-Zs-Ref` header.
import type { Transaction } from "@zs/db";
import { addBusinessDays } from "./schedule.js";
import { errorCode, stopProspect, type Box, type Ctx } from "./worker-kit.js";

export interface SendRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly prospect_id: string;
  readonly step_number: number;
  /** `YYYY-MM-DD`: the local date the attempt started on, which later delays count from. */
  readonly local_send_date: string;
}

/**
 * Marks an open attempt `sent` and moves its prospect on: the next step is due `delay` business days after the send's
 * local date, or the prospect is `completed` after the last step. A prospect stopped meanwhile keeps its status.
 */
export async function markSent(
  tx: Transaction, ctx: Ctx, box: Box, send: SendRow, result: { messageId: string; threadId: string; rfcMessageId: string | null },
): Promise<boolean> {
  const at = ctx.now();
  const updated = await tx.query(
    `UPDATE outreach_sends SET status='sent', gmail_message_id=$3, gmail_thread_id=$4, rfc_message_id=$5, settled_at=$6, error_code=NULL, updated_at=$6
      WHERE tenant_id=$1 AND id=$2 AND status IN ('sending','uncertain')`,
    [box.tenantId, send.id, result.messageId, result.threadId, result.rfcMessageId, at]);
  if (updated.rowCount !== 1) return false;
  const steps = (await tx.query<{ step_number: number; delay_business_days: number }>(
    "SELECT step_number, delay_business_days FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY step_number",
    [box.tenantId, send.campaign_id])).rows;
  const next = steps.find((step) => step.step_number === send.step_number + 1);
  if (send.step_number === 1) {
    await tx.query("UPDATE outreach_prospects SET thread_id=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND thread_id IS NULL",
      [box.tenantId, send.prospect_id, result.threadId, at]);
  }
  if (next) {
    await tx.query(
      `UPDATE outreach_prospects SET next_step=$3, next_due_on=$4::date, updated_at=$5
        WHERE tenant_id=$1 AND id=$2 AND status='active' AND next_step=$6`,
      [box.tenantId, send.prospect_id, next.step_number, addBusinessDays(send.local_send_date, next.delay_business_days), at, send.step_number]);
  } else {
    await tx.query(
      `UPDATE outreach_prospects SET status='completed', next_step=NULL, next_due_on=NULL, updated_at=$3
        WHERE tenant_id=$1 AND id=$2 AND status='active' AND next_step=$4`, [box.tenantId, send.prospect_id, at, send.step_number]);
  }
  await tx.query("UPDATE outreach_mailboxes SET last_send_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, at]);
  return true;
}

/** OS-16: the send is gone for good; it is never sent again and its prospect stops. */
async function markLost(tx: Transaction, ctx: Ctx, box: Box, send: SendRow): Promise<void> {
  const at = ctx.now();
  const updated = await tx.query(
    "UPDATE outreach_sends SET status='lost', settled_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('sending','uncertain')",
    [box.tenantId, send.id, at]);
  if (updated.rowCount !== 1) return;
  await stopProspect(tx, box.tenantId, send.prospect_id, "send_outcome_unknown", at);
  ctx.counts.lost += 1;
  ctx.report({ kind: "outreach_send_outcome_unknown", tenantId: box.tenantId, mailboxId: box.id, sendId: send.id });
}

interface OpenSend extends SendRow { readonly history_id_before: string | null }

/**
 * OS-16: attempts a crashed run left `sending` are `uncertain` (this run holds the lease, so no live run owns them). Each
 * uncertain attempt older than the probe delay is looked up in the mailbox's history by its `X-Zs-Ref`. A match settles it
 * `sent`. History read to its end without a match, history Gmail no longer keeps, or no start point make it `lost`.
 * A Gmail failure leaves the attempt uncertain for the next run.
 */
export async function settleOpenAttempts(ctx: Ctx, box: Box): Promise<void> {
  await ctx.leased(box, (tx) => tx.query(
    "UPDATE outreach_sends SET status='uncertain', updated_at=$3 WHERE tenant_id=$1 AND mailbox_id=$2 AND status='sending'", [box.tenantId, box.id, ctx.now()]));
  const due = (await ctx.deps.service((tx) => tx.query<OpenSend>(
    `SELECT id, campaign_id, prospect_id, step_number, to_char(local_send_date,'YYYY-MM-DD') AS local_send_date, history_id_before
       FROM outreach_sends WHERE tenant_id=$1 AND mailbox_id=$2 AND status='uncertain' AND attempt_started_at <= $3
      ORDER BY attempt_started_at, id`,
    [box.tenantId, box.id, new Date(ctx.now().getTime() - ctx.cfg.probeDelayMs)]))).rows;
  if (due.length === 0) return;
  ctx.counts.probed += due.length;

  const readable = due.filter((send) => send.history_id_before !== null);
  for (const send of due.filter((candidate) => candidate.history_id_before === null)) await ctx.leased(box, (tx) => markLost(tx, ctx, box, send));
  if (readable.length === 0) return;

  const start = readable.map((send) => BigInt(send.history_id_before!)).reduce((least, id) => (id < least ? id : least)).toString();
  const sentIds: string[] = [];
  try {
    let pageToken: string | undefined;
    for (let pages = 1; ; pages += 1) {
      const page = await ctx.call((signal) => ctx.gmail.listHistory(box.accessToken, { startHistoryId: start, ...(pageToken ? { pageToken } : {}) }, { signal }));
      for (const message of page.messages) if (message.labelIds.includes("SENT")) sentIds.push(message.id);
      if (page.nextPageToken === null) break;
      if (pages >= ctx.cfg.maxHistoryPages) return; // not read to its end: nothing is decided
      pageToken = page.nextPageToken;
    }
  } catch (error) {
    if (errorCode(error) !== "history_expired") throw error;
    for (const send of readable) await ctx.leased(box, (tx) => markLost(tx, ctx, box, send));
    return;
  }

  const wanted = new Set(readable.map((send) => send.id));
  const found = new Map<string, { messageId: string; threadId: string; rfcMessageId: string | null }>();
  for (const messageId of new Set(sentIds)) {
    if (found.size === wanted.size) break;
    const metadata = await ctx.call((signal) => ctx.gmail.getMessageHeaders(box.accessToken, messageId, ["X-Zs-Ref", "Message-ID"], { signal }));
    const ref = metadata?.headers["x-zs-ref"];
    if (metadata && ref !== undefined && wanted.has(ref) && !found.has(ref))
      found.set(ref, { messageId: metadata.id, threadId: metadata.threadId, rfcMessageId: metadata.headers["message-id"] ?? null });
  }
  for (const send of readable) {
    const match = found.get(send.id);
    await ctx.leased(box, async (tx) => {
      if (match) {
        if (await markSent(tx, ctx, box, send, match)) ctx.counts.settledSent += 1;
      } else await markLost(tx, ctx, box, send);
    });
  }
}
