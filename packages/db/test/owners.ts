/** Definers run as the narrowest role that can do their one job; other functions as zs_function_owner. */
export function expectedOwner(row: { fn: string; definer: boolean }): string {
  if (!row.definer) return "zs_function_owner";
  return row.fn.startsWith("auth_session_is_live(") ? "zs_session_reader" : "zs_dispatcher";
}
