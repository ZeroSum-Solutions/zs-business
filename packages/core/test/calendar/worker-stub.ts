// An in-memory GoogleClient for the calendar worker tests, plus the database harness they share.
// It models what the worker relies on (G-6..G-10): grants and access tokens, event lists with
// pages and sync tokens (410 once a token expires), idempotent inserts by ID (409 -> exists),
// watch channels and revocation. All data is synthetic; no network.
import { randomUUID } from "node:crypto";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import {
  createCalendarWorker,
  generateSealKeyPair,
  GoogleRequestFailed,
  parseSealPrivateKey,
  parseSealPublicKey,
  sealRefreshToken,
  type CalendarWorkerConfig,
  type CalendarWorkerReport,
  type GoogleClient,
  type GoogleEvent,
  type GoogleEventPage,
  type ListEventsQuery,
} from "../../src/index.js";

export const START = Date.parse("2026-10-20T09:00:00.000Z");
export const CHANNEL_SECRET = "channel-test-secret-0123456789abcdef";
export const WEBHOOK_URL = "https://api.haldenrowe.example/webhooks/google/calendar";
export const CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function manualClock(start = START) {
  let at = start;
  return {
    now: () => new Date(at),
    advance(ms: number) { at += ms; },
    set(instant: number) { at = instant; },
  };
}
export type ManualClock = ReturnType<typeof manualClock>;

type Method = keyof GoogleClient;
interface StoredEvent { event: GoogleEvent; version: number }
interface Account {
  refreshToken: string;
  revoked: boolean;
  version: number;
  /** Sync tokens below this version answer 410. */
  validFrom: number;
  events: Map<string, StoredEvent>;
}

/** A synthetic refresh token; built at runtime so no literal resembles a credential. */
export const fakeRefreshToken = () => ["stub", "refresh", randomUUID().slice(0, 8)].join("-");

export function stubGoogle(clock: ManualClock, options: { pageSize?: number; delayMs?: number } = {}) {
  const accounts = new Map<string, Account>();
  const access = new Map<string, Account>();
  const failures = new Map<Method, Array<GoogleRequestFailed | ((...args: unknown[]) => Promise<void> | void)>>();
  const calls: Array<{ method: Method; args: unknown[] }> = [];
  const channels = new Map<string, { channelId: string; resourceId: string; address: string; token: string; expiresAt: number; stopped: boolean }>();
  let counter = 0;
  const pageSize = options.pageSize ?? 250;

  async function enter(method: Method, args: unknown[]) {
    calls.push({ method, args });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const next = failures.get(method)?.shift();
    if (next instanceof GoogleRequestFailed) throw next;
    if (next) await next(...args);
  }
  const byAccess = (token: string) => {
    const account = access.get(token);
    if (!account || account.revoked) throw new GoogleRequestFailed("google_401_authError", false, 401);
    return account;
  };
  const bump = (account: Account, event: GoogleEvent) => {
    account.version += 1;
    account.events.set(event.id, { event, version: account.version });
  };

  const client: GoogleClient = {
    authorizeUrl: () => "https://accounts.google.test/o/oauth2/v2/auth",
    async exchangeCode() { throw new GoogleRequestFailed("not_in_worker", false); },
    async refreshAccessToken(refreshToken, requestOptions) {
      await enter("refreshAccessToken", [refreshToken, requestOptions]);
      const account = accounts.get(refreshToken);
      if (!account || account.revoked) throw new GoogleRequestFailed("invalid_grant", false, 400);
      counter += 1;
      const token = `stub-access-${counter}`;
      access.set(token, account);
      return { accessToken: token, expiresInSeconds: 3600 };
    },
    async revoke(token, requestOptions) {
      await enter("revoke", [token, requestOptions]);
      const account = accounts.get(token);
      if (account) account.revoked = true;
    },
    async listEvents(accessToken, query: ListEventsQuery, requestOptions): Promise<GoogleEventPage> {
      await enter("listEvents", [accessToken, query, requestOptions]);
      const account = byAccess(accessToken);
      let items: GoogleEvent[];
      if ("syncToken" in query) {
        const since = Number(query.syncToken.replace(/^sync-/, ""));
        if (!Number.isFinite(since) || since < account.validFrom) throw new GoogleRequestFailed("sync_token_expired", false, 410);
        items = [...account.events.values()].filter((stored) => stored.version > since).map((stored) => stored.event);
      } else {
        const min = Date.parse(query.timeMin);
        const max = Date.parse(query.timeMax);
        items = [...account.events.values()].map((stored) => stored.event).filter((event) => {
          if (event.status === "cancelled") return false;
          const start = Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00:00Z`);
          const end = Date.parse(event.end?.dateTime ?? `${event.end?.date}T00:00:00Z`);
          return !(end <= min || start >= max) || Number.isNaN(start) || Number.isNaN(end);
        });
      }
      const offset = query.pageToken ? Number(query.pageToken.replace(/^page-/, "")) : 0;
      const page = items.slice(offset, offset + pageSize);
      const more = offset + pageSize < items.length;
      return {
        items: page,
        nextPageToken: more ? `page-${offset + pageSize}` : null,
        nextSyncToken: more ? null : `sync-${account.version}`,
      };
    },
    async insertEvent(accessToken, calendarId, event, requestOptions) {
      await enter("insertEvent", [accessToken, calendarId, event, requestOptions]);
      const account = byAccess(accessToken);
      if (account.events.has(event.id)) return "exists";
      bump(account, {
        id: event.id, status: "confirmed", transparency: "opaque",
        start: { dateTime: event.start }, end: { dateTime: event.end },
        extendedProperties: { private: { ...event.privateProperties } },
      });
      return "created";
    },
    async watch(accessToken, input, requestOptions) {
      await enter("watch", [accessToken, input, requestOptions]);
      byAccess(accessToken);
      counter += 1;
      const channel = { ...input, resourceId: `stub-resource-${counter}`, expiresAt: clock.now().getTime() + CHANNEL_TTL_MS, stopped: false };
      channels.set(input.channelId, channel);
      return { resourceId: channel.resourceId, expiresAt: channel.expiresAt };
    },
    async stopChannel(accessToken, input, requestOptions) {
      await enter("stopChannel", [accessToken, input, requestOptions]);
      byAccess(accessToken);
      const channel = channels.get(input.channelId);
      if (channel && channel.resourceId === input.resourceId) channel.stopped = true;
    },
  };

  return {
    client,
    calls,
    channels,
    /** A new grant with its own calendar. */
    account(refreshToken = fakeRefreshToken()) {
      accounts.set(refreshToken, { refreshToken, revoked: false, version: 0, validFrom: 0, events: new Map() });
      return refreshToken;
    },
    put(refreshToken: string, event: GoogleEvent) { bump(accounts.get(refreshToken)!, event); },
    /** Google-side cancel: incremental lists see it as cancelled; full lists no longer show it. */
    cancel(refreshToken: string, id: string) {
      const account = accounts.get(refreshToken)!;
      bump(account, { id, status: "cancelled" });
    },
    /** Gone without a trace in incremental lists (as after an expired token). */
    forget(refreshToken: string, id: string) { accounts.get(refreshToken)!.events.delete(id); },
    expireSyncTokens(refreshToken: string) {
      const account = accounts.get(refreshToken)!;
      account.validFrom = account.version + 1;
    },
    revokeGrant(refreshToken: string) { accounts.get(refreshToken)!.revoked = true; },
    isRevoked: (refreshToken: string) => accounts.get(refreshToken)!.revoked,
    events: (refreshToken: string) => [...accounts.get(refreshToken)!.events.values()].map((stored) => stored.event),
    /** The next calls of `method` fail with these errors, or run these hooks, in order. */
    fail(method: Method, ...errors: Array<GoogleRequestFailed | ((...args: unknown[]) => Promise<void> | void)>) {
      failures.set(method, [...(failures.get(method) ?? []), ...errors]);
    },
    count: (method: Method) => calls.filter((entry) => entry.method === method).length,
    of: (method: Method) => calls.filter((entry) => entry.method === method).map((entry) => entry.args),
    reset() { calls.length = 0; failures.clear(); },
  };
}
export type StubGoogle = ReturnType<typeof stubGoogle>;

export interface Resource { tenantId: string; id: string; timeZone: string }

export async function createCalendarHarness() {
  const database: TestDatabase = await createTestDatabase();
  const keys = generateSealKeyPair();
  const publicKey = parseSealPublicKey(keys.publicKey);
  const privateKey = parseSealPrivateKey(keys.privateKey);
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  const rows = async <T = Record<string, any>>(sql: string, params: unknown[] = []) =>
    service(async (tx) => (await tx.query(sql, params)).rows as T[]);

  return {
    database, service, rows, publicKey, privateKey,
    worker(google: StubGoogle, clock: ManualClock, config: Partial<CalendarWorkerConfig> = {}, reports?: CalendarWorkerReport[]) {
      return createCalendarWorker({
        service, google: google.client, clock, generateId: randomUUID,
        config: { privateKey, channelSecret: CHANNEL_SECRET, ...config },
        ...(reports ? { report: (event: CalendarWorkerReport) => { reports.push(event); } } : {}),
      });
    },
    /** Puts every earlier test's connections and pushes out of the workers' reach. */
    async retireAll() {
      await service(async (tx) => {
        await tx.query("UPDATE calendar_connections SET status='reauthorize', lease_until=NULL WHERE status IN ('active','disconnecting')");
        await tx.query("UPDATE calendar_pushes SET status='failed', last_error='test_reset', lease_until=NULL WHERE status='pending'");
        await tx.query("UPDATE calendar_push_notifications SET processed_at=$1 WHERE processed_at IS NULL", [new Date(START)]);
      });
    },
    async tenant() {
      const tenantId = randomUUID();
      await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Halden & Rowe')", [tenantId]));
      return tenantId;
    },
    /** Open every day, all day, 30-minute slots, no buffers or notice. */
    async resource(tenantId: string, timeZone = "UTC"): Promise<Resource> {
      const id = randomUUID();
      const weekly = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] }));
      await service((tx) => tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,$3,$4::jsonb,'[]'::jsonb,30,30,0,0,0,525600)`,
        [tenantId, id, timeZone, JSON.stringify(weekly)]));
      return { tenantId, id, timeZone };
    },
    /** An active connection whose sealed token opens to `refreshToken`. */
    /** Each connection gets its own Google account unless `email` names a shared one (G-9). */
    async connection(resource: Resource, refreshToken: string, at: number, overrides: { sealFor?: string; status?: string; email?: string } = {}) {
      const id = randomUUID();
      const sealed = sealRefreshToken(publicKey, { tenantId: resource.tenantId, connectionId: overrides.sealFor ?? id }, refreshToken);
      await service((tx) => tx.query(
        `INSERT INTO calendar_connections (tenant_id,id,resource_id,calendar_id,account_email,status,refresh_token_sealed,scope,
           created_by,next_sync_at,created_at,updated_at)
         VALUES ($1,$2,$3,'primary',$8,$4,$5,'openid email calendar.events',$6,$7,$7,$7)`,
        [resource.tenantId, id, resource.id, overrides.status ?? "active", sealed, randomUUID(), new Date(at),
          overrides.email ?? `owner+${id.slice(0, 8)}@haldenrowe.example`]));
      return id;
    },
    async booking(resource: Resource, startsAt: string, minutes = 30) {
      const id = randomUUID();
      const endsAt = new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
      await service((tx) => tx.query(
        `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,
           buffer_before_minutes,buffer_after_minutes,status,created_at)
         VALUES ($1,$2,$3,$4,$5,$4,$5,0,0,'confirmed',$6)`,
        [resource.tenantId, id, resource.id, startsAt, endsAt, new Date(START)]));
      return id;
    },
    async blocks(tenantId: string, connectionId?: string) {
      return rows<{ id: string; resource_id: string; external_id: string | null; connection_id: string | null; source: string; starts_at: Date; ends_at: Date }>(
        `SELECT id, resource_id, external_id, connection_id, source, starts_at, ends_at FROM booking_external_blocks
          WHERE tenant_id=$1 AND ($2::uuid IS NULL OR connection_id=$2) ORDER BY starts_at, external_id`,
        [tenantId, connectionId ?? null]);
    },
    async connectionRow(tenantId: string, id: string) {
      return (await rows("SELECT * FROM calendar_connections WHERE tenant_id=$1 AND id=$2", [tenantId, id]))[0]!;
    },
    async push(tenantId: string, bookingId: string) {
      return (await rows("SELECT * FROM calendar_pushes WHERE tenant_id=$1 AND booking_id=$2", [tenantId, bookingId]))[0] as Record<string, any>;
    },
    close: () => database.close(),
  };
}
export type CalendarHarness = Awaited<ReturnType<typeof createCalendarHarness>>;
