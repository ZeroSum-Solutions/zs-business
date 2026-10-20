// Host names, attached and detached by the service role only: a host belongs to one site in
// the whole system, so it is attached after the Mac has verified the domain (DNS, and Cloudflare
// Custom Hostnames for a tenant's own domain). Runtime sessions can only read hosts.
import { Conflict, NotFound, siteHostSchema } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { validationError } from "../edge/errors.js";

function parseHost(value: string): string {
  const parsed = siteHostSchema.safeParse(value);
  if (!parsed.success) throw validationError("Invalid host", parsed.error.issues);
  return parsed.data;
}

export interface SiteHostInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly host: string;
}

/** Attach a host in a service-role transaction. Refuses a host that another site holds. */
export async function attachSiteHost(tx: Transaction, input: SiteHostInput, now: Date): Promise<string> {
  const host = parseHost(input.host);
  const site = await tx.query("SELECT 1 FROM sites WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.siteId]);
  if (site.rowCount !== 1) throw new NotFound("Site not found");
  const holder = (await tx.query<{ tenant_id: string; site_id: string }>(
    "SELECT tenant_id, site_id FROM site_hosts WHERE host=$1 FOR UPDATE", [host],
  )).rows[0];
  if (holder) {
    if (holder.tenant_id === input.tenantId && holder.site_id === input.siteId) return host;
    throw new Conflict("Host is attached to another site", { reason: "host_in_use" });
  }
  // Two attaches of one new host race on its unique key; the loser hears the same conflict.
  await tx.query(
    "INSERT INTO site_hosts (tenant_id, host, site_id, created_at) VALUES ($1,$2,$3,$4)",
    [input.tenantId, host, input.siteId, now],
  ).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
      throw new Conflict("Host is attached to another site", { reason: "host_in_use" });
    throw error;
  });
  return host;
}

/** Detach a host in a service-role transaction. Answers whether a row was removed. */
export async function detachSiteHost(tx: Transaction, input: SiteHostInput): Promise<boolean> {
  const host = parseHost(input.host);
  const removed = await tx.query(
    "DELETE FROM site_hosts WHERE tenant_id=$1 AND site_id=$2 AND host=$3", [input.tenantId, input.siteId, host],
  );
  return removed.rowCount === 1;
}
