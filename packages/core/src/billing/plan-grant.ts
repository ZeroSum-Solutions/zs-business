// Operator-granted plan (docs/requirements/plans.md PL-21..PL-24). Original code. Service role only:
// the owner-run script calls these inside one transaction. Nothing here touches a provider row, and
// the billing workers never name the grant columns, so a sync cannot clear or overwrite a grant.
import { hubPlanSchema, NotFound, ValidationFailed, type HubPlan } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { lockTenantPlan } from "./plan-gate.js";

export const PLAN_GRANT_NOTE_MAX = 200;
export const PLAN_GRANT_BY_MAX = 80;

/** What a grant row holds (PL-21). */
export interface PlanGrantState {
  readonly plan: HubPlan;
  /** Null: no end date. */
  readonly until: Date | null;
  readonly note: string;
  readonly grantedAt: Date;
  readonly grantedBy: string;
}

interface GrantRow { granted_plan: HubPlan | null; granted_until: Date | null; grant_note: string | null; granted_at: Date | null; granted_by: string | null }
const stateOf = (row: GrantRow | undefined): PlanGrantState | null =>
  row && row.granted_plan !== null
    ? { plan: row.granted_plan, until: row.granted_until, note: row.grant_note!, grantedAt: row.granted_at!, grantedBy: row.granted_by! }
    : null;

/** The tenant's grant as stored, ended or not; null when none. */
export async function readPlanGrant(tx: Transaction, tenantId: string): Promise<PlanGrantState | null> {
  return stateOf((await tx.query<GrantRow>(
    "SELECT granted_plan, granted_until, grant_note, granted_at, granted_by FROM tenant_plans WHERE tenant_id=$1", [tenantId])).rows[0]);
}

export interface PlanGrantChange { readonly before: PlanGrantState | null; readonly after: PlanGrantState | null }

async function requireTenant(tx: Transaction, tenantId: string): Promise<void> {
  if ((await tx.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [tenantId])).rowCount !== 1) throw new NotFound();
}

const text = (value: string, label: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new ValidationFailed(`${label} must be 1 to ${max} characters`);
  return trimmed;
};

/**
 * PL-21, PL-24: gives the tenant a plan that wins over its provider subscription (or replaces its
 * earlier grant). Under the tenant's plan lock; inserts the `tenant_plans` row when there is none.
 * `until` must lie after `now`.
 */
export async function setPlanGrant(tx: Transaction, input: {
  readonly tenantId: string; readonly plan: HubPlan; readonly until: Date | null;
  readonly note: string; readonly by: string; readonly now: Date;
}): Promise<PlanGrantChange> {
  const plan = hubPlanSchema.safeParse(input.plan);
  if (!plan.success) throw new ValidationFailed("The plan must be solo, studio or pro");
  const note = text(input.note, "The note", PLAN_GRANT_NOTE_MAX);
  const by = text(input.by, "The operator name", PLAN_GRANT_BY_MAX);
  if (input.until !== null && !(input.until.getTime() > input.now.getTime())) throw new ValidationFailed("The end of a grant must be in the future");
  await requireTenant(tx, input.tenantId);
  await lockTenantPlan(tx, input.tenantId);
  const before = await readPlanGrant(tx, input.tenantId);
  await tx.query(
    `INSERT INTO tenant_plans (tenant_id, granted_plan, granted_until, grant_note, granted_at, granted_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$5,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET granted_plan=EXCLUDED.granted_plan, granted_until=EXCLUDED.granted_until,
       grant_note=EXCLUDED.grant_note, granted_at=EXCLUDED.granted_at, granted_by=EXCLUDED.granted_by, updated_at=EXCLUDED.updated_at`,
    [input.tenantId, plan.data, input.until, note, input.now, by]);
  return { before, after: await readPlanGrant(tx, input.tenantId) };
}

/** PL-24: removes the tenant's grant, ended or not. Nothing to remove is no change. */
export async function clearPlanGrant(tx: Transaction, input: { readonly tenantId: string; readonly now: Date }): Promise<PlanGrantChange> {
  await requireTenant(tx, input.tenantId);
  await lockTenantPlan(tx, input.tenantId);
  const before = await readPlanGrant(tx, input.tenantId);
  if (before !== null)
    await tx.query(
      `UPDATE tenant_plans SET granted_plan=NULL, granted_until=NULL, grant_note=NULL, granted_at=NULL, granted_by=NULL, updated_at=$2
       WHERE tenant_id=$1`, [input.tenantId, input.now]);
  return { before, after: await readPlanGrant(tx, input.tenantId) };
}
