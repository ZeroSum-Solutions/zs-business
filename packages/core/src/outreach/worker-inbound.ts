// Replies and bounces (outreach-sequencer.md OS-19, OS-20). Each run reads the mailbox's Gmail history from its cursor,
// classifies each new message from its headers and labels (never its body), writes one inbound event per matched
// message, and stops the matched prospect only. A bounce also records a suppression through the shared action path.
import { SUPPRESSION_RECORD_ACTION } from "@zs/contracts";
import { recordSuppression, suppressionTargetId } from "../delivery/suppression.js";
import { only } from "../edge/dispatch-util.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, type EdgeDependencies } from "../edge/session.js";
import { classifyInbound, type Classification, type InboundMessage } from "./classify.js";
import { INBOUND_HEADER_NAMES, type GmailHistoryMessage } from "./gmail-port.js";
import { errorCode, stopProspect, type Box, type Ctx } from "./worker-kit.js";

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
  const own = new Set((await ctx.deps.service((tx) => tx.query<{ gmail_message_id: string }>(
    "SELECT gmail_message_id FROM outreach_sends WHERE tenant_id=$1 AND mailbox_id=$2 AND gmail_message_id IS NOT NULL",
    [box.tenantId, box.id]))).rows.map((row) => row.gmail_message_id));
  const byId = new Map(prospects.map((prospect) => [prospect.id, prospect]));
  const byThread = new Map<string, string>();
  const byAddress = new Map<string, string>();
  for (const prospect of prospects) {
    if (prospect.thread_id) byThread.set(prospect.thread_id, prospect.id);
    byAddress.set(prospect.email, prospect.id);
  }
  return { byId, own, context: { mailboxAddress: box.email, ownMessageIds: own, prospectByThread: byThread, prospectByAddress: byAddress } };
}
export type InboundContext = Awaited<ReturnType<typeof loadInboundContext>>;

const STOP_STATUS = { reply: "replied", owner_reply: "owner_replied", bounce: "bounced" } as const;

/** OS-19: the bounce suppression, through `directDispatch` as the outreach actor, keyed by mailbox and Gmail message. */
async function recordBounce(ctx: Ctx, box: Box, prospect: ProspectRef, gmailMessageId: string): Promise<void> {
  const tenantId = box.tenantId;
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

/** OS-20: at least `bounceMinSent` sent rows and bounces at `bouncePercent` or more pause the campaign. */
export async function checkBounceRate(ctx: Ctx, tenantId: string, campaignId: string): Promise<void> {
  const row = (await ctx.deps.service((tx) => tx.query<{ sent: number; bounced: number }>(
    `SELECT (SELECT count(*)::int FROM outreach_sends WHERE tenant_id=$1 AND campaign_id=$2 AND status='sent') AS sent,
            (SELECT count(*)::int FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 AND status='bounced') AS bounced`,
    [tenantId, campaignId]))).rows[0]!;
  if (row.sent < ctx.cfg.bounceMinSent || row.bounced * 100 < row.sent * ctx.cfg.bouncePercent) return;
  const paused = await ctx.deps.service(async (tx) => (await tx.query(
    "UPDATE outreach_campaigns SET status='paused', paused_reason='bounce_rate', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'",
    [tenantId, campaignId, ctx.now()])).rowCount === 1);
  if (!paused) return;
  ctx.counts.campaignsPaused += 1;
  ctx.report({ kind: "outreach_bounce_rate", tenantId, campaignId, sent: row.sent, bounced: row.bounced });
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
  if (kind === "bounce") await checkBounceRate(ctx, box.tenantId, prospect.campaign_id);
  return true;
}

/** Classifies a message Gmail described; `own` when it carries our `X-Zs-Ref` (a send whose outcome is not settled yet). */
export function classifyMessage(message: InboundMessage, context: InboundContext["context"]): Classification {
  if (message.headers["x-zs-ref"] !== undefined) return { kind: "own" };
  return classifyInbound(message, context);
}

async function resetCursor(ctx: Ctx, box: Box, reason: "no_cursor" | "expired"): Promise<void> {
  const profile = await ctx.call((signal) => ctx.gmail.getProfile(box.accessToken, { signal }));
  await ctx.leased(box, (tx) => tx.query(
    "UPDATE outreach_mailboxes SET history_id=$3, history_checked_at=$4, updated_at=$4 WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, profile.historyId, ctx.now()]));
  ctx.counts.historyResets += 1;
  ctx.report({ kind: "outreach_history_reset", tenantId: box.tenantId, mailboxId: box.id, reason });
}

/** The mailbox's history cursor after a poll or a reset; null when nothing is stored yet. */
export async function pollInbound(ctx: Ctx, box: Box): Promise<void> {
  const cursor = (await ctx.deps.service((tx) => tx.query<{ history_id: string | null }>(
    "SELECT history_id FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id]))).rows[0]?.history_id ?? null;
  if (cursor === null) { await resetCursor(ctx, box, "no_cursor"); return; }

  const added: GmailHistoryMessage[] = [];
  let latest = cursor;
  try {
    let pageToken: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await ctx.call((signal) => ctx.gmail.listHistory(box.accessToken, { startHistoryId: cursor, ...(pageToken ? { pageToken } : {}) }, { signal }));
      added.push(...page.messages);
      latest = page.historyId;
      pages += 1;
      if (page.nextPageToken === null) break;
      // More history than one run reads: keep the cursor and try again next run.
      if (pages >= ctx.cfg.maxHistoryPages) return;
      pageToken = page.nextPageToken;
    }
  } catch (error) {
    if (errorCode(error) === "history_expired") { await resetCursor(ctx, box, "expired"); return; }
    throw error;
  }

  const inbound = await loadInboundContext(ctx, box);
  const seen = new Set<string>();
  let reads = 0;
  for (const entry of added) {
    if (seen.has(entry.id) || inbound.own.has(entry.id)) continue;
    seen.add(entry.id);
    // Mail the owner sent by hand outside any prospect's thread cannot be a reply.
    if (entry.labelIds.includes("SENT") && !inbound.context.prospectByThread.has(entry.threadId)) continue;
    if (reads >= ctx.cfg.maxInboundMessages) return; // leave the cursor; the rest is read next run
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
  await ctx.leased(box, (tx) => tx.query(
    "UPDATE outreach_mailboxes SET history_id=$3, history_checked_at=$4, updated_at=$4 WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, latest, ctx.now()]));
}
