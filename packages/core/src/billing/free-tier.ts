// PL-27: the self-sign-up marker. Original code. Service role only: the runtime role never writes `free_tier` (PL-25).
import { ValidationFailed } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { lockTenantPlan } from "./plan-gate.js";

/**
 * PL-27: marks a tenant that a person created for themselves (public sign-up) as free, so the free allowances hold
 * until a grant or a paid plan applies. Inserts the plan record when the tenant has none; changes no other column, so a
 * provider subscription or a grant stored before stays as it was. Idempotent. Operator-created tenants never call it
 * and stay comped.
 */
export async function markSelfSignup(tx: Transaction, input: { readonly tenantId: string; readonly now: Date }): Promise<void> {
  if (!Number.isFinite(input.now.getTime())) throw new ValidationFailed("Invalid time");
  await lockTenantPlan(tx, input.tenantId);
  await tx.query(
    `INSERT INTO tenant_plans (tenant_id, free_tier, created_at, updated_at) VALUES ($1, true, $2, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET free_tier=true, updated_at=EXCLUDED.updated_at WHERE NOT tenant_plans.free_tier`,
    [input.tenantId, input.now]);
}
