// Sending (outreach-sequencer.md OS-12, OS-14, OS-15). Per mailbox the worker lists due prospects and, for each, runs the
// pre-send check inside one lease-checked transaction that also commits the `sending` row. Only then does it call
// `messages.send`, once, and settle the row. A follow-up first checks its Gmail thread outside the transaction.
import { OUTREACH_CAMPAIGN_ACTIVATE_ACTION, OUTREACH_CAMPAIGN_TARGET } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { pgCode } from "../crm/rows.js";
import { hardSuppressionHit } from "./hard-suppression.js";
import { INBOUND_HEADER_NAMES } from "./gmail-port.js";
import { buildRawMessage, MimeError } from "./mime.js";
import { localMoment, mayStartSend, nextLocalMidnight, warmupCap } from "./schedule.js";
import { addressProblem, appendFooter, buildFooter, renderStep, RENDER_MAX_BODY, RENDER_MAX_SUBJECT, type PostalAddress, type TemplateStep } from "./templates.js";
import { signUnsubscribeToken } from "../delivery/unsubscribe.js";
import { COUNTED_SEND_STATUSES } from "./reads.js";
import { applyInbound, checkBounceRate, classifyMessage, loadInboundContext } from "./worker-inbound.js";
import { markSent, type SendRow } from "./worker-settle.js";
import { codeText, errorCode, errorReason, errorStatus, needsReauthorization, pauseCampaign, stopProspect, LostLease, OutOfTime, type Box, type Ctx } from "./worker-kit.js";

interface Candidate {
  readonly id: string;
  readonly next_step: number;
}

interface ProspectFacts {
  readonly id: string;
  readonly campaign_id: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string | null;
  readonly company: string;
  readonly industry: string | null;
  readonly website: string | null;
  readonly status: string;
  readonly next_step: number | null;
  readonly due: string | null;
  readonly thread_id: string | null;
}

/** What a follow-up needs from the steps already sent. */
interface Earlier {
  /** Every earlier step's Message-ID in order, or fewer when some are unknown. */
  readonly references: readonly string[];
  /** The previous step's Message-ID, or null when it is not known yet. */
  readonly inReplyTo: string | null;
  /** The previous step's sent row, for reading its Message-ID. */
  readonly previous: { readonly gmail_message_id: string; readonly first_failed_at: Date | null } | null;
}

type Gate =
  /** `send` is set when the row was inserted. */
  | { readonly kind: "ready"; readonly prospect: ProspectFacts; readonly earlier: Earlier; readonly send: { readonly row: SendRow; readonly raw: string } | null }
  /** Not this candidate now; try the next. */
  | { readonly kind: "skip" }
  /** Nothing more from this mailbox this run. */
  | { readonly kind: "stop_mailbox" }
  /** The prospect was stopped or the campaign paused; try the next. */
  | { readonly kind: "changed" };

interface ProfileFacts {
  readonly display_name: string;
  readonly legal_name: string | null;
  readonly time_zone: string | null;
  readonly postal_address: PostalAddress | null;
}

const SUPPRESSED_STATUS = (reason: string): string =>
  reason === "unsubscribe" || reason === "marketing_unsubscribe" ? "unsubscribed" : reason === "bounce" ? "bounced" : "suppressed";

/** `lock` makes the read a decision point: a writer of the profile waits until the transaction ends (OS-14, OS-6). */
async function loadProfile(tx: Transaction, tenantId: string, lock = false): Promise<ProfileFacts | null> {
  return (await tx.query<ProfileFacts>(
    `SELECT display_name, legal_name, time_zone, postal_address FROM business_profiles WHERE tenant_id=$1${lock ? " FOR SHARE" : ""}`, [tenantId])).rows[0] ?? null;
}

/** The advisory-lock keys the suppression and CRM writers take for one address (suppression.ts, crm/contact.ts). */
const suppressionLockKey = (tenantId: string, address: string) => `suppression:${tenantId}:email:${address}`;
const contactLockKey = (tenantId: string, address: string) => `crm:contact:email:${tenantId}:${address}`;

/** Rendered text the database and Gmail accept: the check on `outreach_sends` allows 300 characters of subject, 20,000 of body. */
const MAX_BODY = 20_000;

function stopped(ctx: Ctx, box: Box, prospectId: string, status: string): Gate {
  ctx.counts.stopped += 1;
  ctx.report({ kind: "outreach_prospect_stopped", tenantId: box.tenantId, prospectId, status });
  return { kind: "changed" };
}

/**
 * OS-14 inside one transaction. With `insert` set it also builds the message and commits the `sending` row (OS-15);
 * without it the checks run and nothing is written except the stops they decide (a follow-up runs them once before and
 * once after its Gmail thread check).
 */
async function gate(ctx: Ctx, box: Box, tx: Transaction, candidate: Candidate, insert: { readonly sendId: string } | null): Promise<Gate> {
  const { tenantId } = box;
  const at = ctx.now();
  // 1. config, allowlist, lease (ctx.leased: the mailbox row is locked), mailbox
  if (!ctx.cfg.sendEnabled || !ctx.cfg.tenants.includes(tenantId)) return { kind: "stop_mailbox" };
  const mailbox = (await tx.query<{ status: string; paused_until: Date | null; daily_limit: number; history_id: string | null }>(
    "SELECT status, paused_until, daily_limit, history_id FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2", [tenantId, box.id])).rows[0];
  if (!mailbox || mailbox.status !== "active" || (mailbox.paused_until !== null && mailbox.paused_until.getTime() > at.getTime())) return { kind: "stop_mailbox" };
  const plan = (await tx.query<{ read_only_after: Date | null }>("SELECT read_only_after FROM tenant_plans WHERE tenant_id=$1 FOR SHARE", [tenantId])).rows[0];
  if (plan?.read_only_after != null && plan.read_only_after.getTime() <= at.getTime()) return { kind: "stop_mailbox" };

  // OS-14: this transaction is the decision point. Every state a send depends on is read under a lock that the competing
  // writer takes too, so a writer that committed first is seen and one that comes later waits for the `sending` row below.
  // Lock order: profile, campaign, advisory keys, prospect, approval (the writers never take them the other way round).
  const profile = await loadProfile(tx, tenantId, true);
  const peek = (await tx.query<{ campaign_id: string; email: string }>(
    "SELECT campaign_id, email FROM outreach_prospects WHERE tenant_id=$1 AND id=$2 AND mailbox_id=$3", [tenantId, candidate.id, box.id])).rows[0];
  if (!peek) return { kind: "skip" };
  const campaign = (await tx.query<{ status: string; window_start_min: number; window_end_min: number; daily_cap_per_mailbox: number; activation_approval_id: string | null }>(
    `SELECT status, window_start_min, window_end_min, daily_cap_per_mailbox, activation_approval_id
       FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, peek.campaign_id])).rows[0];
  if (!campaign || campaign.status !== "active") return { kind: "skip" };
  for (const key of [suppressionLockKey(tenantId, peek.email), contactLockKey(tenantId, peek.email)].sort())
    await tx.query("SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))", [key]);
  await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2 FOR SHARE", [tenantId, peek.email]);
  const prospect = (await tx.query<ProspectFacts>(
    `SELECT id, campaign_id, email, first_name, last_name, company, industry, website, status, next_step, thread_id,
            to_char(next_due_on,'YYYY-MM-DD') AS due
       FROM outreach_prospects WHERE tenant_id=$1 AND id=$2 AND mailbox_id=$3 FOR UPDATE`, [tenantId, candidate.id, box.id])).rows[0];
  if (!prospect || prospect.status !== "active" || prospect.next_step !== candidate.next_step || prospect.due === null) return { kind: "skip" };

  // 2. the campaign's approval: approved, and the activation of this very campaign (OS-8, OS-24)
  const approval = campaign.activation_approval_id === null ? undefined : (await tx.query<{ status: string; action_type: string; target_type: string; target_id: string }>(
    "SELECT status, action_type, target_type, target_id::text AS target_id FROM approvals WHERE tenant_id=$1 AND id=$2 FOR SHARE", [tenantId, campaign.activation_approval_id])).rows[0];
  if (!approval || approval.status !== "approved" || approval.action_type !== OUTREACH_CAMPAIGN_ACTIVATE_ACTION
    || approval.target_type !== OUTREACH_CAMPAIGN_TARGET || approval.target_id !== prospect.campaign_id) {
    const reason = approval?.status === "revoked" ? "approval_revoked" : "approval_invalid";
    if (await pauseCampaign(tx, tenantId, prospect.campaign_id, reason, at)) {
      ctx.counts.campaignsPaused += 1;
      ctx.report({ kind: "outreach_campaign_paused", tenantId, campaignId: prospect.campaign_id, reason });
    }
    return { kind: "changed" };
  }

  // 3. due, window, caps
  if (!profile || profile.time_zone === null) {
    // No time zone means no local date or window: the campaign waits for the owner, never on UTC (OS-12).
    if (await pauseCampaign(tx, tenantId, prospect.campaign_id, "time_zone_missing", at)) {
      ctx.counts.campaignsPaused += 1;
      ctx.report({ kind: "outreach_campaign_paused", tenantId, campaignId: prospect.campaign_id, reason: "time_zone_missing" });
    }
    return { kind: "changed" };
  }
  const zone = profile.time_zone;
  const today = localMoment(zone, at.getTime()).date;
  if (prospect.due > today) return { kind: "skip" };
  if (!mayStartSend({ timeZone: zone, nowMs: at.getTime(), windowStartMin: campaign.window_start_min, windowEndMin: campaign.window_end_min })) return { kind: "skip" };
  const counted = [...COUNTED_SEND_STATUSES];
  const facts = (await tx.query<{ first_day: string | null; today_total: number; today_campaign: number; last_attempt: Date | null }>(
    `SELECT to_char(min(local_send_date) FILTER (WHERE status = ANY($3::text[])),'YYYY-MM-DD') AS first_day,
            (count(*) FILTER (WHERE status = ANY($3::text[]) AND local_send_date=$4::date))::int AS today_total,
            (count(*) FILTER (WHERE status = ANY($3::text[]) AND local_send_date=$4::date AND campaign_id=$5))::int AS today_campaign,
            max(attempt_started_at) FILTER (WHERE status = ANY($3::text[])) AS last_attempt
       FROM outreach_sends WHERE tenant_id=$1 AND mailbox_id=$2`, [tenantId, box.id, counted, today, prospect.campaign_id])).rows[0]!;
  const limit = Math.min(mailbox.daily_limit, ctx.cfg.mailboxDailyLimit);
  // A time zone moved westward can put today before the first send's local date: warm-up day zero, not an error.
  const first = facts.first_day === null || facts.first_day > today ? today : facts.first_day;
  const cap = warmupCap(first, today, limit, ctx.cfg.warmup);
  if (facts.today_total >= cap) return { kind: "stop_mailbox" };
  if (facts.today_campaign >= Math.min(campaign.daily_cap_per_mailbox, cap)) return { kind: "skip" };
  if (facts.last_attempt !== null && at.getTime() - facts.last_attempt.getTime() < ctx.cfg.minGapMs) return { kind: "stop_mailbox" };

  // 4. the postal address
  const problem = addressProblem({ displayName: profile.display_name, legalName: profile.legal_name, postalAddress: profile.postal_address });
  if (problem) {
    if (await pauseCampaign(tx, tenantId, prospect.campaign_id, problem, at)) {
      ctx.counts.campaignsPaused += 1;
      ctx.report({ kind: "outreach_campaign_paused", tenantId, campaignId: prospect.campaign_id, reason: problem });
    }
    return { kind: "changed" };
  }
  const stop = async (status: string): Promise<Gate> => {
    await stopProspect(tx, tenantId, prospect.id, status, at);
    return stopped(ctx, box, prospect.id, status);
  };
  // 5. suppression list, 6. hard suppression, 7. CRM consent
  const suppression = (await tx.query<{ reason: string }>(
    "SELECT reason FROM suppressions WHERE tenant_id=$1 AND channel='email' AND address=$2", [tenantId, prospect.email])).rows[0];
  if (suppression) return stop(SUPPRESSED_STATUS(suppression.reason));
  if (hardSuppressionHit({ email: prospect.email, website: prospect.website, company: prospect.company,
    name: [prospect.first_name, prospect.last_name ?? ""].join(" ").trim() }) !== null) return stop("hard_suppressed");
  const denied = (await tx.query(
    `SELECT 1 FROM crm_contacts c JOIN crm_contact_consent k ON k.tenant_id=c.tenant_id AND k.contact_id=c.id
      WHERE c.tenant_id=$1 AND c.normalized_email=$2 AND k.channel='email' AND k.status='denied' LIMIT 1`, [tenantId, prospect.email])).rowCount! > 0;
  if (denied) return stop("consent_denied");
  // 8. rendering
  const steps = (await tx.query<TemplateStep & { step_number: number }>(
    "SELECT step_number, subject, body FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY step_number", [tenantId, prospect.campaign_id])).rows;
  const k = candidate.next_step;
  const rendered = renderStep(steps, k, { firstName: prospect.first_name, company: prospect.company, industry: prospect.industry });
  if (!rendered.ok) return stop("stopped");
  if (rendered.subject.length > RENDER_MAX_SUBJECT || rendered.body.length > RENDER_MAX_BODY) return stop("stopped");

  // Earlier steps' Message-IDs, for a follow-up.
  const earlierRows = k === 1 ? [] : (await tx.query<{ step_number: number; rfc_message_id: string | null; gmail_message_id: string; message_id_first_failed_at: Date | null }>(
    `SELECT step_number, rfc_message_id, gmail_message_id, message_id_first_failed_at FROM outreach_sends
      WHERE tenant_id=$1 AND prospect_id=$2 AND status='sent' AND step_number < $3 ORDER BY step_number`, [tenantId, prospect.id, k])).rows;
  const previous = earlierRows.find((row) => row.step_number === k - 1) ?? null;
  const earlier: Earlier = {
    references: earlierRows.flatMap((row) => (row.rfc_message_id ? [row.rfc_message_id] : [])),
    inReplyTo: previous?.rfc_message_id ?? null,
    previous: previous ? { gmail_message_id: previous.gmail_message_id, first_failed_at: previous.message_id_first_failed_at } : null,
  };
  if (insert === null) return { kind: "ready", prospect, earlier, send: null };
  if (k > 1 && (earlier.inReplyTo === null || prospect.thread_id === null)) return { kind: "skip" };

  // OS-15: the message, then the row, in this transaction.
  const base = ctx.cfg.unsubscribeBaseUrl.replace(/\/+$/, "");
  const unsubscribeUrl = `${base}/${signUnsubscribeToken(ctx.cfg.unsubscribeSecret, { tenantId, deliveryId: insert.sendId })}`;
  const body = appendFooter(rendered.body, buildFooter({ displayName: profile.display_name, legalName: profile.legal_name, postalAddress: profile.postal_address }, unsubscribeUrl));
  if (body.length > MAX_BODY) return stop("stopped");
  let raw: string;
  try {
    raw = buildRawMessage({
      fromName: box.displayName, fromAddress: box.email, to: prospect.email, subject: rendered.subject, body, date: at, sendId: insert.sendId, unsubscribeUrl,
      ...(k > 1 ? { inReplyTo: earlier.inReplyTo!, references: earlier.references } : {}),
    });
  } catch (error) {
    // A header value that cannot be written (a line break or NUL): this prospect never mails (OS-17).
    if (error instanceof MimeError) return stop("stopped");
    throw error;
  }
  await tx.query(
    `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,
        attempt_started_at,history_id_before,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'sending',$7,$8,$9,$10::date,$11,$12,$11,$11)`,
    [tenantId, insert.sendId, prospect.campaign_id, prospect.id, box.id, k, prospect.email, rendered.subject, body, today, at, mailbox.history_id]);
  return { kind: "ready", prospect, earlier, send: { raw, row: { id: insert.sendId, campaign_id: prospect.campaign_id, prospect_id: prospect.id, step_number: k, local_send_date: today } } };
}

/** OS-14, follow-ups: the Gmail thread is checked for a reply, an owner reply or a bounce. True when the prospect stopped. */
async function threadStopped(ctx: Ctx, box: Box, prospect: ProspectFacts): Promise<boolean> {
  if (prospect.thread_id === null) {
    await ctx.leased(box, (tx) => stopProspect(tx, box.tenantId, prospect.id, "thread_unavailable", ctx.now()));
    stopped(ctx, box, prospect.id, "thread_unavailable");
    return true;
  }
  const threadId = prospect.thread_id;
  const messages = await ctx.call((signal) => ctx.gmail.getThreadHeaders(box.accessToken, threadId, INBOUND_HEADER_NAMES, { signal }));
  if (messages === null) {
    await ctx.leased(box, (tx) => stopProspect(tx, box.tenantId, prospect.id, "thread_unavailable", ctx.now()));
    stopped(ctx, box, prospect.id, "thread_unavailable");
    return true;
  }
  const inbound = await loadInboundContext(ctx, box);
  const ref = inbound.byId.get(prospect.id);
  if (!ref) return false;
  for (const metadata of messages) {
    const message = { id: metadata.id, threadId: metadata.threadId, labelIds: metadata.labelIds, headers: metadata.headers };
    const classification = classifyMessage(message, inbound.context);
    if (classification.kind === "reply" || classification.kind === "owner_reply" || classification.kind === "bounce") {
      if (classification.prospectId !== prospect.id) continue;
      await applyInbound(ctx, box, message, classification, ref);
      // applyInbound counts the stop under its own event; a repeat of the event still leaves the prospect stopped.
      await ctx.leased(box, (tx) => stopProspect(tx, box.tenantId, prospect.id,
        classification.kind === "reply" ? "replied" : classification.kind === "owner_reply" ? "owner_replied" : "bounced", ctx.now()));
      return true;
    }
  }
  return false;
}

/** A follow-up needs the previous step's Message-ID: read it when missing; null when it still cannot be had. */
async function acquireMessageId(ctx: Ctx, box: Box, prospect: ProspectFacts, earlier: Earlier): Promise<"ok" | "wait" | "stopped"> {
  if (earlier.inReplyTo !== null) return "ok";
  const previous = earlier.previous;
  if (previous === null) return "wait";
  try {
    const metadata = await ctx.call((signal) => ctx.gmail.getMessageHeaders(box.accessToken, previous.gmail_message_id, ["Message-ID"], { signal }));
    const id = metadata?.headers["message-id"];
    if (id) {
      await ctx.leased(box, (tx) => tx.query(
        "UPDATE outreach_sends SET rfc_message_id=$4, updated_at=$5 WHERE tenant_id=$1 AND prospect_id=$2 AND step_number=$3 AND status='sent' AND rfc_message_id IS NULL",
        [box.tenantId, prospect.id, prospect.next_step! - 1, id, ctx.now()]));
      return "ok";
    }
  } catch (error) {
    if (error instanceof LostLease || needsReauthorization(error)) throw error;
    if (error instanceof OutOfTime) return "wait";
    // Any other failure counts as a failed lookup below.
  }
  // The 24 hours count from the first lookup that failed, kept on the sent row so every run reads the same clock (OS-14).
  const at = ctx.now();
  const firstFailed = previous.first_failed_at ?? at;
  if (previous.first_failed_at === null) {
    await ctx.leased(box, (tx) => tx.query(
      `UPDATE outreach_sends SET message_id_first_failed_at=$4, updated_at=$4
        WHERE tenant_id=$1 AND prospect_id=$2 AND step_number=$3 AND status='sent' AND message_id_first_failed_at IS NULL`,
      [box.tenantId, prospect.id, prospect.next_step! - 1, at]));
  }
  if (at.getTime() - firstFailed.getTime() >= ctx.cfg.messageIdWaitMs) {
    await ctx.leased(box, (tx) => stopProspect(tx, box.tenantId, prospect.id, "thread_unavailable", ctx.now()));
    stopped(ctx, box, prospect.id, "thread_unavailable");
    return "stopped";
  }
  return "wait";
}

/** OS-15: records the outcome of one `messages.send`. Returns true when the mailbox should send no more this run. */
async function settleFailure(ctx: Ctx, box: Box, row: SendRow, prospectId: string, error: unknown): Promise<boolean> {
  const status = errorStatus(error);
  const reason = errorReason(error);
  const code = codeText(errorCode(error));
  const at = ctx.now();
  const close = (tx: Transaction, to: "rejected" | "not_sent" | "uncertain") => tx.query(
    "UPDATE outreach_sends SET status=$3, error_code=$4, settled_at=$5, updated_at=$6 WHERE tenant_id=$1 AND id=$2 AND status IN ('sending','uncertain')",
    [box.tenantId, row.id, to, code, to === "uncertain" ? null : at, at]);
  const pauseMailbox = (tx: Transaction, until: Date, why: string) => tx.query(
    "UPDATE outreach_mailboxes SET paused_until=$3, pause_reason=$4, updated_at=$5 WHERE tenant_id=$1 AND id=$2", [box.tenantId, box.id, until, why, at]);

  if (status === 400) {
    await ctx.leased(box, async (tx) => { await close(tx, "rejected"); await stopProspect(tx, box.tenantId, prospectId, "invalid_address", at); });
    ctx.counts.rejected += 1;
    return false;
  }
  if (status === 429 || (status === 403 && (reason === "ratelimitexceeded" || reason === "userratelimitexceeded"))) {
    await ctx.leased(box, async (tx) => { await close(tx, "not_sent"); await pauseMailbox(tx, new Date(at.getTime() + 15 * 60_000), "gmail_rate_limit"); });
    ctx.counts.notSent += 1;
    return true;
  }
  if (status === 403 && reason === "dailylimitexceeded") {
    // Gmail's day ends at the owner's local midnight; with no time zone on file, a full day is the safe guess.
    const zone = (await ctx.deps.service((tx) => loadProfile(tx, box.tenantId)))?.time_zone ?? null;
    const until = zone === null ? new Date(at.getTime() + 24 * 3_600_000) : new Date(nextLocalMidnight(zone, at.getTime()));
    await ctx.leased(box, async (tx) => { await close(tx, "not_sent"); await pauseMailbox(tx, until, "gmail_daily_limit"); });
    ctx.counts.notSent += 1;
    ctx.report({ kind: "outreach_gmail_daily_limit", tenantId: box.tenantId, mailboxId: box.id });
    return true;
  }
  if (status === 401 || (status === 403 && reason === "insufficientpermissions")) {
    await ctx.leased(box, async (tx) => {
      await close(tx, "not_sent");
      await tx.query("UPDATE outreach_mailboxes SET status='reauthorize', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'", [box.tenantId, box.id, at]);
    });
    ctx.counts.notSent += 1;
    ctx.counts.reauthorized += 1;
    ctx.report({ kind: "outreach_mailbox_reauthorize", tenantId: box.tenantId, mailboxId: box.id, code });
    return true;
  }
  await ctx.leased(box, (tx) => close(tx, "uncertain"));
  ctx.counts.uncertain += 1;
  return true;
}

/**
 * The decision transaction of OS-14/OS-15. A unique violation on the open-attempt index means another attempt of this
 * prospect and step is already open (sending or uncertain): not this run's to retry, and not a reason to end the mailbox.
 */
async function commit(ctx: Ctx, box: Box, candidate: Candidate): Promise<Gate> {
  try {
    return await ctx.leased(box, (tx) => gate(ctx, box, tx, candidate, { sendId: ctx.deps.generateId() }));
  } catch (error) {
    if (pgCode(error) === "23505") return { kind: "skip" };
    throw error;
  }
}

/** One candidate: OS-14 check, the `sending` row, the call, the settlement. */
async function attempt(ctx: Ctx, box: Box, candidate: Candidate): Promise<"attempted" | "skip" | "stop_mailbox"> {
  if (ctx.timeLeft() < ctx.cfg.requestTimeoutMs) return "stop_mailbox";
  let chosen: Gate;
  if (candidate.next_step === 1) {
    chosen = await commit(ctx, box, candidate);
  } else {
    const first = await ctx.leased(box, (tx) => gate(ctx, box, tx, candidate, null));
    if (first.kind !== "ready") return first.kind === "stop_mailbox" ? "stop_mailbox" : "skip";
    if (await threadStopped(ctx, box, first.prospect)) return "skip";
    const message = await acquireMessageId(ctx, box, first.prospect, first.earlier);
    if (message !== "ok") return "skip";
    if (ctx.timeLeft() < ctx.cfg.requestTimeoutMs) return "stop_mailbox";
    chosen = await commit(ctx, box, candidate);
  }
  if (chosen.kind !== "ready" || chosen.send === null) return chosen.kind === "stop_mailbox" ? "stop_mailbox" : "skip";
  const { row, raw } = chosen.send;
  const threadId = chosen.prospect.thread_id;
  let result: Awaited<ReturnType<Ctx["gmail"]["send"]>>;
  try {
    result = await ctx.call((signal) => ctx.gmail.send(box.accessToken, { raw, ...(candidate.next_step > 1 && threadId ? { threadId } : {}) }, { signal }), ctx.cfg.requestTimeoutMs);
  } catch (error) {
    if (error instanceof LostLease) throw error;
    if (error instanceof OutOfTime) {
      // `call` throws it before it invokes anything: Gmail was never asked, so the reservation is released (OS-15).
      await ctx.leased(box, (tx) => tx.query(
        "UPDATE outreach_sends SET status='not_sent', error_code='out_of_time', settled_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='sending'",
        [box.tenantId, row.id, ctx.now()]));
      ctx.counts.notSent += 1;
      return "stop_mailbox";
    }
    ctx.counts.sends += 1;
    return (await settleFailure(ctx, box, row, chosen.prospect.id, error)) ? "stop_mailbox" : "attempted";
  }
  ctx.counts.sends += 1;
  await ctx.leased(box, (tx) => markSent(tx, ctx, box, row, { messageId: result.id, threadId: result.threadId, rfcMessageId: null }));
  ctx.counts.accepted += 1;
  // OS-20: the 40th send can be the one that tips a campaign over the bounce rate.
  await checkBounceRate(ctx, box, row.campaign_id);
  // Best effort: the Message-ID the next step's headers need.
  try {
    const metadata = await ctx.call((signal) => ctx.gmail.getMessageHeaders(box.accessToken, result.id, ["Message-ID"], { signal }));
    const id = metadata?.headers["message-id"];
    if (id) await ctx.leased(box, (tx) => tx.query(
      "UPDATE outreach_sends SET rfc_message_id=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND rfc_message_id IS NULL", [box.tenantId, row.id, id, ctx.now()]));
  } catch (error) {
    if (error instanceof LostLease) throw error;
  }
  return "attempted";
}

/**
 * OS-12, OS-14: up to `sendsPerTick` sends from one leased mailbox, in the order of OS-11. Candidates are taken per campaign
 * and interleaved, so one campaign that cannot send now (window, cap, a wait for a Message-ID) never hides the others.
 */
export async function sendFromMailbox(ctx: Ctx, box: Box): Promise<void> {
  if (!ctx.cfg.sendEnabled || !ctx.cfg.tenants.includes(box.tenantId)) return;
  const zone = (await ctx.deps.service((tx) => loadProfile(tx, box.tenantId)))?.time_zone;
  if (!zone) {
    // OS-12: no time zone, no local date: the mailbox's active campaigns pause for the owner.
    const campaigns = await ctx.leased(box, async (tx) => {
      const rows = (await tx.query<{ campaign_id: string }>(
        `SELECT DISTINCT cm.campaign_id FROM outreach_campaign_mailboxes cm JOIN outreach_campaigns c ON c.tenant_id=cm.tenant_id AND c.id=cm.campaign_id
          WHERE cm.tenant_id=$1 AND cm.mailbox_id=$2 AND c.status='active'`, [box.tenantId, box.id])).rows;
      const paused: string[] = [];
      for (const { campaign_id } of rows) if (await pauseCampaign(tx, box.tenantId, campaign_id, "time_zone_missing", ctx.now())) paused.push(campaign_id);
      return paused;
    });
    for (const campaignId of campaigns) {
      ctx.counts.campaignsPaused += 1;
      ctx.report({ kind: "outreach_campaign_paused", tenantId: box.tenantId, campaignId, reason: "time_zone_missing" });
    }
    return;
  }
  const today = localMoment(zone, ctx.now().getTime()).date;
  const candidates = (await ctx.deps.service((tx) => tx.query<Candidate>(
    `SELECT id, next_step FROM (
       SELECT p.id, p.next_step, p.next_due_on,
              row_number() OVER (PARTITION BY p.campaign_id ORDER BY (p.next_step > 1) DESC, p.next_due_on, p.id) AS rank
         FROM outreach_prospects p
         JOIN outreach_campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id
        WHERE p.tenant_id=$1 AND p.mailbox_id=$2 AND p.status='active' AND c.status='active' AND p.next_due_on <= $3::date
          AND NOT EXISTS (SELECT 1 FROM outreach_sends s WHERE s.tenant_id=p.tenant_id AND s.prospect_id=p.id AND s.step_number=p.next_step
                            AND s.status IN ('sending','sent','uncertain','lost'))) ranked
      WHERE rank <= 25 ORDER BY rank, (next_step > 1) DESC, next_due_on, id LIMIT 60`, [box.tenantId, box.id, today]))).rows;
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= ctx.cfg.sendsPerTick) return;
    const outcome = await attempt(ctx, box, candidate);
    if (outcome === "stop_mailbox") return;
    if (outcome === "attempted") attempts += 1;
  }
}
