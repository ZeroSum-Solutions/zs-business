// The PL-8 plan gate and the plan lock. Original code. The dispatcher calls `planGate` inside
// every action's transaction; this module imports nothing from the action layer.
import { Conflict, PLAN_CATALOG, PLAN_CHECKOUT_CREATE_ACTION, type HubPlan, type PlanLimits } from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** PL-4, PL-10: one tenant's plan decisions and plan events never interleave. */
export async function lockTenantPlan(tx: Transaction, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`plan:${tenantId}`]);
}

/** PL-1: the limits in force; null for a comped tenant. */
export function planLimits(row: { readonly plan: HubPlan | null; readonly extra_connections: number } | null): PlanLimits | null {
  if (!row || row.plan === null) return null;
  const base = PLAN_CATALOG[row.plan].limits;
  return { ...base, managedConnections: base.managedConnections + row.extra_connections };
}

export const isReadOnly = (row: { readonly read_only_after: Date | null } | null, now: Date) =>
  row?.read_only_after != null && row.read_only_after.getTime() <= now.getTime();

/** PL-8: what a read-only tenant may still run. */
export const READ_ONLY_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  PLAN_CHECKOUT_CREATE_ACTION, "wallet.topup.create", "suppression.record",
  "sms.status.record", "sms.reply.record", "voice.call.record", "voice.voicemail.record",
  "transcription.job.complete", "transcription.job.fail", "catalog.intake.result", "catalog.intake.fail",
  "media.variant.stage", "media.variant.fail",
  "agent.kill", "agent.kind.kill", "browser.kill", "agent.run.finish", "agent.run.stall", "agent.kind.run.finish", "agent.cost.warn",
  "member.remove", "connection.disconnect", "calendar.google.disconnect", "automation.token.revoke",
  "approval.reject", "approval.revoke", "inbox.reply.discard",
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
  const row = (await tx.query<{ plan: HubPlan | null; status: string; extra_connections: number; read_only_after: Date | null }>(
    "SELECT plan, status, extra_connections, read_only_after FROM tenant_plans WHERE tenant_id=$1", [tenantId])).rows[0];
  if (!row) return;
  if (isReadOnly(row, now) && !READ_ONLY_ALLOWED_ACTIONS.has(actionType))
    throw new Conflict("The plan has ended or its payment failed; the business is read-only until billing is fixed", { reason: "plan_read_only" });
  const limits = planLimits(row);
  if (!counted || !limits) return;
  const limit = limits[counted.resource] as number;
  const used = (await tx.query<{ used: number }>(counted.count, counted.count.includes("$2") ? [tenantId, now] : [tenantId])).rows[0]!.used;
  if (used >= limit)
    throw new Conflict("The plan's limit is reached; choose a bigger plan", { reason: "plan_limit", resource: counted.resource, limit, used });
}

