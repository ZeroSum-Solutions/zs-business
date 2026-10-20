// M5 Google Calendar worker (docs/requirements/google-calendar.md G-6..G-10). Original code. It
// runs as the service role (the `service` dependency) and names tenant_id in every statement on a
// tenant table. Each connection moves through short transactions: a claim that leases it, Google
// calls outside any transaction, and one write that checks the lease is still ours. Writes that
// touch a resource's external blocks take the B-21 resource lock first, like booking.create.
//
// Leases: calendar_connections and calendar_pushes have a lease_until column and no lease
// token. A claim sets lease_until = now + leaseMs and every later write requires that exact
// value, so it doubles as the token: a second claim needs lease_until <= its own now, which is
// later than the first claim's, so two holders never share a value.
//
// Disconnect decision (G-9): a revoke that fails with a retryable error (network, 5xx, 429,
// timeout) leaves the connection `disconnecting` with its blocks and token, and retries after a
// delay (lease_until doubles as the not-before). A non-retryable refusal cannot get better by
// retrying, so cleanup goes ahead. Blocks are deleted in the same transaction that sets
// `disconnected`, so a disconnected connection never has blocks.
import { KeyObject } from "node:crypto";
import { z } from "zod";
import { ValidationFailed } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { busySpan, type BusySpan } from "./busy.js";
import { channelToken } from "./oauth-state.js";
import { openRefreshToken } from "./seal.js";
import { GoogleRequestFailed, type GoogleClient, type GoogleEvent, type GoogleEventPage, type ListEventsQuery } from "./types.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const durationMs = z.number().int().positive().max(366 * DAY);
/** G-6: a full list runs from 1 day ago to 400 days ahead; after a capped one, a near list to 30 days ahead. */
const FULL_AHEAD_MS = 400 * DAY;
const NEAR_AHEAD_MS = 30 * DAY;

export const calendarWorkerConfigSchema = z.strictObject({
  /** GOOGLE_TOKEN_PRIVATE_KEY, parsed (parseSealPrivateKey). */
  privateKey: z.custom<KeyObject>(
    (value) => value instanceof KeyObject && value.type === "private" && value.asymmetricKeyType === "x25519",
    "privateKey must be an X25519 private key"),
  /** GOOGLE_CHANNEL_SECRET (G-8). */
  channelSecret: z.string().min(16),
  /** GOOGLE_WEBHOOK_URL; without it no channels are opened (G-8). */
  webhookUrl: z.url({ protocol: /^https$/ }).optional(),
  /** GOOGLE_EVENT_TITLE (G-10): no customer data. */
  eventTitle: z.string().trim().min(1).max(200).default("Booked"),
  pollIntervalMs: durationMs.default(15 * MINUTE),
  fullSyncIntervalMs: durationMs.default(7 * DAY),
  leaseMs: durationMs.default(2 * MINUTE),
  claimLimit: z.number().int().min(1).max(100).default(5),
  pushLimit: z.number().int().min(1).max(500).default(20),
  pushMaxAttempts: z.number().int().min(1).max(100).default(8),
  channelRenewBeforeMs: durationMs.default(DAY),
  requestTimeoutMs: durationMs.default(10 * SECOND),
  /** Shortest and longest wait before retrying a connection or push after a retryable failure. */
  retryBaseMs: durationMs.default(MINUTE),
  retryMaxMs: durationMs.default(HOUR),
  /** G-6: pages of 250 per listing. */
  maxPages: z.number().int().min(1).max(100).default(20),
  /** Unprocessed notifications handled per pass. */
  notificationLimit: z.number().int().min(1).max(10_000).default(1000),
}).refine((config) => config.requestTimeoutMs * 2 <= config.leaseMs,
  "requestTimeoutMs must be at most half of leaseMs, so a lease outlives each Google call")
  .refine((config) => config.retryBaseMs <= config.retryMaxMs, "retryBaseMs must not exceed retryMaxMs");
export type CalendarWorkerConfig = z.input<typeof calendarWorkerConfigSchema>;
type Config = z.infer<typeof calendarWorkerConfigSchema>;

/** Operator events. Never carries a token. */
export type CalendarWorkerReport =
  | { readonly kind: "synced"; readonly tenantId: string; readonly connectionId: string; readonly mode: "full" | "incremental"; readonly events: number; readonly complete: boolean }
  | { readonly kind: "sync_failed"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "reauthorize"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "disconnected"; readonly tenantId: string; readonly connectionId: string; readonly revoke: "revoked" | "skipped" | string }
  | { readonly kind: "disconnect_retry"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "channel_failed"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "push_failed"; readonly tenantId: string; readonly connectionId: string; readonly bookingId: string; readonly code: string; readonly final: boolean }
  | { readonly kind: "lost_lease"; readonly tenantId: string; readonly connectionId: string; readonly bookingId?: string }
  | { readonly kind: "deadline_reached"; readonly tenantId: string; readonly connectionId: string }
  | { readonly kind: "step_failed"; readonly step: "notifications" | "disconnects" | "sync" | "pushes"; readonly tenantId?: string; readonly connectionId?: string; readonly error: string };

export interface CalendarWorkerDeps {
  /** A service-role transaction: `(work) => asService(servicePool, work)`. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly google: GoogleClient;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: CalendarWorkerConfig;
  readonly report?: (event: CalendarWorkerReport) => void;
}

export interface CalendarRunCounts {
  /** a. notifications marked processed, and connections they made due. */
  notifications: number;
  markedDue: number;
  /** b. */
  disconnected: number;
  disconnectRetries: number;
  /** c. */
  synced: number;
  syncFailed: number;
  reauthorized: number;
  lostLeases: number;
  /** Connections the run's deadline cut mid-list and handed back unchanged (G-10). */
  deadlineStops: number;
  /** d. */
  channelsOpened: number;
  channelsStopped: number;
  channelFailures: number;
  /** e. */
  pushesQueued: number;
  pushed: number;
  pushRetries: number;
  pushesFailed: number;
}

const emptyCounts = (): CalendarRunCounts => ({
  notifications: 0, markedDue: 0, disconnected: 0, disconnectRetries: 0, synced: 0, syncFailed: 0, reauthorized: 0,
  lostLeases: 0, deadlineStops: 0, channelsOpened: 0, channelsStopped: 0, channelFailures: 0, pushesQueued: 0, pushed: 0,
  pushRetries: 0, pushesFailed: 0,
});

/** The B-21 lock, the same expression booking.create's checkBookingSlot takes. */
const RESOURCE_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('booking-resource:' || $1::uuid::text || ':' || $2::uuid::text, 0))";
export async function lockBookingResource(tx: Transaction, tenantId: string, resourceId: string): Promise<void> {
  await tx.query(RESOURCE_LOCK_SQL, [tenantId, resourceId]);
}

/** Error codes fit the 1..200 error columns and carry nothing but a code. */
const codeText = (code: string) => (code.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 200) || "unknown");
const GRANT_GONE = new Set(["invalid_grant", "token_unreadable"]);

class LostLease extends Error {
  constructor() { super("Lease lost"); this.name = "LostLease"; }
}

/** G-10: the run's deadline came while a connection was still listing; nothing of it is written. */
class DeadlineReached extends Error {
  constructor() { super("Run deadline reached"); this.name = "DeadlineReached"; }
}

interface ConnectionRow {
  tenant_id: string;
  id: string;
  resource_id: string;
  calendar_id: string;
  refresh_token_sealed: string | null;
  sync_token: string | null;
  last_full_sync_at: Date | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  next_sync_at: Date;
  lease_until: Date;
  channel_id: string | null;
  channel_resource_id: string | null;
  channel_expires_at: Date | null;
  time_zone: string;
}

interface PushRow {
  tenant_id: string;
  connection_id: string;
  booking_id: string;
  resource_id: string;
  google_event_id: string;
  attempts: number;
  lease_until: Date;
  starts_at: Date;
  ends_at: Date;
  calendar_id: string;
  refresh_token_sealed: string | null;
}

interface Listing {
  readonly mode: "full" | "incremental";
  readonly events: GoogleEvent[];
  readonly nextSyncToken: string | null;
  /** False when the page limit ran out before the last page. */
  readonly complete: boolean;
  /** A full list's window in UTC epoch milliseconds, [start, end); null for an incremental one. */
  readonly window: { readonly start: number; readonly end: number } | null;
  /** G-6: after a capped full list, the complete near list that decides the blocks starting in its window. */
  readonly near?: Listing;
}

export function createCalendarWorker(deps: CalendarWorkerDeps) {
  const parsed = calendarWorkerConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new ValidationFailed(`Invalid calendar worker config: ${parsed.error.message}`);
  const config: Config = parsed.data;
  const nowMs = () => readClock(deps.clock);
  const report = (event: CalendarWorkerReport) => {
    try { deps.report?.(event); } catch { /* a reporter never stops the worker */ }
  };
  const errorMessage = (error: unknown) => codeText(error instanceof Error ? error.message : "error");
  /** G-10: once a run's deadline passes it claims no new work. */
  const past = (deadline?: Date) => deadline !== undefined && nowMs() >= deadline.getTime();

  /**
   * One Google call with the configured timeout, cut shorter by a run deadline when one is given;
   * anything but a typed failure is retryable.
   */
  async function call<T>(work: (signal: AbortSignal) => Promise<T>, runDeadline?: Date): Promise<T> {
    const left = runDeadline === undefined ? Infinity : runDeadline.getTime() - nowMs();
    if (left <= 0) throw new DeadlineReached();
    const cut = left < config.requestTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(cut ? new DeadlineReached() : new GoogleRequestFailed("google_timeout", true));
      }, cut ? left : config.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)).catch((error: unknown) => {
          throw error instanceof GoogleRequestFailed ? error : new GoogleRequestFailed("google_client_error", true);
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Google failures keep their code; anything else is the worker's own error, retried. */
  const classify = (error: unknown): { code: string; retry: boolean } =>
    error instanceof GoogleRequestFailed ? { code: codeText(error.code), retry: error.retry }
      : error instanceof DeadlineReached ? { code: "run_deadline", retry: true }
      : { code: "worker_error", retry: true };

  /** Wait before retrying something that has been failing since `since`: it grows with the outage. */
  const retryDelay = (since: Date | null, at: number) =>
    Math.min(config.retryMaxMs, Math.max(config.retryBaseMs, since ? at - since.getTime() : 0));

  const refreshTokenOf = (row: { tenant_id: string; id: string; refresh_token_sealed: string | null }) =>
    row.refresh_token_sealed === null ? null
      : openRefreshToken(config.privateKey, { tenantId: row.tenant_id, connectionId: row.id }, row.refresh_token_sealed);

  /** Access tokens for one pass, by connection; a failed refresh is remembered for the pass too. */
  type Tokens = Map<string, Promise<string>>;
  function accessToken(tokens: Tokens, row: { tenant_id: string; id: string; refresh_token_sealed: string | null }): Promise<string> {
    const key = `${row.tenant_id}:${row.id}`;
    let found = tokens.get(key);
    if (!found) {
      const refreshToken = refreshTokenOf(row);
      found = refreshToken === null
        ? Promise.reject(new GoogleRequestFailed("token_unreadable", false))
        : call((signal) => deps.google.refreshAccessToken(refreshToken, { signal })).then((grant) => grant.accessToken);
      found.catch(() => undefined);
      tokens.set(key, found);
    }
    return found;
  }

  /** G-9: the grant is gone; blocks stay until the owner reconnects or disconnects. */
  async function markReauthorize(tenantId: string, connectionId: string, code: string, lease: Date | null): Promise<boolean> {
    const at = new Date(nowMs());
    const updated = await deps.service((tx) => tx.query(
      `UPDATE calendar_connections SET status='reauthorize', last_error=$3, updated_at=$4,
         lease_until=CASE WHEN lease_until IS NOT DISTINCT FROM $5::timestamptz THEN NULL ELSE lease_until END
        WHERE tenant_id=$1 AND id=$2 AND status='active'`,
      [tenantId, connectionId, code, at, lease]));
    if (updated.rowCount === 1) report({ kind: "reauthorize", tenantId, connectionId, code });
    return updated.rowCount === 1;
  }

  // ---------------------------------------------------------------- a. notifications (G-8)

  /** Marks connections with fresh push notifications due now and the notifications processed. */
  async function notifications(counts: CalendarRunCounts = emptyCounts(), deadline?: Date): Promise<CalendarRunCounts> {
    if (past(deadline)) return counts;
    await deps.service(async (tx) => {
      const at = new Date(nowMs());
      const marked = (await tx.query<{ marked: number; channels: string[] | null }>(
        `WITH due AS (
           SELECT channel_id, message_number FROM calendar_push_notifications
            WHERE processed_at IS NULL ORDER BY received_at, channel_id, message_number LIMIT $2 FOR UPDATE SKIP LOCKED),
         marked AS (
           UPDATE calendar_push_notifications n SET processed_at=$1 FROM due
            WHERE n.channel_id=due.channel_id AND n.message_number=due.message_number
           RETURNING n.channel_id, n.resource_state)
         SELECT count(*)::int AS marked,
                array_agg(DISTINCT channel_id) FILTER (WHERE resource_state <> 'sync') AS channels FROM marked`,
        [at, config.notificationLimit])).rows[0]!;
      counts.notifications += marked.marked;
      if (marked.channels?.length) {
        // A channel names one connection (unique channel_id); the first `sync` message carries no change.
        const due = await tx.query(
          `UPDATE calendar_connections c SET next_sync_at=$1
             FROM (SELECT tenant_id, id FROM calendar_connections WHERE channel_id = ANY($2::uuid[]) AND status='active') t
            WHERE c.tenant_id=t.tenant_id AND c.id=t.id`,
          [at, marked.channels]);
        counts.markedDue += due.rowCount ?? 0;
      }
      await tx.query("DELETE FROM calendar_push_notifications WHERE processed_at IS NOT NULL AND processed_at < $1",
        [new Date(at.getTime() - DAY)]);
    });
    return counts;
  }

  /** Claimed connections a pass will not reach before its deadline: the leases go back, so the next run takes them at once. */
  async function releaseConnections(rows: readonly ConnectionRow[]): Promise<void> {
    await deps.service((tx) => tx.query(
      `UPDATE calendar_connections c SET lease_until=NULL
         FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS u(tenant_id, id, lease_until)
        WHERE c.tenant_id=u.tenant_id AND c.id=u.id AND c.lease_until=u.lease_until`,
      [rows.map((row) => row.tenant_id), rows.map((row) => row.id), rows.map((row) => row.lease_until)]));
  }

  // ---------------------------------------------------------------- b. disconnects (G-9)

  async function disconnects(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map(), deadline?: Date): Promise<CalendarRunCounts> {
    if (past(deadline)) return counts;
    const rows = await deps.service(async (tx) => {
      const at = nowMs();
      return (await tx.query<ConnectionRow>(
        `WITH due AS (
           SELECT tenant_id, id FROM calendar_connections
            WHERE status='disconnecting' AND (lease_until IS NULL OR lease_until <= $1)
            ORDER BY updated_at, tenant_id, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE calendar_connections c SET lease_until=$3 FROM due
          WHERE c.tenant_id=due.tenant_id AND c.id=due.id
         RETURNING c.tenant_id, c.id, c.resource_id, c.refresh_token_sealed, c.channel_id, c.channel_resource_id,
           c.updated_at, c.lease_until`,
        [new Date(at), config.claimLimit, new Date(at + config.leaseMs)])).rows;
    });
    for (const [index, row] of rows.entries()) {
      if (past(deadline)) {
        await releaseConnections(rows.slice(index));
        break;
      }
      try {
        await disconnectOne(row, counts, tokens);
      } catch (error) {
        report({ kind: "step_failed", step: "disconnects", tenantId: row.tenant_id, connectionId: row.id, error: errorMessage(error) });
      }
    }
    return counts;
  }

  async function disconnectOne(row: ConnectionRow, counts: CalendarRunCounts, tokens: Tokens): Promise<void> {
    const refreshToken = refreshTokenOf(row);
    // The channel would expire on its own; stopping it is a courtesy and its errors are ignored.
    if (refreshToken !== null && row.channel_id !== null && row.channel_resource_id !== null) {
      try {
        const access = await accessToken(tokens, row);
        await call((signal) => deps.google.stopChannel(access,
          { channelId: row.channel_id!, resourceId: row.channel_resource_id! }, { signal }));
        counts.channelsStopped += 1;
      } catch { /* ignored (G-9) */ }
    }
    let revoke = "skipped";
    // Google revokes a whole grant (one Google account and this client), not one refresh token,
    // so a revoke would also end an active connection on the same account: the reconnect that
    // replaced this row, or another resource or tenant. Without an email on either row, a
    // replacement on the same resource may be that account. Then the grant stays, and only this
    // row lets go of its token. A reauthorize row's grant is already gone, so it shares nothing.
    const shared = refreshToken !== null && (await deps.service((tx) => tx.query(
      `SELECT 1 FROM calendar_connections leaving, calendar_connections other
        WHERE leaving.tenant_id=$1 AND leaving.id=$2
          AND other.status='active' AND NOT (other.tenant_id=$1 AND other.id=$2)
          AND (lower(other.account_email) = lower(leaving.account_email)
            OR ((other.account_email IS NULL OR leaving.account_email IS NULL)
              AND other.tenant_id=$1 AND other.resource_id=$3))
        LIMIT 1`,
      [row.tenant_id, row.id, row.resource_id]))).rowCount === 1;
    if (shared) revoke = "shared_grant";
    else if (refreshToken !== null) {
      try {
        await call((signal) => deps.google.revoke(refreshToken, { signal }));
        revoke = "revoked";
      } catch (error) {
        const { code, retry } = classify(error);
        if (retry) {
          // Keep disconnecting: the lease is the not-before of the next try.
          const at = nowMs();
          await deps.service((tx) => tx.query(
            `UPDATE calendar_connections SET lease_until=$4, last_error=$5
              WHERE tenant_id=$1 AND id=$2 AND lease_until=$3 AND status='disconnecting'`,
            [row.tenant_id, row.id, row.lease_until, new Date(at + retryDelay(row.updated_at, at)), code]));
          counts.disconnectRetries += 1;
          report({ kind: "disconnect_retry", tenantId: row.tenant_id, connectionId: row.id, code });
          return;
        }
        revoke = code;
      }
    }
    const done = await deps.service(async (tx) => {
      await lockBookingResource(tx, row.tenant_id, row.resource_id);
      const held = await tx.query(
        `SELECT 1 FROM calendar_connections
          WHERE tenant_id=$1 AND id=$2 AND status='disconnecting' AND lease_until=$3 FOR UPDATE`,
        [row.tenant_id, row.id, row.lease_until]);
      if (held.rowCount !== 1) return false;
      const at = new Date(nowMs());
      await tx.query("DELETE FROM booking_external_blocks WHERE tenant_id=$1 AND connection_id=$2", [row.tenant_id, row.id]);
      await tx.query(
        `UPDATE calendar_pushes SET status='failed', last_error='disconnected', lease_until=NULL, updated_at=$3
          WHERE tenant_id=$1 AND connection_id=$2 AND status='pending'`,
        [row.tenant_id, row.id, at]);
      await tx.query(
        `UPDATE calendar_connections SET status='disconnected', refresh_token_sealed=NULL, sync_token=NULL,
           channel_id=NULL, channel_resource_id=NULL, channel_expires_at=NULL, lease_until=NULL, last_error=NULL,
           updated_at=$3
          WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, at]);
      return true;
    });
    if (!done) {
      counts.lostLeases += 1;
      report({ kind: "lost_lease", tenantId: row.tenant_id, connectionId: row.id });
      return;
    }
    counts.disconnected += 1;
    report({ kind: "disconnected", tenantId: row.tenant_id, connectionId: row.id, revoke });
  }

  // ---------------------------------------------------------------- c. sync (G-6, G-7) and d. channels (G-8)

  async function sync(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map(), deadline?: Date): Promise<CalendarRunCounts> {
    if (past(deadline)) return counts;
    const rows = await deps.service(async (tx) => {
      const at = nowMs();
      return (await tx.query<ConnectionRow>(
        `WITH due AS (
           SELECT tenant_id, id FROM calendar_connections
            WHERE status='active' AND next_sync_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
            ORDER BY next_sync_at, tenant_id, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE calendar_connections c SET lease_until=$3 FROM due, booking_resources r
          WHERE c.tenant_id=due.tenant_id AND c.id=due.id AND r.tenant_id=c.tenant_id AND r.id=c.resource_id
         RETURNING c.tenant_id, c.id, c.resource_id, c.calendar_id, c.refresh_token_sealed, c.sync_token,
           c.last_full_sync_at, c.last_synced_at, c.created_at, c.updated_at, c.next_sync_at, c.lease_until,
           c.channel_id, c.channel_resource_id, c.channel_expires_at, r.time_zone`,
        [new Date(at), config.claimLimit, new Date(at + config.leaseMs)])).rows;
    });
    // RETURNING keeps no order: the longest overdue goes first, which a deadline cut relies on.
    rows.sort((a, b) => a.next_sync_at.getTime() - b.next_sync_at.getTime()
      || (a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const [index, row] of rows.entries()) {
      if (past(deadline)) {
        await releaseConnections(rows.slice(index));
        break;
      }
      const lease = { until: row.lease_until };
      try {
        await syncOne(row, lease, counts, tokens, deadline);
      } catch (error) {
        // G-10: a later connection cut by the deadline goes back as it was, so the next run takes it
        // first with a whole budget. One cut while first in the pass is too slow for a run and
        // backs off as a failed sync instead of taking every run's budget.
        if (error instanceof DeadlineReached && index > 0) {
          await releaseConnections([{ ...row, lease_until: lease.until }, ...rows.slice(index + 1)]);
          counts.deadlineStops += 1;
          report({ kind: "deadline_reached", tenantId: row.tenant_id, connectionId: row.id });
          break;
        }
        await syncFailed(row, lease.until, error, counts).catch((failure: unknown) =>
          report({ kind: "step_failed", step: "sync", tenantId: row.tenant_id, connectionId: row.id, error: errorMessage(failure) }));
      }
    }
    return counts;
  }

  /** Extends the lease once half of it is used; a lease someone else took ends this connection's pass. */
  async function renewLease(row: ConnectionRow, lease: { until: Date }): Promise<void> {
    const at = nowMs();
    if (lease.until.getTime() - at > config.leaseMs / 2) return;
    const next = new Date(at + config.leaseMs);
    const renewed = await deps.service((tx) => tx.query(
      "UPDATE calendar_connections SET lease_until=$4 WHERE tenant_id=$1 AND id=$2 AND lease_until=$3 AND status='active'",
      [row.tenant_id, row.id, lease.until, next]));
    if (renewed.rowCount !== 1) throw new LostLease();
    lease.until = next;
  }

  async function listAll(access: string, row: ConnectionRow, lease: { until: Date }, deadline: Date | undefined,
    syncToken: string | null, aheadMs = FULL_AHEAD_MS): Promise<Listing> {
    const at = nowMs();
    const window = syncToken !== null ? null : { start: at - DAY, end: at + aheadMs };
    const base = window === null
      ? { calendarId: row.calendar_id, syncToken: syncToken! }
      : { calendarId: row.calendar_id, timeMin: new Date(window.start).toISOString(), timeMax: new Date(window.end).toISOString() };
    const events: GoogleEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < config.maxPages; page += 1) {
      const query: ListEventsQuery = pageToken === null ? base : { ...base, pageToken };
      const result: GoogleEventPage = await call((signal) => deps.google.listEvents(access, query, { signal }), deadline);
      events.push(...result.items);
      if (!result.nextPageToken) {
        const token = result.nextSyncToken;
        return {
          mode: syncToken !== null ? "incremental" : "full", events, complete: true, window,
          nextSyncToken: token && token.length <= 2000 ? token : null,
        };
      }
      pageToken = result.nextPageToken;
      await renewLease(row, lease);
    }
    return { mode: syncToken !== null ? "incremental" : "full", events, nextSyncToken: null, complete: false, window };
  }

  async function syncOne(row: ConnectionRow, lease: { until: Date }, counts: CalendarRunCounts, tokens: Tokens,
    deadline?: Date): Promise<void> {
    const access = await accessToken(tokens, row);
    const startedAt = nowMs();
    const incremental = row.sync_token !== null && row.last_full_sync_at !== null
      && startedAt - row.last_full_sync_at.getTime() < config.fullSyncIntervalMs;
    let listing: Listing;
    try {
      listing = await listAll(access, row, lease, deadline, incremental ? row.sync_token : null);
    } catch (error) {
      // G-6: an expired sync token means a full list, in this same pass.
      if (!(incremental && error instanceof GoogleRequestFailed && (error.code === "sync_token_expired" || error.status === 410))) throw error;
      listing = await listAll(access, row, lease, deadline, null);
    }
    // G-6: a full list cut short by the page cap; a complete near list still settles its window.
    // Either way no sync token is stored, so the next sync is full again.
    if (listing.mode === "full" && !listing.complete) {
      await renewLease(row, lease);
      const near = await listAll(access, row, lease, deadline, null, NEAR_AHEAD_MS);
      if (near.complete) listing = { ...listing, near };
    }

    // d. G-8: open or renew the watch channel while the access token is fresh. Each channel call
    // is bounded by the run's deadline too (G-10); a channel left open expires on its own.
    let opened: { id: string; resourceId: string; expiresAt: Date } | null = null;
    if (config.webhookUrl && !past(deadline) && (row.channel_expires_at === null
      || row.channel_expires_at.getTime() <= nowMs() + config.channelRenewBeforeMs)) {
      // verifyChannelToken (G-8) reads channel IDs in lower case.
      const channelId = deps.generateId().toLowerCase();
      try {
        const watched = await call((signal) => deps.google.watch(access, {
          calendarId: row.calendar_id, channelId, address: config.webhookUrl!, token: channelToken(config.channelSecret, channelId),
        }, { signal }), deadline);
        if (typeof watched.resourceId !== "string" || watched.resourceId.length < 1 || watched.resourceId.length > 255
          || !Number.isSafeInteger(watched.expiresAt) || watched.expiresAt <= nowMs()) {
          await stopQuietly(access, channelId, typeof watched.resourceId === "string" ? watched.resourceId : "", counts, deadline);
          throw new GoogleRequestFailed("google_watch_unusable", false);
        }
        opened = { id: channelId, resourceId: watched.resourceId, expiresAt: new Date(watched.expiresAt) };
      } catch (error) {
        counts.channelFailures += 1;
        report({ kind: "channel_failed", tenantId: row.tenant_id, connectionId: row.id, code: classify(error).code });
      }
    }

    const applied = await apply(row, lease.until, listing, opened);
    if (applied !== "applied") {
      if (opened) await stopQuietly(access, opened.id, opened.resourceId, counts, deadline);
      if (applied === "lost") {
        counts.lostLeases += 1;
        report({ kind: "lost_lease", tenantId: row.tenant_id, connectionId: row.id });
      }
      return;
    }
    if (opened) {
      counts.channelsOpened += 1;
      if (row.channel_id !== null && row.channel_resource_id !== null)
        await stopQuietly(access, row.channel_id, row.channel_resource_id, counts, deadline);
    }
    counts.synced += 1;
    report({ kind: "synced", tenantId: row.tenant_id, connectionId: row.id, mode: listing.mode, events: listing.events.length, complete: listing.complete });
  }

  /** Past the run's deadline (when one is given) it does not call Google at all. */
  async function stopQuietly(access: string, channelId: string, resourceId: string, counts: CalendarRunCounts,
    deadline?: Date): Promise<void> {
    if (!resourceId) return;
    try {
      await call((signal) => deps.google.stopChannel(access, { channelId, resourceId }, { signal }), deadline);
      counts.channelsStopped += 1;
    } catch { /* the channel expires on its own */ }
  }

  /** G-6, G-7: one transaction under the B-21 lock. */
  async function apply(row: ConnectionRow, lease: Date, listing: Listing,
    opened: { id: string; resourceId: string; expiresAt: Date } | null): Promise<"applied" | "lost" | "inactive"> {
    const own = { tenantId: row.tenant_id, resourceId: row.resource_id };
    // Last state per event ID wins; IDs that cannot be stored are skipped.
    const spansOf = (events: readonly GoogleEvent[]) => {
      const found = new Map<string, BusySpan | null>();
      for (const event of events) {
        if (typeof event?.id !== "string" || event.id.length < 1 || event.id.length > 1024) continue;
        found.set(event.id, busySpan(event, row.time_zone, own));
      }
      return found;
    };
    const busyOf = (found: Map<string, BusySpan | null>) =>
      [...found].filter((entry): entry is [string, BusySpan] => entry[1] !== null);
    const spans = spansOf(listing.events);
    const free = [...spans].filter(([, span]) => span === null).map(([id]) => id);
    // G-6: the near list decides every block starting in its window; the capped list only adds
    // or moves blocks starting outside it.
    const near = listing.near?.window ? { window: listing.near.window, busy: busyOf(spansOf(listing.near.events)) } : null;
    const nearIds = new Set(listing.near?.events.map((event) => event?.id));
    const busy = near === null ? busyOf(spans) : [
      ...near.busy,
      ...busyOf(spans).filter(([id, span]) => !nearIds.has(id) && (span.start < near.window.start || span.start >= near.window.end)),
    ];
    return deps.service(async (tx) => {
      await lockBookingResource(tx, row.tenant_id, row.resource_id);
      const current = (await tx.query<{ status: string }>(
        "SELECT status FROM calendar_connections WHERE tenant_id=$1 AND id=$2 AND lease_until=$3 FOR UPDATE",
        [row.tenant_id, row.id, lease])).rows[0];
      if (!current) return "lost";
      if (current.status !== "active") {
        // Disconnecting or reauthorize meanwhile: change no block, give the row back.
        await tx.query("UPDATE calendar_connections SET lease_until=NULL WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
        return "inactive";
      }
      const at = new Date(nowMs());
      const replace = listing.mode === "full" && listing.complete;
      if (replace)
        await tx.query("DELETE FROM booking_external_blocks WHERE tenant_id=$1 AND connection_id=$2", [row.tenant_id, row.id]);
      else if (near !== null)
        await tx.query(
          `DELETE FROM booking_external_blocks WHERE tenant_id=$1 AND connection_id=$2
              AND starts_at >= $3 AND starts_at < $4 AND external_id <> ALL($5::text[])`,
          [row.tenant_id, row.id, new Date(near.window.start), new Date(near.window.end), near.busy.map(([id]) => id)]);
      else if (free.length > 0 && listing.mode === "incremental")
        await tx.query(
          "DELETE FROM booking_external_blocks WHERE tenant_id=$1 AND connection_id=$2 AND external_id = ANY($3::text[])",
          [row.tenant_id, row.id, free]);
      if (busy.length > 0)
        await tx.query(
          `INSERT INTO booking_external_blocks (tenant_id, id, resource_id, starts_at, ends_at, source, created_at, connection_id, external_id)
           SELECT $1, u.id, $2, u.starts_at, u.ends_at, 'google', $3, $4, u.external_id
             FROM unnest($5::uuid[], $6::timestamptz[], $7::timestamptz[], $8::text[]) AS u(id, starts_at, ends_at, external_id)
           ON CONFLICT (tenant_id, connection_id, external_id) WHERE connection_id IS NOT NULL
           DO UPDATE SET starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at`,
          [row.tenant_id, row.resource_id, at, row.id, busy.map(() => deps.generateId()),
            busy.map(([, span]) => new Date(span.start).toISOString()), busy.map(([, span]) => new Date(span.end).toISOString()),
            busy.map(([id]) => id)]);
      // An incomplete incremental list leaves the token unusable: the next pass lists in full.
      const lastError = listing.complete ? null : listing.mode === "full" ? "too_many_events" : "too_many_changes";
      const next = new Date(at.getTime() + config.pollIntervalMs);
      await tx.query(
        `UPDATE calendar_connections SET sync_token=$3, last_synced_at=$4,
           last_full_sync_at=CASE WHEN $5::boolean THEN $4 ELSE last_full_sync_at END,
           next_sync_at=CASE WHEN date_trunc('milliseconds', next_sync_at)=$6 THEN $7 ELSE least(next_sync_at, $7) END,
           lease_until=NULL, last_error=$8, updated_at=$4,
           channel_id=CASE WHEN $9::uuid IS NULL THEN channel_id ELSE $9::uuid END,
           channel_resource_id=CASE WHEN $9::uuid IS NULL THEN channel_resource_id ELSE $10 END,
           channel_expires_at=CASE WHEN $9::uuid IS NULL THEN channel_expires_at ELSE $11::timestamptz END
          WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, listing.nextSyncToken, at, replace, row.next_sync_at, next, lastError,
          opened?.id ?? null, opened?.resourceId ?? null, opened?.expiresAt ?? null]);
      return "applied";
    });
  }

  async function syncFailed(row: ConnectionRow, lease: Date, error: unknown, counts: CalendarRunCounts): Promise<void> {
    if (error instanceof LostLease) {
      counts.lostLeases += 1;
      report({ kind: "lost_lease", tenantId: row.tenant_id, connectionId: row.id });
      return;
    }
    const { code } = classify(error);
    if (GRANT_GONE.has(code)) {
      if (await markReauthorize(row.tenant_id, row.id, code, lease)) counts.reauthorized += 1;
      return;
    }
    // Blocks stay as they are; the connection is retried later (G-6).
    const at = nowMs();
    await deps.service((tx) => tx.query(
      `UPDATE calendar_connections SET next_sync_at=$4, last_error=$5, lease_until=NULL, updated_at=$6
        WHERE tenant_id=$1 AND id=$2 AND lease_until=$3`,
      [row.tenant_id, row.id, lease, new Date(at + retryDelay(row.last_synced_at ?? row.created_at, at)), code, new Date(at)]));
    counts.syncFailed += 1;
    report({ kind: "sync_failed", tenantId: row.tenant_id, connectionId: row.id, code });
  }

  // ---------------------------------------------------------------- e. pushes (G-10)

  async function pushes(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map(), deadline?: Date): Promise<CalendarRunCounts> {
    if (past(deadline)) return counts;
    const claimed = await deps.service(async (tx) => {
      const at = nowMs();
      const queued = await tx.query(
        `INSERT INTO calendar_pushes (tenant_id, connection_id, booking_id, status, attempts, next_attempt_at, created_at, updated_at)
         SELECT b.tenant_id, c.id, b.id, 'pending', 0, $1, $1, $1
           FROM bookings b
           JOIN calendar_connections c ON c.tenant_id=b.tenant_id AND c.resource_id=b.resource_id AND c.status='active'
          WHERE b.status='confirmed' AND b.ends_at > $1
            AND NOT EXISTS (SELECT 1 FROM calendar_pushes p
                             WHERE p.tenant_id=b.tenant_id AND p.connection_id=c.id AND p.booking_id=b.id)
         ON CONFLICT (tenant_id, connection_id, booking_id) DO NOTHING`,
        [new Date(at)]);
      counts.pushesQueued += queued.rowCount ?? 0;
      return (await tx.query<PushRow>(
        `WITH due AS (
           SELECT p.tenant_id, p.connection_id, p.booking_id FROM calendar_pushes p
             JOIN calendar_connections c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id AND c.status='active'
            WHERE p.status='pending' AND p.next_attempt_at <= $1 AND (p.lease_until IS NULL OR p.lease_until <= $1)
            ORDER BY p.next_attempt_at, p.tenant_id, p.booking_id LIMIT $2 FOR UPDATE OF p SKIP LOCKED)
         UPDATE calendar_pushes p SET lease_until=$3, attempts=p.attempts+1, updated_at=$1
           FROM due, bookings b, calendar_connections c
          WHERE p.tenant_id=due.tenant_id AND p.connection_id=due.connection_id AND p.booking_id=due.booking_id
            AND b.tenant_id=p.tenant_id AND b.id=p.booking_id AND c.tenant_id=p.tenant_id AND c.id=p.connection_id
         RETURNING p.tenant_id, p.connection_id, p.booking_id, c.resource_id, p.google_event_id, p.attempts, p.lease_until,
           b.starts_at, b.ends_at, c.calendar_id, c.refresh_token_sealed`,
        [new Date(at), config.pushLimit, new Date(at + config.leaseMs)])).rows;
    });
    for (const [index, push] of claimed.entries()) {
      if (past(deadline)) {
        // Not attempted: the lease goes back and so does the attempt the claim counted.
        const rest = claimed.slice(index);
        await deps.service((tx) => tx.query(
          `UPDATE calendar_pushes p SET lease_until=NULL, attempts=p.attempts-1
             FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[]) AS u(tenant_id, connection_id, booking_id, lease_until)
            WHERE p.tenant_id=u.tenant_id AND p.connection_id=u.connection_id AND p.booking_id=u.booking_id
              AND p.lease_until=u.lease_until AND p.status='pending'`,
          [rest.map((entry) => entry.tenant_id), rest.map((entry) => entry.connection_id), rest.map((entry) => entry.booking_id),
            rest.map((entry) => entry.lease_until)]));
        break;
      }
      try {
        await pushOne(push, counts, tokens);
      } catch (error) {
        report({ kind: "step_failed", step: "pushes", tenantId: push.tenant_id, connectionId: push.connection_id, error: errorMessage(error) });
      }
    }
    return counts;
  }

  /** The push still holds its lease and its connection is still active. */
  async function stillPushable(push: PushRow): Promise<boolean> {
    const found = await deps.service((tx) => tx.query(
      `SELECT 1 FROM calendar_pushes p
         JOIN calendar_connections c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id AND c.status='active'
        WHERE p.tenant_id=$1 AND p.connection_id=$2 AND p.booking_id=$3 AND p.lease_until=$4 AND p.status='pending'`,
      [push.tenant_id, push.connection_id, push.booking_id, push.lease_until]));
    return found.rowCount === 1;
  }

  async function pushOne(push: PushRow, counts: CalendarRunCounts, tokens: Tokens): Promise<void> {
    let outcome: { status: "pushed" } | { status: "pending" | "failed"; code: string };
    try {
      const access = await accessToken(tokens, { tenant_id: push.tenant_id, id: push.connection_id, refresh_token_sealed: push.refresh_token_sealed });
      // G-10: push only for an active connection. A disconnect during this batch fails the push
      // (G-9) or retires the connection; either way the claimed push is not sent.
      if (!(await stillPushable(push))) {
        counts.lostLeases += 1;
        report({ kind: "lost_lease", tenantId: push.tenant_id, connectionId: push.connection_id, bookingId: push.booking_id });
        return;
      }
      await call((signal) => deps.google.insertEvent(access, push.calendar_id, {
        id: push.google_event_id,
        summary: config.eventTitle,
        start: push.starts_at.toISOString(),
        end: push.ends_at.toISOString(),
        // G-7: a sync of this resource skips the event; one of another resource sharing the calendar blocks it.
        privateProperties: { zs_booking: push.booking_id, zs_tenant: push.tenant_id, zs_resource: push.resource_id },
      }, { signal }));
      outcome = { status: "pushed" };
    } catch (error) {
      const { code, retry } = classify(error);
      if (GRANT_GONE.has(code)) {
        // The push waits for the owner; the connection stops being claimed until then.
        if (await markReauthorize(push.tenant_id, push.connection_id, code, null)) counts.reauthorized += 1;
        outcome = { status: push.attempts >= config.pushMaxAttempts ? "failed" : "pending", code };
      } else {
        // G-10: a 401 means the grant went away mid-pass; the next refresh decides reauthorize.
        const again = retry || (error instanceof GoogleRequestFailed && error.status === 401);
        outcome = { status: again && push.attempts < config.pushMaxAttempts ? "pending" : "failed", code };
      }
    }
    const at = nowMs();
    const recorded = await deps.service((tx) => tx.query(
      `UPDATE calendar_pushes SET status=$5::calendar_push_status, pushed_at=$6, next_attempt_at=$7, last_error=$8,
         lease_until=NULL, updated_at=$9
        WHERE tenant_id=$1 AND connection_id=$2 AND booking_id=$3 AND lease_until=$4 AND status='pending'`,
      [push.tenant_id, push.connection_id, push.booking_id, push.lease_until, outcome.status,
        outcome.status === "pushed" ? new Date(at) : null,
        outcome.status === "pending"
          ? new Date(at + Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.max(0, push.attempts - 1)))
          : new Date(at),
        outcome.status === "pushed" ? null : outcome.code, new Date(at)]));
    if (recorded.rowCount !== 1) {
      counts.lostLeases += 1;
      report({ kind: "lost_lease", tenantId: push.tenant_id, connectionId: push.connection_id, bookingId: push.booking_id });
      return;
    }
    if (outcome.status === "pushed") counts.pushed += 1;
    else {
      if (outcome.status === "pending") counts.pushRetries += 1;
      else counts.pushesFailed += 1;
      report({ kind: "push_failed", tenantId: push.tenant_id, connectionId: push.connection_id, bookingId: push.booking_id,
        code: outcome.code, final: outcome.status === "failed" });
    }
  }

  // ---------------------------------------------------------------- one pass

  /**
   * a. notifications, b. disconnects, c. sync with d. channels, e. pushes; one step's failure stops
   * none of the others. Once `deadline` passes (G-10) the pass claims nothing more, and connections
   * or pushes it claimed but has not started go back.
   */
  async function runOnce(options: { readonly deadline?: Date } = {}): Promise<CalendarRunCounts> {
    const counts = emptyCounts();
    const tokens: Tokens = new Map();
    const { deadline } = options;
    const steps: Array<["notifications" | "disconnects" | "sync" | "pushes", () => Promise<unknown>]> = [
      ["notifications", () => notifications(counts, deadline)],
      ["disconnects", () => disconnects(counts, tokens, deadline)],
      ["sync", () => sync(counts, tokens, deadline)],
      ["pushes", () => pushes(counts, tokens, deadline)],
    ];
    for (const [step, work] of steps) {
      if (past(deadline)) break;
      try {
        await work();
      } catch (error) {
        report({ kind: "step_failed", step, error: errorMessage(error) });
      }
    }
    return counts;
  }

  return { runOnce, notifications, disconnects, sync, pushes, config };
}
export type CalendarWorker = ReturnType<typeof createCalendarWorker>;
