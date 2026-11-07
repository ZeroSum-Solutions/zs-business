// Hub access (hub-access.md H-3, H-8): what a token with a read scope may read, and the hourly
// record of what it did. A member's reads check a membership on every call and keep doing so
// (edge/session.ts); a token's reads go through this adapter to the same lower-level read
// functions, under the token's own checks. Original code.
import {
  listBookingsQuerySchema,
  listContactsQuerySchema,
  listDealsQuerySchema,
  listThreadsQuerySchema,
  resultsQuerySchema,
  TenantDenied,
  threadIdSchema,
  uuidSchema,
  type AutomationUsage,
  type ReadScope,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { getBusinessProfile } from "../business/index.js";
import { Unauthenticated } from "../edge/errors.js";
import { parseInput, type EdgeDependencies } from "../edge/session.js";
import { listBookings, listResources } from "../reads/booking.js";
import { getContact, listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { homeResults } from "../reads/home.js";
import { getThread, listThreads } from "../reads/inbox.js";
import type { AutomationPrincipal } from "./inbound.js";
import { loadToken, tokenActive } from "./records.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** H-8: rows older than this are pruned; owners read the last 7 days. */
export const USAGE_RETENTION_DAYS = 30;
export const USAGE_READ_DAYS = 7;
const INVALID_TOKEN = "Invalid or missing automation token";

const hourOf = (instant: Date) => new Date(Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS);

/**
 * H-3: a token read. One tenant transaction under the runtime role: take a shared lock on the
 * token row, read the clock after the lock, re-check revoked and expired, check the scope, then
 * read. A revoke takes the conflicting lock (revokeTokenHandler), so it commits only after
 * reads holding the shared lock end, and a read that starts after it commits is refused. A
 * missing scope is refused before any business row is read.
 */
export function createTokenReads(deps: EdgeDependencies) {
  const guarded = <T>(principal: AutomationPrincipal, scope: ReadScope, work: (tx: Transaction, now: Date) => Promise<T>): Promise<T> =>
    deps.db.tenant(principal.tenantId, async (tx) => {
      const row = await loadToken(tx, principal.tenantId, principal.tokenId, "share");
      // Read the clock once the lock is held, so a wait on a revoke counts toward expiry.
      const now = new Date(readClock(deps.clock));
      if (!row || !tokenActive(row, now)) throw new Unauthenticated(INVALID_TOKEN);
      if (!row.scopes.includes(scope)) throw new TenantDenied();
      return work(tx, now);
    });
  const tenant = (principal: AutomationPrincipal) => principal.tenantId;

  return {
    listContacts(principal: AutomationPrincipal, query: unknown) {
      const parsed = parseInput(listContactsQuerySchema, query, "query");
      return guarded(principal, "contacts:read", (tx) => listContacts(tx, tenant(principal), parsed));
    },
    getContact(principal: AutomationPrincipal, contactId: unknown) {
      const id = parseInput(uuidSchema, contactId, "contact ID");
      return guarded(principal, "contacts:read", (tx) => getContact(tx, tenant(principal), id));
    },
    listPipelines: (principal: AutomationPrincipal) =>
      guarded(principal, "deals:read", async (tx) => ({ items: await listPipelines(tx, tenant(principal)) })),
    listDeals(principal: AutomationPrincipal, query: unknown) {
      const parsed = parseInput(listDealsQuerySchema, query, "query");
      return guarded(principal, "deals:read", (tx) => listDeals(tx, tenant(principal), parsed));
    },
    listResources: (principal: AutomationPrincipal) =>
      guarded(principal, "bookings:read", async (tx) => ({ items: await listResources(tx, tenant(principal)) })),
    listBookings(principal: AutomationPrincipal, query: unknown) {
      const parsed = parseInput(listBookingsQuerySchema, query, "query");
      return guarded(principal, "bookings:read", (tx) => listBookings(tx, tenant(principal), parsed));
    },
    listThreads(principal: AutomationPrincipal, query: unknown) {
      const parsed = parseInput(listThreadsQuerySchema, query, "query");
      return guarded(principal, "inbox:read", (tx) => listThreads(tx, tenant(principal), parsed));
    },
    getThread(principal: AutomationPrincipal, threadId: unknown) {
      const id = parseInput(threadIdSchema, threadId, "thread ID");
      return guarded(principal, "inbox:read", (tx) => getThread(tx, tenant(principal), id));
    },
    /** The clock read after the lock fixes both weeks to one instant. */
    homeResults(principal: AutomationPrincipal, query: unknown) {
      const parsed = parseInput(resultsQuerySchema, query, "query");
      return guarded(principal, "results:read", (tx, now) => homeResults(tx, tenant(principal), parsed, now.getTime()));
    },
    getBusiness: (principal: AutomationPrincipal) =>
      guarded(principal, "business:read", (tx) => getBusinessProfile(tx, tenant(principal))),
  };
}
export type TokenReads = ReturnType<typeof createTokenReads>;

/** What one request adds to its token's row for the hour (H-8). */
export interface UsageDelta {
  readonly requests: number;
  readonly reads: number;
  readonly proposals: number;
  readonly refusals: number;
}

/**
 * H-8: add to the token's counters for the current hour, atomically, in their own transaction.
 * The caller logs a failure and goes on: counting never fails a request.
 */
export async function recordTokenUsage(deps: EdgeDependencies, principal: AutomationPrincipal, delta: UsageDelta): Promise<void> {
  const hour = hourOf(new Date(readClock(deps.clock)));
  await deps.db.tenant(principal.tenantId, (tx) => tx.query(
    `INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests, reads, proposals, refusals)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, token_id, hour) DO UPDATE SET
       requests = automation_token_usage.requests + EXCLUDED.requests,
       reads = automation_token_usage.reads + EXCLUDED.reads,
       proposals = automation_token_usage.proposals + EXCLUDED.proposals,
       refusals = automation_token_usage.refusals + EXCLUDED.refusals`,
    [principal.tenantId, principal.tokenId, hour, delta.requests, delta.reads, delta.proposals, delta.refusals]));
}

interface UsageRow { hour: Date; requests: number; reads: number; proposals: number; refusals: number }

/** H-8: one token's hours over the last 7 days, oldest first, for an owner. */
export async function readTokenUsage(tx: Transaction, tenantId: string, tokenId: string, now: Date): Promise<AutomationUsage | null> {
  if (!(await loadToken(tx, tenantId, tokenId))) return null;
  const from = hourOf(new Date(now.getTime() - USAGE_READ_DAYS * DAY_MS));
  const rows = (await tx.query<UsageRow>(
    `SELECT hour, requests, reads, proposals, refusals FROM automation_token_usage
      WHERE tenant_id=$1 AND token_id=$2 AND hour >= $3 ORDER BY hour`, [tenantId, tokenId, from])).rows;
  const sum = (field: keyof Omit<UsageRow, "hour">) => rows.reduce((total, row) => total + row[field], 0);
  return {
    tokenId, from: from.toISOString(), to: now.toISOString(),
    hours: rows.map((row) => ({
      hour: row.hour.toISOString(), requests: row.requests, reads: row.reads, proposals: row.proposals, refusals: row.refusals,
    })),
    totals: { requests: sum("requests"), reads: sum("reads"), proposals: sum("proposals"), refusals: sum("refusals") },
  };
}
