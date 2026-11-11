// The PL-8 plan gate and the plan lock. Original code. The dispatcher calls `planGate` inside
// every action's transaction; this module imports nothing from the action layer.
import { Conflict, PLAN_CATALOG, PLAN_CHECKOUT_CREATE_ACTION, type HubPlan, type PlanLimits } from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** PL-4, PL-10: one tenant's plan decisions and plan events never interleave. */
export async function lockTenantPlan(tx: Transaction, tenantId: string): Promise<void> {
  // The key uses Postgres's own UUID spelling, so "ABC…" and "abc…" (one tenant) take one lock.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('plan:' || $1::uuid::text, 0))", [tenantId]);
}

/** PL-21: the grant columns of `tenant_plans`, as the gate and the reads select them. */
export interface PlanGrantColumns { readonly granted_plan: HubPlan | null; readonly granted_until: Date | null }
export const GRANT_COLUMNS = "granted_plan, granted_until";

/** PL-21: the granted plan while the grant is active (set, and no end or an end after the clock), else null. */
export function activeGrant(row: PlanGrantColumns | null | undefined, now: Date): HubPlan | null {
  if (!row || row.granted_plan === null) return null;
  return row.granted_until === null || row.granted_until.getTime() > now.getTime() ? row.granted_plan : null;
}

/** PL-1, PL-21: the limits in force; null for a comped tenant. An active grant wins over the subscription. */
export function planLimits(
  row: ({ readonly plan: HubPlan | null; readonly extra_connections: number } & PlanGrantColumns) | null, now: Date,
): PlanLimits | null {
  const granted = activeGrant(row, now);
  if (granted) return { ...PLAN_CATALOG[granted].limits };
  if (!row || row.plan === null) return null;
  const base = PLAN_CATALOG[row.plan].limits;
  return { ...base, managedConnections: base.managedConnections + row.extra_connections };
}

/** PL-8, PL-21: read-only at or after `read_only_after`, never while a grant is active. */
export const isReadOnly = (row: ({ readonly read_only_after: Date | null } & PlanGrantColumns) | null, now: Date) =>
  row?.read_only_after != null && row.read_only_after.getTime() <= now.getTime() && activeGrant(row, now) === null;

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
]);

/** PL-8: the counted limits, by the action that would add one more. */
const COUNTED: Readonly<Record<string, { resource: keyof PlanLimits; count: string }>> = {
  "member.invite": { resource: "seats", count: "SELECT count(*)::int AS used FROM tenant_members WHERE tenant_id=$1" },
  "connection.connect": {
    resource: "managedConnections",
    count: "SELECT count(*)::int AS used FROM connections WHERE tenant_id=$1 AND status <> 'disconnected'",
  },
  "automation.token.create": {
    resource: "automationTokens",
    count: "SELECT count(*)::int AS used FROM automation_tokens WHERE tenant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)",
  },
};

/**
 * PL-8: runs inside the action's own transaction, after a replay is answered and before the
 * handler. A comped tenant passes untouched; a read-only one runs only the allowed actions; a
 * counted action takes the tenant's plan lock before it reads the plan, so two requests cannot both take the last slot.
 */
export async function planGate(tx: Transaction, tenantId: string, actionType: string, now: Date): Promise<void> {
  const counted = COUNTED[actionType];
  // Lock before reading, so a plan change that commits meanwhile is the one enforced.
  if (counted) await lockTenantPlan(tx, tenantId);
  const row = (await tx.query<{ plan: HubPlan | null; status: string; extra_connections: number; read_only_after: Date | null } & PlanGrantColumns>(
    `SELECT plan, status, extra_connections, read_only_after, ${GRANT_COLUMNS} FROM tenant_plans WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (!row) return;
  if (isReadOnly(row, now) && !READ_ONLY_ALLOWED_ACTIONS.has(actionType))
    throw new Conflict("The plan has ended or its payment failed; the business is read-only until billing is fixed", { reason: "plan_read_only" });
  const limits = planLimits(row, now);
  if (!counted || !limits) return;
  const limit = limits[counted.resource] as number;
  const used = (await tx.query<{ used: number }>(counted.count, counted.count.includes("$2") ? [tenantId, now] : [tenantId])).rows[0]!.used;
  if (used >= limit)
    throw new Conflict("The plan's limit is reached; choose a bigger plan", { reason: "plan_limit", resource: counted.resource, limit, used });
}

