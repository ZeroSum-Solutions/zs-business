// The PL-8 plan gate and the plan lock. Original code. The dispatcher calls `planGate` inside
// every action's transaction; this module imports nothing from the action layer.
import {
  CANCEL_BOOKING_ACTION, CONFIRMATION_SEND_ACTION, Conflict, EMAIL_ALLOWANCE_WINDOW_DAYS, ENTITLED_PLAN_STATUSES, FREE_PLAN_LIMITS,
  FREE_SITE_PUBLISHES_PER_DAY, MESSAGE_SEND_REQUESTED, PLAN_CATALOG, PLAN_CHECKOUT_CREATE_ACTION, PLAN_SITE_PUBLISHES_PER_DAY,
  planModelCapMicros, REMINDER_QUEUE_ACTION, REVIEW_QUEUE_ACTION,
  type HubPlan, type PlanLimits, type PlanStatus,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** PL-4, PL-10: one tenant's plan decisions and plan events never interleave. */
export async function lockTenantPlan(tx: Transaction, tenantId: string): Promise<void> {
  // The key uses Postgres's own UUID spelling, so "ABC…" and "abc…" (one tenant) take one lock.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('plan:' || $1::uuid::text, 0))", [tenantId]);
}

/**
 * PL-27: the plan lock in shared mode. A model-call reservation takes it before its settings lock, so a plan change
 * (which takes the lock exclusively) cannot commit between the reservation's cap read and its insert. Reservations
 * do not wait on each other.
 */
export async function lockTenantPlanShared(tx: Transaction, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('plan:' || $1::uuid::text, 0))", [tenantId]);
}

/**
 * PL-27: one tenant's refusable email sends count and queue one at a time. A lock of its own, not the plan lock: a
 * plan event holds the plan lock across a Stripe read, and a send must not wait on the network. Taken after the plan
 * lock when an action holds both, never before it.
 */
export async function lockTenantEmails(tx: Transaction, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('plan-email:' || $1::uuid::text, 0))", [tenantId]);
}

/** PL-21: the grant columns of `tenant_plans`, as the gate and the reads select them. */
export interface PlanGrantColumns { readonly granted_plan: HubPlan | null; readonly granted_until: Date | null }
export const GRANT_COLUMNS = "granted_plan, granted_until";

/** PL-21: the granted plan while the grant is active (set, and no end or an end after the clock), else null. */
export function activeGrant(row: PlanGrantColumns | null | undefined, now: Date): HubPlan | null {
  if (!row || row.granted_plan === null) return null;
  return row.granted_until === null || row.granted_until.getTime() > now.getTime() ? row.granted_plan : null;
}

/** PL-1, PL-21, PL-27: the plan columns every reader of the limits and of read-only selects. */
export interface PlanStandingRow extends PlanGrantColumns {
  readonly plan: HubPlan | null;
  readonly status: PlanStatus;
  readonly extra_connections: number;
  readonly read_only_after: Date | null;
  readonly free_tier: boolean;
}
export const STANDING_COLUMNS = `plan, status, extra_connections, read_only_after, free_tier, ${GRANT_COLUMNS}`;

/** PL-27: where the limits in force come from. */
export type PlanSource = "grant" | "plan" | "free" | "comped";
export interface PlanStanding {
  readonly source: PlanSource;
  /** The plan whose catalog numbers apply (the granted or the provider plan); null for free and comped. */
  readonly plan: HubPlan | null;
  /** Null for a comped tenant: no limits. */
  readonly limits: PlanLimits | null;
  readonly readOnly: boolean;
}

/**
 * PL-8, PL-21, PL-25, PL-27: the first that applies. An active grant; then a tenant past `read_only_after`, which is
 * read-only on its provider plan's limits, unless it is a self-signed-up (`free_tier`) tenant, which drops to the free
 * allowances instead and is never read-only; then the provider plan; then the free marker; otherwise comped. A free
 * tenant holds its provider plan only while the subscription is entitled (trialing, active, past_due): an unpaid
 * `incomplete` first payment gives it nothing above the free allowances.
 */
export function planStanding(row: PlanStandingRow | null | undefined, now: Date): PlanStanding {
  const granted = activeGrant(row, now);
  if (granted) return { source: "grant", plan: granted, limits: { ...PLAN_CATALOG[granted].limits }, readOnly: false };
  if (!row) return { source: "comped", plan: null, limits: null, readOnly: false };
  const lapsed = row.read_only_after !== null && row.read_only_after.getTime() <= now.getTime();
  if (lapsed && row.free_tier) return { source: "free", plan: null, limits: { ...FREE_PLAN_LIMITS }, readOnly: false };
  if (row.plan !== null && (!row.free_tier || (ENTITLED_PLAN_STATUSES as readonly string[]).includes(row.status))) {
    const base = PLAN_CATALOG[row.plan].limits;
    return {
      source: "plan", plan: row.plan, readOnly: lapsed,
      limits: { ...base, managedConnections: base.managedConnections + row.extra_connections },
    };
  }
  if (row.free_tier) return { source: "free", plan: null, limits: { ...FREE_PLAN_LIMITS }, readOnly: false };
  return { source: "comped", plan: null, limits: null, readOnly: lapsed };
}

/** PL-1, PL-21, PL-27: the limits in force; null for a comped tenant. */
export const planLimits = (row: PlanStandingRow | null | undefined, now: Date): PlanLimits | null => planStanding(row, now).limits;

/** PL-8, PL-21, PL-27: read-only at or after `read_only_after`, never while a grant is active or for a free-tier tenant. */
export const isReadOnly = (row: PlanStandingRow | null | undefined, now: Date) => planStanding(row, now).readOnly;

/** PL-25: the action a publish dispatches; its daily limit is checked by the plan gate. */
export const SITE_PUBLISH_ACTION = "site.release.publish";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PL-25, PL-27: releases a tenant may record in 24 hours. The plan in force (a grant, a provider plan, the held plan
 * included); the free allowance (20); otherwise the tenant is comped and null means no limit.
 */
export function sitePublishLimit(row: PlanStandingRow | null | undefined, now: Date): number | null {
  const standing = planStanding(row, now);
  if (standing.plan) return PLAN_SITE_PUBLISHES_PER_DAY[standing.plan];
  return standing.source === "free" ? FREE_SITE_PUBLISHES_PER_DAY : null;
}

/** PL-27: the model-assisted agent kinds, which a plan without `modelAgents` never runs. */
export const MODEL_AGENT_KINDS: ReadonlySet<string> = new Set(["inquiry_followup"]);

/**
 * PL-27: the plan's daily model cap for one agent kind in micros, or null for a comped tenant (only the kind's own
 * cap). A model-assisted kind on a plan without `modelAgents` gets 0, so a run that was open before a downgrade or a
 * lapse reserves no further model call. A read-only tenant (PL-8) gets 0 for every kind: model calls that do not go
 * through an action (template suggestions) stop with the rest of its work.
 */
export async function planModelCap(tx: Transaction, tenantId: string, kind: string, now: Date): Promise<number | null> {
  const row = await readPlanRow(tx, tenantId);
  if (!row) return null;
  const standing = planStanding(row, now);
  if (standing.readOnly) return 0;
  const limits = standing.limits;
  if (!limits) return null;
  return !limits.modelAgents && MODEL_AGENT_KINDS.has(kind) ? 0 : planModelCapMicros(limits);
}

type PlanGateRow = PlanStandingRow;
const readPlanRow = async (tx: Transaction, tenantId: string): Promise<PlanGateRow | undefined> =>
  (await tx.query<PlanGateRow>(`SELECT ${STANDING_COLUMNS} FROM tenant_plans WHERE tenant_id=$1`, [tenantId])).rows[0];

/** PL-25: refuse one more publish when the tenant has used its releases of the last 24 hours. */
async function enforceSitePublishLimit(tx: Transaction, tenantId: string, row: PlanGateRow | undefined, now: Date): Promise<void> {
  const limit = sitePublishLimit(row, now);
  if (limit === null) return;
  const used = (await tx.query<{ used: number }>(
    "SELECT count(*)::int AS used FROM site_releases WHERE tenant_id=$1 AND created_at > $2::timestamptz",
    // The cutoff is 24 elapsed hours before the injected clock; SQL `interval '1 day'` would follow the session's time zone.
    [tenantId, new Date(now.getTime() - DAY_MS)])).rows[0]!.used;
  if (used >= limit)
    throw new Conflict("The plan's daily publish limit is reached; try again later or choose a bigger plan",
      { reason: "plan_limit", resource: "sitePublishesPerDay", limit, used });
}

/**
 * PL-25: the same check without the plan lock, for the publish path to run before it compiles and stores
 * anything (the gate checks again under the lock). Read in the caller's transaction.
 */
export async function assertSitePublishRoom(tx: Transaction, tenantId: string, now: Date): Promise<void> {
  const row = await readPlanRow(tx, tenantId);
  // PL-8 first, as the plan gate: a read-only tenant is told to fix billing, not to buy a bigger plan.
  if (row && isReadOnly(row, now)) throw readOnlyRefusal();
  await enforceSitePublishLimit(tx, tenantId, row, now);
}

const readOnlyRefusal = () =>
  new Conflict("The plan has ended or its payment failed; the business is read-only until billing is fixed", { reason: "plan_read_only" });

/** PL-8: what a read-only tenant may still run. */
export const READ_ONLY_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  PLAN_CHECKOUT_CREATE_ACTION, "wallet.topup.create", "suppression.record",
  "sms.status.record", "sms.reply.record", "voice.call.record", "voice.voicemail.record",
  "transcription.job.complete", "transcription.job.fail", "catalog.intake.result", "catalog.intake.fail",
  "media.variant.stage", "media.variant.fail",
  "agent.kill", "agent.kind.kill", "browser.kill", "agent.run.finish", "agent.run.stall", "agent.kind.run.finish", "agent.cost.warn",
  "member.remove", "connection.disconnect", "calendar.google.disconnect", "automation.token.revoke",
  "approval.reject", "approval.revoke", "inbox.reply.discard",
  // outreach-sequencer.md OS-9: an owner can always stop sending.
  "outreach.campaign.pause", "outreach.prospect.stop",
  // OS-3: the owner can always disconnect a mailbox (the token is cleared); connecting one is a paid action.
  "outreach.mailbox.disconnect",
  // booking-self-service.md BS-12: a customer can always cancel their own booking, even when the business is read-only.
  "booking.self_cancel",
  // inbound-email.md IE-32: mail is never lost while a plan lapses; the owner reads it and pays to reply.
  "inbound.email.receive",
]);

/** PL-8, PL-27: the counted limits, by the action that would add one more. */
const COUNTED: Readonly<Record<string, { resource: keyof PlanLimits; count: string }>> = {
  "member.invite": { resource: "seats", count: "SELECT count(*)::int AS used FROM tenant_members WHERE tenant_id=$1" },
  "connection.connect": {
    resource: "managedConnections",
    // PL-27: the native Shopify link is the hub's own store (connections.md C-21), not a managed connection.
    count: "SELECT count(*)::int AS used FROM connections WHERE tenant_id=$1 AND status <> 'disconnected' AND tier <> 'native'",
  },
  "automation.token.create": {
    resource: "automationTokens",
    count: "SELECT count(*)::int AS used FROM automation_tokens WHERE tenant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)",
  },
  // PL-27: applying an industry template adds the tenant's bookable resource (industry-templates.md IT-4).
  "tenant.template.apply": { resource: "bookableResources", count: "SELECT count(*)::int AS used FROM booking_resources WHERE tenant_id=$1" },
};

/** PL-27: true when the action would switch on or start a model-assisted agent. */
function startsModelAgent(actionType: string, payload: unknown): boolean {
  const fields = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  if (actionType === "agent.run.start" || actionType === "agent.followup.draft") return true; // the follow-up agent's run and its drafts (G-6)
  if (actionType === "agent.settings.update") return fields.enabled === true;
  if (actionType === "agent.resume") return true; // the follow-up agent's resume restarts its runs (G-3)
  if (actionType === "agent.kind.settings.update")
    return fields.enabled === true && typeof fields.agentKind === "string" && MODEL_AGENT_KINDS.has(fields.agentKind);
  if (actionType === "agent.kind.resume") return typeof fields.agentKind === "string" && MODEL_AGENT_KINDS.has(fields.agentKind);
  return false;
}

/**
 * PL-27: the actions that may queue a refusable email. They take the email lock before the handler, so the count
 * after the handler is the one that stays true until commit. Booking notices (the confirmation send, which also
 * carries a customer's cancel or move notice, and the owner's cancel) are counted but never refused, so they take no lock.
 */
const EMAIL_SENDING_ACTIONS: ReadonlySet<string> = new Set(["inbox.reply.send", REMINDER_QUEUE_ACTION, REVIEW_QUEUE_ACTION]);
const EMAIL_NOTICE_ACTIONS: ReadonlySet<string> = new Set([CONFIRMATION_SEND_ACTION, CANCEL_BOOKING_ACTION]);

/**
 * PL-8, PL-25, PL-27: the locks the gates decide under. The dispatcher takes them before it reads the clock, so a
 * wait on a lock cannot leave a gate deciding at an instant that has passed (a grant ending meanwhile). The plan lock
 * first, then the email lock: one order everywhere.
 */
export async function lockForGates(tx: Transaction, tenantId: string, actionType: string, payload?: unknown): Promise<void> {
  if (COUNTED[actionType] !== undefined || actionType === SITE_PUBLISH_ACTION) await lockTenantPlan(tx, tenantId);
  // A model-agent start reads `modelAgents` under the shared lock, so a plan change waits for it and it sees one that committed first.
  else if (startsModelAgent(actionType, payload)) await lockTenantPlanShared(tx, tenantId);
  if (EMAIL_SENDING_ACTIONS.has(actionType)) await lockTenantEmails(tx, tenantId);
}

const limitRefusal = (resource: keyof PlanLimits, limit: number, used: number) =>
  new Conflict("The plan's limit is reached; choose a bigger plan", { reason: "plan_limit", resource, limit, used });

/**
 * PL-8, PL-27: runs inside the action's own transaction, after a replay is answered and before the
 * handler. A comped tenant passes untouched; a read-only one runs only the allowed actions; a
 * counted action takes the tenant's plan lock before it reads the plan, so two requests cannot both take the last slot.
 */
export async function planGate(tx: Transaction, tenantId: string, actionType: string, now: Date, payload?: unknown): Promise<void> {
  const counted = COUNTED[actionType];
  const publishes = actionType === SITE_PUBLISH_ACTION;
  // Lock before reading, so a plan change that commits meanwhile is the one enforced. A publish takes the
  // same lock: its count spans the tenant's sites, which the per-site lock does not serialize (PL-25). An action
  // that may queue an email takes the email lock, for the count `emailAllowanceGate` makes after the handler (PL-27).
  await lockForGates(tx, tenantId, actionType, payload);
  const row = await readPlanRow(tx, tenantId);
  if (!row) return;
  const standing = planStanding(row, now);
  if (standing.readOnly && !READ_ONLY_ALLOWED_ACTIONS.has(actionType))
    throw readOnlyRefusal();
  if (publishes) await enforceSitePublishLimit(tx, tenantId, row, now);
  const limits = standing.limits;
  if (!limits) return;
  if (!limits.modelAgents && startsModelAgent(actionType, payload)) throw limitRefusal("modelAgents", 0, 0);
  if (!counted) return;
  const limit = limits[counted.resource] as number;
  const used = (await tx.query<{ used: number }>(counted.count, counted.count.includes("$2") ? [tenantId, now] : [tenantId])).rows[0]!.used;
  if (used >= limit) throw limitRefusal(counted.resource, limit, used);
}

/** PL-27: emails the tenant queued in the window before the clock: the send events of its actions, by channel. */
export async function emailsQueued(tx: Transaction, tenantId: string, now: Date): Promise<number> {
  return (await tx.query<{ used: number }>(
    `SELECT count(*)::int AS used FROM outbox
      WHERE tenant_id=$1 AND event_type=$2 AND created_at > $3::timestamptz AND payload->>'channel' = 'email'`,
    [tenantId, MESSAGE_SEND_REQUESTED, new Date(now.getTime() - EMAIL_ALLOWANCE_WINDOW_DAYS * DAY_MS)])).rows[0]!.used;
}

/**
 * PL-27: after the handler, before the action and its event are recorded. An action whose event queues an email is
 * refused with `plan_limit` (`emailsPerMonth`) when the tenant's emails in the window have reached the allowance,
 * so the handler's writes roll back with it. Booking notices are never refused. A comped tenant has no allowance.
 */
export async function emailAllowanceGate(
  tx: Transaction, tenantId: string, actionType: string, event: { readonly type: string; readonly payload: unknown } | undefined, now: Date,
): Promise<void> {
  if (!event || event.type !== MESSAGE_SEND_REQUESTED) return;
  const channel = typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>).channel : undefined;
  if (channel !== "email" || EMAIL_NOTICE_ACTIONS.has(actionType)) return;
  // Every production action that queues a refusable email is in EMAIL_SENDING_ACTIONS and took this lock before the
  // handler (`lockForGates`). An unlisted one (a test's own send action) takes it here; a new production sender must be
  // listed, because a lock taken after the handler's own locks could wait on a writer that waits on them.
  await lockTenantEmails(tx, tenantId);
  const limits = planLimits(await readPlanRow(tx, tenantId), now);
  if (!limits) return;
  const used = await emailsQueued(tx, tenantId, now);
  if (used >= limits.emailsPerMonth) throw limitRefusal("emailsPerMonth", limits.emailsPerMonth, used);
}
