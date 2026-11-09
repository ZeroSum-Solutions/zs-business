// The injected outreach setting every action and read checks (outreach-sequencer.md OS-1): the tenants that may use outreach.
// It travels as dispatch config, never in a stored payload.
import { z } from "zod";
import { uuidSchema } from "@zs/contracts";

export const outreachAccessSchema = z.strictObject({ tenants: z.array(uuidSchema).max(100) });
export type OutreachAccessInput = { readonly tenants: readonly string[] };

/** Whether `tenantId` is in the allowlist. Tenant ids compare case-insensitively. */
export function outreachAllowed(access: OutreachAccessInput | undefined, tenantId: string): boolean {
  if (access === undefined) return false;
  const parsed = outreachAccessSchema.safeParse(access);
  return parsed.success && parsed.data.tenants.some((id) => id.toLowerCase() === tenantId.toLowerCase());
}

/** The comma-separated `OUTREACH_TENANTS` value as a list; an invalid entry is an error, not a silent skip. */
export function parseOutreachTenants(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) => {
    const id = uuidSchema.safeParse(entry.trim());
    if (!id.success) throw new Error("OUTREACH_TENANTS must hold comma-separated tenant UUIDs");
    return id.data.toLowerCase();
  });
}
