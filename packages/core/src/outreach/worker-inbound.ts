// Replies and bounces (outreach-sequencer.md OS-19, OS-20). Each run reads the mailbox's Gmail history from its cursor,
// classifies each new message from its headers and labels (never its body), writes one inbound event per matched
// message, and stops the matched prospect only. A bounce also records a suppression through the shared action path.
import { SUPPRESSION_RECORD_ACTION } from "@zs/contracts";
import { recordSuppression, suppressionTargetId } from "../delivery/suppression.js";
import { only } from "../edge/dispatch-util.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, type EdgeDependencies } from "../edge/session.js";
import { addressesIn, classifyInbound, type Classification, type ClassifyContext, type InboundMessage } from "./classify.js";
import { INBOUND_HEADER_NAMES, type GmailHistoryMessage } from "./gmail-port.js";
import { errorCode, errorStatus, PAUSED_UNTIL_OPERATOR, stopProspect, type Box, type Ctx } from "./worker-kit.js";

export interface ProspectRef {
  readonly id: string;
  readonly email: string;
  readonly campaign_id: string;
  readonly status: string;
  readonly thread_id: string | null;
}

/** The prospects of one mailbox and the Gmail ids this system sent from it: what the classifier needs. */
export async function loadInboundContext(ctx: Ctx, box: Box) {
  const prospects = (await ctx.deps.service((tx) => tx.query<ProspectRef>(
    "SELECT id, email, campaign_id, status, thread_id FROM outreach_prospects WHERE tenant_id=$1 AND mailbox_id=$2",
    [box.tenantId, box.id]))).rows;
  const sends = (await ctx.deps.service((tx) => tx.query<{ id: string; gmail_message_id: string | null }>(
    "SELECT id, gmail_message_id FROM outreach_sends WHERE tenant_id=$1 AND mailbox_id=$2", [box.tenantId, box.id]))).rows;
  const own = new Set(sends.flatMap((row) => (row.gmail_message_id === null ? [] : [row.gmail_message_id])));
  // The ids of our own send attempts: the only values of `X-Zs-Ref` that can mark a message as ours (OS-19).
  const ownRefs = new Set(sends.map((row) => row.id));
  const byId = new Map(prospects.map((prospect) => [prospect.id, prospect]));
  const byThread = new Map<string, string>();
  const byAddress = new Map<string, string>();
  for (const prospect of prospects) {
    if (prospect.thread_id) byThread.set(prospect.thread_id, prospect.id);
    byAddress.set(prospect.email, prospect.id);
  }
  return { byId, own, context: { mailboxAddress: box.email, ownMessageIds: own, prospectByThread: byThread, prospectByAddress: byAddress, ownRefs } satisfies InboundClassifyContext };
}
export type InboundContext = Awaited<ReturnType<typeof loadInboundContext>>;
export type InboundClassifyContext = ClassifyContext & { readonly ownRefs: ReadonlySet<string> };

const STOP_STATUS = { reply: "replied", owner_reply: "owner_replied", bounce: "bounced" } as const;

/** OS-19: the bounce suppression, through `directDispatch` as the outreach actor, keyed by mailbox and Gmail message. */
async function recordBounce(ctx: Ctx, box: Box, prospect: ProspectRef, gmailMessageId: string): Promise<void> {
  const tenantId = box.tenantId;
  // The suppression runs through the runtime role, outside the lease transaction: a run that lost its lease writes nothing.
  await ctx.leased(box, async () => undefined);
  const edge: EdgeDependencies = { db: ctx.deps.db, clock: ctx.deps.clock, generateId: ctx.deps.generateId };
  const run = directDispatch(edge, tenantId, derivedId(tenantId, "outreach", "actor"), only(SUPPRESSION_RECORD_ACTION));
  const idempotencyKey = `outreach:bounce:${box.id}:${gmailMessageId}`;
  await recordSuppression({
    actionType: SUPPRESSION_RECORD_ACTION,
    target: { tenantId, type: "suppression", id: suppressionTargetId(tenantId, "email", prospect.email) },
    approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
    idempotencyKey,
    payload: { channel: "email", address: prospect.email, reason: "bounce", source: `outreach-bounce:${gmailMessageId}` },
  }, { dispatch: run });
}

/**
 * OS-20: at least `bounceMinSent` sent rows and bounces at `bouncePercent` or more pause the campaign. Bounces are the
 * campaign's bounce events, so a prospect that bounced after its last step still counts, and a prospect stopped before
 * any mail (a bounce suppression found at send time) never does.
 */
export async function checkBounceRate(ctx: Ctx, box: Box, campaignId: string): Promise<void> {
  const tenantId = box.tenantId;
  const row = (await ctx.deps.service((tx) => tx.query<{ sent: number; bounced: number }>(
    `SELECT (SELECT count(*)::int FROM outreach_sends WHERE tenant_id=$1 AND campaign_id=$2 AND status='sent') AS sent,
            (SELECT count(DISTINCT e.prospect_id)::int FROM outreach_inbound_events e
               JOIN outreach_prospects p ON p.tenant_id=e.tenant_id AND p.id=e.prospect_id
              WHERE e.tenant_id=$1 AND p.campaign_id=$2 AND e.kind='bounce') AS bounced`,
    [tenantId, campaignId]))).rows[0]!;
  if (row.sent < ctx.cfg.bounceMinSent || row.bounced * 100 < row.sent * ctx.cfg.bouncePercent) return;
  const paused = await ctx.leased(box, async (tx) => (await tx.query(
    "UPDATE outreach_campaigns SET status='paused', paused_reason='bounce_rate', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'",
    [tenantId, campaignId, ctx.now()])).rowCount === 1);
  if (!paused) return;
  ctx.counts.campaignsPaused += 1;
  ctx.report({ kind: "outreach_bounce_rate", tenantId, campaignId, sent: row.sent, bounced: row.bounced });
}

/** OS-20: one check per run for every active campaign this mailbox sends for. */
export async function checkMailboxCampaigns(ctx: Ctx, box: Box): Promise<boolean> {
  const campaigns = (await ctx.deps.service((tx) => tx.query<{ campaign_id: string }>(
    `SELECT DISTINCT p.campaign_id FROM outreach_prospects p JOIN outreach_campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id
      WHERE p.tenant_id=$1 AND p.mailbox_id=$2 AND c.status='active'`, [box.tenantId, box.id]))).rows;
  for (const { campaign_id } of campaigns) await checkBounceRate(ctx, box, campaign_id);
  return true;
}

/**
 * Applies one classified message to its prospect. The bounce suppression comes first: it replays under its key, so a run
 * that stopped before the event row was written finishes the job next time. The event row is the once-only marker.
 */
export async function applyInbound(
  ctx: Ctx, box: Box, message: InboundMessage, classification: Exclude<Classification, { kind: "own" | "unmatched" }>, prospect: ProspectRef,
): Promise<boolean> {
  const kind = classification.kind;
  if (kind === "bounce") await recordBounce(ctx, box, prospect, message.id);
  const at = ctx.now();
  const recorded = await ctx.leased(box, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO outreach_inbound_events (tenant_id,id,mailbox_id,gmail_message_id,gmail_thread_id,prospect_id,kind,received_at,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (tenant_id, mailbox_id, gmail_message_id) DO NOTHING`,
      [box.tenantId, ctx.deps.generateId(), box.id, message.id, message.threadId, prospect.id, kind, at]);
    if (inserted.rowCount !== 1) return false;
    if (kind !== "auto_reply") await stopProspect(tx, box.tenantId, prospect.id, STOP_STATUS[kind], at);
    return true;
  });
  if (!recorded) return false;
  if (kind === "reply") ctx.counts.replies += 1;
  else if (kind === "owner_reply") ctx.counts.ownerReplies += 1;
  else if (kind === "bounce") ctx.counts.bounces += 1;
  else ctx.counts.autoReplies += 1;
  if (kind === "bounce") await checkBounceRate(ctx, box, prospect.campaign_id);
  return true;
}

/**
 * Classifies a message Gmail described. `own` only when it carries the `X-Zs-Ref` of one of this mailbox's sends AND it
 * is mail we sent (the SENT label or the mailbox as sender): a prospect's reply that carries the header, quoted or copied
 * by a mail client, is still a reply (OS-19).
 */
export function classifyMessage(message: InboundMessage, context: InboundClassifyContext): Classification {
  const ref = message.headers["x-zs-ref"];
  if (ref !== undefined && context.ownRefs.has(ref)
    && (message.labelIds.includes("SENT") || addressesIn(message.headers.from)[0] === context.mailboxAddress)) return { kind: "own" };
  return classifyInbound(message, context);
}

interface Gap { readonly paused: boolean }

/**
 * Moves the cursor to the mailbox's current head after a gap or a first run (OS-19). When the mailbox has mailed prospects
 * that are still open, the gap may hide replies and bounces that cannot be found again: new-thread replies in the gap are
 * unreadable, and a sent follow-up would ignore them. The mailbox is then paused until the operator reconnects it, and the
 * operator is told; it sends nothing in between. True when it is safe to send now.
 */
async function resetCursor(ctx: Ctx, box: Box, reason: "no_cursor" | "expired"): Promise<boolean> {
  const profile = await ctx.call((signal) => ctx.gmail.getProfile(box.accessToken, { signal }));
  const mailed = (await ctx.deps.service((tx) => tx.query(
    `SELECT 1 FROM outreach_prospects WHERE tenant_id=$1 AND mailbox_id=$2 AND status='active' AND thread_id IS NOT NULL LIMIT 1`,
    [box.tenantId, box.id]))).rowCount! > 0;
  const gap: Gap = { paused: mailed };
  await ctx.leased(box, async (tx) => {
    await tx.query(
      "UPDATE outreach_mailboxes SET history_id=$3, history_checked_at=$4, history_resume_token=NULL, updated_at=$4 WHERE tenant_id=$1 AND id=$2",
      [box.tenantId, box.id, profile.historyId, ctx.now()]);
    if (gap.paused)
      await tx.query("UPDATE outreach_mailboxes SET paused_until=$3, pause_reason='history_gap' WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, PAUSED_UNTIL_OPERATOR]);
  });
  ctx.counts.historyResets += 1;
  ctx.report({ kind: "outreach_history_reset", tenantId: box.tenantId, mailboxId: box.id, reason, ...(gap.paused ? { paused: true } : {}) });
  return !gap.paused;
}

/**
 * OS-19: reads the mailbox's new history page by page from its cursor and classifies each page's messages in history order
 * before the next page is read. A run that cannot finish (page or message cap) stores the next page token and stops; the
 * next run resumes from it, so the head is never re-read forever. The cursor itself moves only after the last page. True
 * when the mailbox is caught up, which is the condition for sending from it (a reply not read yet must stop its prospect).
 */
export async function pollInbound(ctx: Ctx, box: Box): Promise<boolean> {
  const state = (await ctx.deps.service((tx) => tx.query<{ history_id: string | null; history_resume_token: string | null }>(
    "SELECT history_id, history_resume_token FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id]))).rows[0];
  const cursor = state?.history_id ?? null;
  if (cursor === null) return resetCursor(ctx, box, "no_cursor");

  const inbound = await loadInboundContext(ctx, box);
  const seen = new Set<string>();
  let pageToken = state?.history_resume_token ?? undefined;
  let pages = 0;
  let reads = 0;
  for (;;) {
    if (pages >= ctx.cfg.maxHistoryPages || reads >= ctx.cfg.maxInboundMessages) return false; // resume next run
    let page;
    try {
      page = await ctx.call((signal) => ctx.gmail.listHistory(box.accessToken, { startHistoryId: cursor, ...(pageToken ? { pageToken } : {}) }, { signal }));
    } catch (error) {
      if (errorCode(error) === "history_expired") return resetCursor(ctx, box, "expired");
      // A stored page token Gmail no longer accepts: read from the cursor again next run (every message is once-only).
      if (pageToken !== undefined && errorStatus(error) === 400) {
        await ctx.leased(box, (tx) => tx.query("UPDATE outreach_mailboxes SET history_resume_token=NULL WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id]));
        return false;
      }
      throw error;
    }
    pages += 1;
    for (const entry of page.messages) {
      if (seen.has(entry.id) || inbound.own.has(entry.id)) continue;
      seen.add(entry.id);
      // Mail the owner sent by hand outside any prospect's thread cannot be a reply.
      if (entry.labelIds.includes("SENT") && !inbound.context.prospectByThread.has(entry.threadId)) continue;
      reads += 1;
      const metadata = await ctx.call((signal) => ctx.gmail.getMessageHeaders(box.accessToken, entry.id, INBOUND_HEADER_NAMES, { signal }));
      ctx.counts.inboundRead += 1;
      if (metadata === null) continue;
      const message: InboundMessage = { id: metadata.id, threadId: metadata.threadId, labelIds: metadata.labelIds.length > 0 ? metadata.labelIds : entry.labelIds, headers: metadata.headers };
      const classification = classifyMessage(message, inbound.context);
      if (classification.kind === "own" || classification.kind === "unmatched") continue;
      const prospect = inbound.byId.get(classification.prospectId);
      if (prospect) await applyInbound(ctx, box, message, classification, prospect);
    }
    if (page.nextPageToken === null) {
      await ctx.leased(box, (tx) => tx.query(
        "UPDATE outreach_mailboxes SET history_id=$3, history_checked_at=$4, history_resume_token=NULL, updated_at=$4 WHERE tenant_id=$1 AND id=$2",
        [box.tenantId, box.id, page.historyId, ctx.now()]));
      return true;
    }
    pageToken = page.nextPageToken;
    const token = pageToken;
    await ctx.leased(box, (tx) => tx.query("UPDATE outreach_mailboxes SET history_resume_token=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, token, ctx.now()]));
  }
}
