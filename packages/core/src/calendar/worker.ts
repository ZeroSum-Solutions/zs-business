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
  lostLeases: 0, channelsOpened: 0, channelsStopped: 0, channelFailures: 0, pushesQueued: 0, pushed: 0,
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

  /** One Google call with the configured deadline; anything but a typed failure is retryable. */
  async function call<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GoogleRequestFailed("google_timeout", true));
      }, config.requestTimeoutMs);
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
    error instanceof GoogleRequestFailed ? { code: codeText(error.code), retry: error.retry } : { code: "worker_error", retry: true };

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
  async function notifications(counts: CalendarRunCounts = emptyCounts()): Promise<CalendarRunCounts> {
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

  // ---------------------------------------------------------------- b. disconnects (G-9)

  async function disconnects(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map()): Promise<CalendarRunCounts> {
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
    for (const row of rows) {
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
    // so a revoke would also end a live connection on the same account: the reconnect that
    // replaced this row, or another resource or tenant. Then the grant stays, and only this row
    // lets go of its token.
    const shared = refreshToken !== null && (await deps.service((tx) => tx.query(
      `SELECT 1 FROM calendar_connections other
        WHERE other.status IN ('active', 'reauthorize') AND NOT (other.tenant_id=$1 AND other.id=$2)
          AND ((other.tenant_id=$1 AND other.resource_id=$3)
            OR lower(other.account_email) = (SELECT lower(account_email) FROM calendar_connections WHERE tenant_id=$1 AND id=$2))
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

  async function sync(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map()): Promise<CalendarRunCounts> {
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
    for (const row of rows) {
      const lease = { until: row.lease_until };
      try {
        await syncOne(row, lease, counts, tokens);
      } catch (error) {
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

  async function listAll(access: string, row: ConnectionRow, lease: { until: Date }, syncToken: string | null): Promise<Listing> {
    const at = nowMs();
    const base = syncToken !== null
      ? { calendarId: row.calendar_id, syncToken }
      : { calendarId: row.calendar_id, timeMin: new Date(at - DAY).toISOString(), timeMax: new Date(at + 400 * DAY).toISOString() };
    const events: GoogleEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < config.maxPages; page += 1) {
      const query: ListEventsQuery = pageToken === null ? base : { ...base, pageToken };
      const result: GoogleEventPage = await call((signal) => deps.google.listEvents(access, query, { signal }));
      events.push(...result.items);
      if (!result.nextPageToken) {
        const token = result.nextSyncToken;
        return {
          mode: syncToken !== null ? "incremental" : "full", events, complete: true,
          nextSyncToken: token && token.length <= 2000 ? token : null,
        };
      }
      pageToken = result.nextPageToken;
      await renewLease(row, lease);
    }
    return { mode: syncToken !== null ? "incremental" : "full", events, nextSyncToken: null, complete: false };
  }

  async function syncOne(row: ConnectionRow, lease: { until: Date }, counts: CalendarRunCounts, tokens: Tokens): Promise<void> {
    const access = await accessToken(tokens, row);
    const startedAt = nowMs();
    const incremental = row.sync_token !== null && row.last_full_sync_at !== null
      && startedAt - row.last_full_sync_at.getTime() < config.fullSyncIntervalMs;
    let listing: Listing;
    try {
      listing = await listAll(access, row, lease, incremental ? row.sync_token : null);
    } catch (error) {
      // G-6: an expired sync token means a full list, in this same pass.
      if (!(incremental && error instanceof GoogleRequestFailed && (error.code === "sync_token_expired" || error.status === 410))) throw error;
      listing = await listAll(access, row, lease, null);
    }

    // d. G-8: open or renew the watch channel while the access token is fresh.
    let opened: { id: string; resourceId: string; expiresAt: Date } | null = null;
    if (config.webhookUrl && (row.channel_expires_at === null
      || row.channel_expires_at.getTime() <= nowMs() + config.channelRenewBeforeMs)) {
      // verifyChannelToken (G-8) reads channel IDs in lower case.
      const channelId = deps.generateId().toLowerCase();
      try {
        const watched = await call((signal) => deps.google.watch(access, {
          calendarId: row.calendar_id, channelId, address: config.webhookUrl!, token: channelToken(config.channelSecret, channelId),
        }, { signal }));
        if (typeof watched.resourceId !== "string" || watched.resourceId.length < 1 || watched.resourceId.length > 255
          || !Number.isSafeInteger(watched.expiresAt) || watched.expiresAt <= nowMs()) {
          await stopQuietly(access, channelId, typeof watched.resourceId === "string" ? watched.resourceId : "", counts);
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
      if (opened) await stopQuietly(access, opened.id, opened.resourceId, counts);
      if (applied === "lost") {
        counts.lostLeases += 1;
        report({ kind: "lost_lease", tenantId: row.tenant_id, connectionId: row.id });
      }
      return;
    }
    if (opened) {
      counts.channelsOpened += 1;
      if (row.channel_id !== null && row.channel_resource_id !== null)
        await stopQuietly(access, row.channel_id, row.channel_resource_id, counts);
    }
    counts.synced += 1;
    report({ kind: "synced", tenantId: row.tenant_id, connectionId: row.id, mode: listing.mode, events: listing.events.length, complete: listing.complete });
  }

  async function stopQuietly(access: string, channelId: string, resourceId: string, counts: CalendarRunCounts): Promise<void> {
    if (!resourceId) return;
    try {
      await call((signal) => deps.google.stopChannel(access, { channelId, resourceId }, { signal }));
      counts.channelsStopped += 1;
    } catch { /* the channel expires on its own */ }
  }

  /** G-6, G-7: one transaction under the B-21 lock. */
  async function apply(row: ConnectionRow, lease: Date, listing: Listing,
    opened: { id: string; resourceId: string; expiresAt: Date } | null): Promise<"applied" | "lost" | "inactive"> {
    // Last state per event ID wins; IDs that cannot be stored are skipped.
    const spans = new Map<string, BusySpan | null>();
    for (const event of listing.events) {
      if (typeof event?.id !== "string" || event.id.length < 1 || event.id.length > 1024) continue;
      spans.set(event.id, busySpan(event, row.time_zone));
    }
    const busy = [...spans].filter((entry): entry is [string, BusySpan] => entry[1] !== null);
    const free = [...spans].filter(([, span]) => span === null).map(([id]) => id);
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

  async function pushes(counts: CalendarRunCounts = emptyCounts(), tokens: Tokens = new Map()): Promise<CalendarRunCounts> {
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
         RETURNING p.tenant_id, p.connection_id, p.booking_id, p.google_event_id, p.attempts, p.lease_until,
           b.starts_at, b.ends_at, c.calendar_id, c.refresh_token_sealed`,
        [new Date(at), config.pushLimit, new Date(at + config.leaseMs)])).rows;
    });
    for (const push of claimed) {
      try {
        await pushOne(push, counts, tokens);
      } catch (error) {
        report({ kind: "step_failed", step: "pushes", tenantId: push.tenant_id, connectionId: push.connection_id, error: errorMessage(error) });
      }
    }
    return counts;
  }

  async function pushOne(push: PushRow, counts: CalendarRunCounts, tokens: Tokens): Promise<void> {
    let outcome: { status: "pushed" } | { status: "pending" | "failed"; code: string };
    try {
      const access = await accessToken(tokens, { tenant_id: push.tenant_id, id: push.connection_id, refresh_token_sealed: push.refresh_token_sealed });
      await call((signal) => deps.google.insertEvent(access, push.calendar_id, {
        id: push.google_event_id,
        summary: config.eventTitle,
        start: push.starts_at.toISOString(),
        end: push.ends_at.toISOString(),
        privateProperties: { zs_booking: push.booking_id, zs_tenant: push.tenant_id },
      }, { signal }));
      outcome = { status: "pushed" };
    } catch (error) {
      const { code, retry } = classify(error);
      if (GRANT_GONE.has(code)) {
        // The push waits for the owner; the connection stops being claimed until then.
        if (await markReauthorize(push.tenant_id, push.connection_id, code, null)) counts.reauthorized += 1;
        outcome = { status: push.attempts >= config.pushMaxAttempts ? "failed" : "pending", code };
      } else outcome = { status: retry && push.attempts < config.pushMaxAttempts ? "pending" : "failed", code };
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

  /** a. notifications, b. disconnects, c. sync with d. channels, e. pushes; one step's failure stops none of the others. */
  async function runOnce(): Promise<CalendarRunCounts> {
    const counts = emptyCounts();
    const tokens: Tokens = new Map();
    const steps: Array<["notifications" | "disconnects" | "sync" | "pushes", () => Promise<unknown>]> = [
      ["notifications", () => notifications(counts)],
      ["disconnects", () => disconnects(counts, tokens)],
      ["sync", () => sync(counts, tokens)],
      ["pushes", () => pushes(counts, tokens)],
    ];
    for (const [step, work] of steps) {
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
