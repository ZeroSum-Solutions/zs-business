// Host names, attached and detached by the service role only: a host belongs to one site in
// the whole system, so it is attached after the Mac has verified the domain (DNS, and Cloudflare
// Custom Hostnames for a tenant's own domain). Runtime sessions can only read hosts.
//
// Every attach and detach takes the next `site_host_assignment_seq` number. Edge pointers carry
// it, and a pointer never replaces one with a higher number (sync.ts), so the order in which
// the database gave a host out is the order the edge honours, however late a sync runs.
import { Conflict, NotFound, siteHostSchema } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { validationError } from "../edge/errors.js";

export function parseHost(value: string): string {
  const parsed = siteHostSchema.safeParse(value);
  if (!parsed.success) throw validationError("Invalid host", parsed.error.issues);
  return parsed.data;
}

export interface SiteHostInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly host: string;
}

/**
 * Attach and detach of one host run one at a time, before any number is drawn. The lock works
 * when no row exists yet, so an attach that waits on another transaction's attach and detach
 * takes its number (the INSERT's default) after that detach committed, and so above it.
 */
async function lockHost(tx: Transaction, host: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('site-host:' || $1, 0))", [host]);
}

/** Attach a host in a service-role transaction. Refuses a host that another site holds. */
export async function attachSiteHost(tx: Transaction, input: SiteHostInput, now: Date): Promise<string> {
  const host = parseHost(input.host);
  await lockHost(tx, host);
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

/** What a detach hands to `retractHostPointer` once its transaction commits. */
export interface DetachedHost {
  /** The normalized host name. */
  readonly host: string;
  /** The detach's own number, above the assignment it ended. */
  readonly assignment: number;
}

/**
 * Detach a host in a service-role transaction. Answers null when the site did not hold it.
 * After commit, pass the answer to `retractHostPointer` so the edge stops serving the host.
 */
export async function detachSiteHost(tx: Transaction, input: SiteHostInput): Promise<DetachedHost | null> {
  const host = parseHost(input.host);
  await lockHost(tx, host);
  // Then number the detach and delete: an attach waiting on the host lock takes its number
  // after the commit, so it is always above the detach's.
  const held = await tx.query(
    "SELECT 1 FROM site_hosts WHERE tenant_id=$1 AND site_id=$2 AND host=$3 FOR UPDATE", [input.tenantId, input.siteId, host],
  );
  if (held.rowCount !== 1) return null;
  const numbered = await tx.query<{ assignment: string }>("SELECT nextval('public.site_host_assignment_seq') AS assignment");
  await tx.query("DELETE FROM site_hosts WHERE tenant_id=$1 AND site_id=$2 AND host=$3", [input.tenantId, input.siteId, host]);
  return { host, assignment: Number(numbered.rows[0]!.assignment) };
}
