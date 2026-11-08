/** Definers run as the narrowest role that can do their one job; other functions as zs_function_owner. */
export function expectedOwner(row: { fn: string; definer: boolean }): string {
  if (!row.definer) return "zs_function_owner";
  return row.fn.startsWith("rate_limit_take(") || row.fn.startsWith("rate_limit_refund(") || row.fn.startsWith("connections_org_budget(") ? "zs_rate_limiter" : "zs_dispatcher";
}
