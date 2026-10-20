// In-process stand-in for the parts of Google this system uses (docs/requirements/google-calendar.md,
// "Provider behaviour"): the OAuth consent redirect, the token and revoke endpoints, and Calendar
// v3 events (list, insert, watch) and channels/stop. Written from the public behaviour in our own
// words. It listens on 127.0.0.1 only, keeps everything in memory, runs on an injected clock and
// plays scripted failures per endpoint, so tests can force every outcome the client classifies.
// Nothing leaves the process except push notifications, which go to the address a test's own
// watch request named.
//
// Usage:
//   const google = await createFakeGoogle({ clock });
//   const client = createGoogleClient({ config: google.clientConfig({ redirectUrl }) });
//   const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: redirectUrl });
//   const { refreshToken, accessToken } = google.issueGrant();      // skip the OAuth dance
//   google.calendar("primary").put({ id: "evt1", start: { dateTime }, end: { dateTime } });
//   google.calendar("primary").remove("evt1");                       // becomes status: cancelled
//   google.expireSyncTokens();                                        // next incremental list: 410
//   google.failNext("list", { status: 503 }, "drop");                 // scripted answers
//   await google.notify(channelId);                                   // push to the watch address
//   await google.close();
//
// Simplifications (documented so tests do not lean on them): every valid access token reaches
// every calendar; all-day dates count as UTC midnights for timeMin/timeMax; an incremental list
// returns every changed event whatever the window of the full list was; recurring events are a
// fake-only `recurrence: { everyMs, count }` expanded into instances when singleEvents=true.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleClientConfig } from "../../src/index.js";

/** Endpoints a script can target. */
export type FakeGoogleEndpoint = "authorize" | "token" | "revoke" | "list" | "insert" | "watch" | "stop";

/**
 * A scripted answer, used instead of the real behaviour for one request to its endpoint:
 * - `{ status, body?, headers? }`: answer this; without a body, Google's error shape for the
 *   endpoint (OAuth `{ error }` or the Calendar envelope with `reason`, default per status);
 * - "drop": destroy the socket without answering;
 * - `{ huge: bytes, status? }`: a JSON body of exactly `bytes` bytes (default status 200);
 * - `{ hold: promise, then? }`: wait for the promise, then act as `then` (default: the real behaviour).
 */
export type FakeGoogleBehaviour =
  | { readonly status: number; readonly body?: unknown; readonly reason?: string; readonly headers?: Readonly<Record<string, string>> }
  | "drop"
  | { readonly huge: number; readonly status?: number }
  | { readonly hold: Promise<void>; readonly then?: FakeGoogleBehaviour; readonly reached?: () => void };

export interface FakeGoogleRequest {
  /** null for a path the fake does not serve (answered 404). */
  readonly endpoint: FakeGoogleEndpoint | null;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: IncomingHttpHeaders;
  readonly raw: string;
  /** Form fields (token, revoke). */
  readonly form: Readonly<Record<string, string>>;
  /** Parsed JSON body (insert, watch, stop), or undefined. */
  readonly json: unknown;
  /** The Bearer token sent, if any. */
  readonly bearer: string | null;
  /** The grant the Bearer token or the refresh token belongs to, if any. */
  readonly grantId: string | null;
  /** The injected clock when the request arrived. */
  readonly at: number;
}

export interface FakeGrant {
  readonly id: string;
  /** null when the code exchange was registered without one. */
  readonly refreshToken: string | null;
  readonly email: string | null;
  readonly scope: string;
  readonly revoked: boolean;
  /** Access tokens minted for this grant, oldest first. */
  readonly accessTokens: readonly string[];
}

export interface FakeEventInput {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly transparency?: string;
  readonly eventType?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly attendees?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>>; readonly shared?: Readonly<Record<string, string>> };
  /** Fake-only recurrence: `count` instances, `everyMs` apart, ids `<id>_<n>` (timed events only). */
  readonly recurrence?: { readonly everyMs: number; readonly count: number };
  readonly [extra: string]: unknown;
}
export type FakeEvent = FakeEventInput & { readonly status: string; readonly updated: string };

export interface FakeCalendar {
  readonly id: string;
  /** Creates or replaces an event (status defaults to confirmed) and logs a change. */
  put(event: FakeEventInput): FakeEvent;
  /** Deletes an event the way Google does: it stays, as status cancelled, and the change is logged. */
  remove(eventId: string): void;
  get(eventId: string): FakeEvent | undefined;
  /** Current events, cancelled ones included, in creation order. */
  events(): FakeEvent[];
  /** Number of changes logged so far (the position a new sync token would carry). */
  readonly position: number;
}

export interface FakeChannel {
  readonly id: string;
  readonly resourceId: string;
  readonly calendarId: string;
  readonly address: string;
  readonly token: string | null;
  /** Unix milliseconds. */
  readonly expiration: number;
  readonly stopped: boolean;
  /** Push notifications sent so far. */
  readonly messages: number;
}

export interface FakeGoogle {
  /** `http://127.0.0.1:<port>`; serves as oauthBaseUrl, tokenBaseUrl and apiBaseUrl. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** A client config pointing every base URL at the fake. */
  clientConfig(over?: Partial<GoogleClientConfig>): GoogleClientConfig;
  /**
   * A code the token endpoint will exchange once, if the verifier hashes to `codeChallenge` and
   * (when given) the redirect URI matches. Expires 10 minutes after registration.
   */
  registerCode(input: {
    readonly codeChallenge: string;
    readonly redirectUri?: string;
    readonly code?: string;
    /** Default `owner-<n>@calendar.test`; null leaves the email claim out. */
    readonly email?: string | null;
    readonly emailVerified?: boolean;
    /** Default the three scopes as Google spells them back. */
    readonly scope?: string;
    /** false: the token response carries no refresh_token. Default true. */
    readonly refreshToken?: boolean;
    /** false: the token response carries no id_token. Default true. */
    readonly idToken?: boolean;
  }): string;
  /**
   * What GET /o/oauth2/v2/auth does next: by default it registers a code for the request's
   * challenge and redirects (302) to redirect_uri with code and state; `deny` redirects with
   * error=access_denied. The other fields are as in registerCode.
   */
  setConsent(consent: { readonly deny?: boolean; readonly email?: string | null; readonly scope?: string; readonly refreshToken?: boolean }): void;
  /** A grant as if the OAuth dance happened, with a fresh access token. */
  issueGrant(input?: { readonly email?: string | null; readonly scope?: string }): { grantId: string; refreshToken: string; accessToken: string };
  /** Revokes from Google's side (the user removed access): the refresh token answers invalid_grant. */
  revokeGrant(token: string): void;
  /** Every access token minted so far stops working. */
  expireAccessTokens(): void;
  grants(): FakeGrant[];
  calendar(calendarId: string): FakeCalendar;
  /** Every sync token issued so far (for one calendar, or all) answers 410 from now on. */
  expireSyncTokens(calendarId?: string): void;
  /** Server-side page size cap (Google may return fewer items than maxResults). */
  setPageSize(size: number): void;
  /** Scripted answers for the next requests to an endpoint, in order. */
  failNext(endpoint: FakeGoogleEndpoint, ...behaviours: FakeGoogleBehaviour[]): void;
  readonly requests: readonly FakeGoogleRequest[];
  /** Requests to one endpoint. */
  requestsTo(endpoint: FakeGoogleEndpoint): FakeGoogleRequest[];
  channels(): FakeChannel[];
  channel(channelId: string): FakeChannel | undefined;
  /**
   * Posts one push notification to the channel's address, with the X-Goog-* headers and no body:
   * state `sync` for the first message, `exists` after (or as given). Resolves with the status
   * the address answered. Stopped or expired channels throw.
   */
  notify(channelId: string, state?: "sync" | "exists" | "not_exists"): Promise<number>;
  /** notify() for every live channel on the calendar. */
  notifyCalendar(calendarId: string): Promise<number[]>;
  close(): Promise<void>;
}

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email openid";
const ACCESS_TOKEN_LIFETIME_SECONDS = 3599;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const CHANNEL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_ID = /^[a-v0-9]{5,1024}$/;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Google's Calendar error envelope. */
export function googleApiError(status: number, reason: string, message = "Scripted failure."): unknown {
  return { error: { code: status, message, errors: [{ domain: "global", reason, message }], status: STATUS_NAMES[status] ?? "UNKNOWN" } };
}
/** Google's OAuth error body. */
export const googleOAuthError = (error: string, description = "Scripted failure.") => ({ error, error_description: description });

const STATUS_NAMES: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 409: "ALREADY_EXISTS",
  410: "GONE", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 502: "UNAVAILABLE", 503: "UNAVAILABLE",
};
const DEFAULT_REASONS: Readonly<Record<number, string>> = {
  400: "invalid", 401: "authError", 403: "forbidden", 404: "notFound", 409: "duplicate", 410: "fullSyncRequired",
  429: "rateLimitExceeded", 500: "backendError", 502: "backendError", 503: "backendError",
};
const DEFAULT_OAUTH_ERRORS: Readonly<Record<number, string>> = {
  400: "invalid_request", 401: "invalid_client", 429: "rate_limit_exceeded", 500: "internal_failure", 503: "temporarily_unavailable",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function endpointOf(method: string, path: string): { endpoint: FakeGoogleEndpoint; calendarId?: string } | null {
  if (path === "/o/oauth2/v2/auth" && method === "GET") return { endpoint: "authorize" };
  if (path === "/token" && method === "POST") return { endpoint: "token" };
  if (path === "/revoke" && method === "POST") return { endpoint: "revoke" };
  if (path === "/calendar/v3/channels/stop" && method === "POST") return { endpoint: "stop" };
  const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(\/watch)?$/.exec(path);
  if (!match) return null;
  let calendarId: string;
  try {
    calendarId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (match[2] && method === "POST") return { endpoint: "watch", calendarId };
  if (!match[2] && method === "GET") return { endpoint: "list", calendarId };
  if (!match[2] && method === "POST") return { endpoint: "insert", calendarId };
  return null;
}

interface MutableGrant {
  id: string;
  refreshToken: string | null;
  email: string | null;
  emailVerified: boolean;
  scope: string;
  revoked: boolean;
  accessTokens: string[];
}
interface CodeRecord {
  challenge: string;
  redirectUri: string | undefined;
  expiresAt: number;
  used: boolean;
  email: string | null;
  emailVerified: boolean;
  scope: string;
  refreshToken: boolean;
  idToken: boolean;
}
interface StoredEvent {
  event: FakeEvent;
  order: number;
}
interface CalendarState {
  events: Map<string, StoredEvent>;
  /** Append-only change log: event IDs in the order they changed. */
  log: string[];
  generation: number;
}
/** One rendered list item: an event, or an instance of a fake-recurring one. */
interface ItemKey {
  readonly eventId: string;
  readonly instance: number | null;
}
interface PageCursor {
  readonly calendarId: string;
  readonly keys: readonly ItemKey[];
  readonly offset: number;
  readonly syncPosition: number;
  readonly generation: number;
  readonly singleEvents: boolean;
}

const instanceTime = (time: FakeEventInput["start"], shift: number) =>
  time?.dateTime === undefined ? time : { ...time, dateTime: new Date(Date.parse(time.dateTime) + shift).toISOString() };

function timeOf(time: FakeEventInput["start"]): number | null {
  if (!time) return null;
  if (time.dateTime !== undefined) return Date.parse(time.dateTime);
  if (time.date !== undefined) return Date.parse(`${time.date}T00:00:00Z`);
  return null;
}

export async function createFakeGoogle(options: {
  readonly clock: { now(): Date };
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly accessTokenLifetimeSeconds?: number;
  readonly channelLifetimeMs?: number;
}): Promise<FakeGoogle> {
  const now = () => options.clock.now().getTime();
  const clientId = options.clientId ?? `${hex(6)}-fake.apps.googleusercontent.test`;
  const clientSecret = options.clientSecret ?? `fake-client-secret-${hex(12)}`;
  const accessLifetime = options.accessTokenLifetimeSeconds ?? ACCESS_TOKEN_LIFETIME_SECONDS;
  const channelLifetime = options.channelLifetimeMs ?? CHANNEL_LIFETIME_MS;

  const requests: FakeGoogleRequest[] = [];
  const scripts = new Map<FakeGoogleEndpoint, FakeGoogleBehaviour[]>();
  const grants = new Map<string, MutableGrant>();
  const byRefresh = new Map<string, MutableGrant>();
  const byAccess = new Map<string, { grant: MutableGrant; expiresAt: number }>();
  const codes = new Map<string, CodeRecord>();
  const calendars = new Map<string, CalendarState>();
  const pages = new Map<string, PageCursor>();
  const channels = new Map<string, { id: string; resourceId: string; calendarId: string; address: string; token: string | null; expiration: number; stopped: boolean; messages: number }>();
  let consent: { deny?: boolean; email?: string | null; scope?: string; refreshToken?: boolean } = {};
  let pageSize = 2500;
  let emails = 0;
  let order = 0;

  const nextEmail = () => `owner-${++emails}@calendar.test`;

  function state(calendarId: string): CalendarState {
    let found = calendars.get(calendarId);
    if (!found) {
      found = { events: new Map(), log: [], generation: 0 };
      calendars.set(calendarId, found);
    }
    return found;
  }

  function newGrant(input: { email: string | null; emailVerified: boolean; scope: string; refreshToken: boolean }): MutableGrant {
    const grant: MutableGrant = {
      id: `grant-${hex(6)}`,
      refreshToken: input.refreshToken ? `fake-rt.${hex(24)}` : null,
      email: input.email,
      emailVerified: input.emailVerified,
      scope: input.scope,
      revoked: false,
      accessTokens: [],
    };
    grants.set(grant.id, grant);
    if (grant.refreshToken) byRefresh.set(grant.refreshToken, grant);
    return grant;
  }
  function mintAccess(grant: MutableGrant): string {
    const token = `fake-at.${hex(24)}`;
    grant.accessTokens.push(token);
    byAccess.set(token, { grant, expiresAt: now() + accessLifetime * 1000 });
    return token;
  }
  function revoke(grant: MutableGrant): void {
    grant.revoked = true;
  }
  function liveAccess(bearer: string | null): MutableGrant | null {
    if (!bearer) return null;
    const found = byAccess.get(bearer);
    if (!found || found.grant.revoked || now() >= found.expiresAt) return null;
    return found.grant;
  }

  function idToken(grant: MutableGrant): string {
    const issued = Math.floor(now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: clientId,
      azp: clientId,
      sub: grant.id,
      ...(grant.email === null ? {} : { email: grant.email, email_verified: grant.emailVerified }),
      iat: issued,
      exp: issued + 3600,
    };
    return `${b64url({ alg: "RS256", kid: "fake", typ: "JWT" })}.${b64url(claims)}.${Buffer.from("fake-signature").toString("base64url")}`;
  }

  function putEvent(calendarId: string, input: FakeEventInput): FakeEvent {
    const calendar = state(calendarId);
    const existing = calendar.events.get(input.id);
    const event: FakeEvent = { ...input, status: input.status ?? "confirmed", updated: new Date(now()).toISOString() };
    calendar.events.set(input.id, { event, order: existing?.order ?? ++order });
    calendar.log.push(input.id);
    return event;
  }

  function calendarApi(calendarId: string): FakeCalendar {
    const calendar = state(calendarId);
    return {
      id: calendarId,
      put: (event) => putEvent(calendarId, event),
      remove(eventId) {
        const found = calendar.events.get(eventId);
        if (!found) throw new Error(`fake Google: no event ${eventId} in ${calendarId}`);
        putEvent(calendarId, { ...found.event, status: "cancelled" });
      },
      get: (eventId) => calendar.events.get(eventId)?.event,
      events: () => [...calendar.events.values()].sort((a, b) => a.order - b.order).map((stored) => stored.event),
      get position() { return calendar.log.length; },
    };
  }

  /** The item keys of one event: itself, or its instances when expanded. */
  function keysOf(event: FakeEvent, singleEvents: boolean): ItemKey[] {
    if (!event.recurrence || !singleEvents) return [{ eventId: event.id, instance: null }];
    return Array.from({ length: event.recurrence.count }, (_, instance) => ({ eventId: event.id, instance }));
  }

  /** The JSON Google would send for one key, as the event stands now. */
  function render(calendarId: string, key: ItemKey): Record<string, unknown> | null {
    const stored = state(calendarId).events.get(key.eventId);
    if (!stored) return null;
    const { recurrence, ...event } = stored.event;
    if (key.instance === null) return { kind: "calendar#event", ...event, ...(recurrence ? { recurrence: [`FAKE;EVERY=${recurrence.everyMs};COUNT=${recurrence.count}`] } : {}) };
    if (!recurrence || key.instance >= recurrence.count) return null;
    const shift = key.instance * recurrence.everyMs;
    return {
      kind: "calendar#event",
      ...event,
      id: `${event.id}_${key.instance}`,
      recurringEventId: event.id,
      start: instanceTime(event.start, shift),
      end: instanceTime(event.end, shift),
    };
  }

  function overlaps(item: Record<string, unknown>, timeMin: number | null, timeMax: number | null): boolean {
    const start = timeOf(item.start as FakeEventInput["start"]);
    const end = timeOf(item.end as FakeEventInput["end"]);
    if (timeMin !== null && end !== null && end <= timeMin) return false;
    if (timeMax !== null && start !== null && start >= timeMax) return false;
    return true;
  }

  const syncToken = (calendarId: string, position: number, generation: number) => `fake-sync.${b64url({ c: calendarId, p: position, g: generation })}`;
  function readSyncToken(token: string): { c: string; p: number; g: number } | null {
    if (!token.startsWith("fake-sync.")) return null;
    try {
      const value = JSON.parse(Buffer.from(token.slice("fake-sync.".length), "base64url").toString("utf8")) as { c?: unknown; p?: unknown; g?: unknown };
      if (typeof value.c !== "string" || typeof value.p !== "number" || typeof value.g !== "number") return null;
      return { c: value.c, p: value.p, g: value.g };
    } catch {
      return null;
    }
  }

  type Answer = { status: number; body?: unknown; headers?: Readonly<Record<string, string>> };
  const apiError = (status: number, reason: string, message: string): Answer => ({ status, body: googleApiError(status, reason, message) });
  const oauthError = (status: number, error: string, description: string): Answer => ({ status, body: googleOAuthError(error, description) });

  function list(calendarId: string, query: Readonly<Record<string, string>>): Answer {
    const singleEvents = query.singleEvents === "true";
    const max = Math.max(1, Math.min(Number(query.maxResults ?? "250") || 250, 2500, pageSize));
    let cursor: PageCursor;
    if (query.pageToken !== undefined) {
      const found = pages.get(query.pageToken);
      if (!found || found.calendarId !== calendarId) return apiError(400, "invalid", "Invalid page token value.");
      cursor = found;
    } else if (query.syncToken !== undefined) {
      if (query.timeMin !== undefined || query.timeMax !== undefined)
        return apiError(400, "invalid", "Sync token cannot be combined with timeMin or timeMax.");
      if (query.showDeleted === "false") return apiError(400, "invalid", "showDeleted cannot be false with a sync token.");
      const token = readSyncToken(query.syncToken);
      if (!token || token.c !== calendarId) return apiError(400, "invalid", "Invalid sync token value.");
      const calendar = state(calendarId);
      if (token.g < calendar.generation || token.p > calendar.log.length)
        return apiError(410, "fullSyncRequired", "Sync token is no longer valid, a full sync is required.");
      const changed = [...new Set(calendar.log.slice(token.p))];
      const keys = changed.flatMap((eventId) => keysOf(calendar.events.get(eventId)!.event, singleEvents));
      cursor = { calendarId, keys, offset: 0, syncPosition: calendar.log.length, generation: calendar.generation, singleEvents };
    } else {
      const calendar = state(calendarId);
      const timeMin = query.timeMin === undefined ? null : Date.parse(query.timeMin);
      const timeMax = query.timeMax === undefined ? null : Date.parse(query.timeMax);
      if (Number.isNaN(timeMin) || Number.isNaN(timeMax)) return apiError(400, "badRequest", "Bad Request");
      const showDeleted = query.showDeleted === "true";
      const keys = [...calendar.events.values()]
        .sort((a, b) => a.order - b.order)
        .flatMap((stored) => keysOf(stored.event, singleEvents))
        .filter((key) => {
          const item = render(calendarId, key);
          return item !== null && (showDeleted || item.status !== "cancelled") && overlaps(item, timeMin, timeMax);
        });
      cursor = { calendarId, keys, offset: 0, syncPosition: calendar.log.length, generation: calendar.generation, singleEvents };
    }
    const slice = cursor.keys.slice(cursor.offset, cursor.offset + max);
    const items = slice.map((key) => render(calendarId, key)).filter((item) => item !== null);
    const nextOffset = cursor.offset + slice.length;
    const body: Record<string, unknown> = { kind: "calendar#events", summary: calendarId, timeZone: "UTC", items };
    if (nextOffset < cursor.keys.length) {
      const pageToken = `fake-page.${hex(12)}`;
      pages.set(pageToken, { ...cursor, offset: nextOffset });
      body.nextPageToken = pageToken;
    } else {
      body.nextSyncToken = syncToken(calendarId, cursor.syncPosition, cursor.generation);
    }
    return { status: 200, body };
  }

  function insert(calendarId: string, json: unknown): Answer {
    const input = json as Partial<FakeEventInput> | null;
    if (!input || typeof input !== "object") return apiError(400, "parseError", "Parse Error");
    if (timeOf(input.start) === null || timeOf(input.end) === null) return apiError(400, "required", "Missing time.");
    const id = input.id ?? hex(13);
    if (typeof id !== "string" || !EVENT_ID.test(id)) return apiError(400, "invalid", "Invalid resource id value.");
    if (state(calendarId).events.has(id)) return apiError(409, "duplicate", "The requested identifier already exists.");
    const event = putEvent(calendarId, { ...input, id } as FakeEventInput);
    return { status: 200, body: { kind: "calendar#event", ...event } };
  }

  function watch(calendarId: string, json: unknown): Answer {
    const input = json as { id?: unknown; type?: unknown; address?: unknown; token?: unknown } | null;
    if (!input || typeof input.id !== "string" || input.id.length === 0) return apiError(400, "required", "Channel id is required.");
    if (input.type !== "web_hook") return apiError(400, "invalid", "Unknown channel type.");
    if (typeof input.address !== "string" || !/^https?:\/\//.test(input.address)) return apiError(400, "invalid", "Invalid address.");
    if (channels.has(input.id)) return apiError(400, "channelIdNotUnique", "Channel id not unique.");
    const channel = {
      id: input.id,
      resourceId: `fake-resource-${hex(8)}`,
      calendarId,
      address: input.address,
      token: typeof input.token === "string" ? input.token : null,
      expiration: now() + channelLifetime,
      stopped: false,
      messages: 0,
    };
    channels.set(channel.id, channel);
    return {
      status: 200,
      body: {
        kind: "api#channel",
        id: channel.id,
        resourceId: channel.resourceId,
        resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?alt=json`,
        ...(channel.token === null ? {} : { token: channel.token }),
        expiration: String(channel.expiration),
      },
    };
  }

  function stop(json: unknown): Answer {
    const input = json as { id?: unknown; resourceId?: unknown } | null;
    const channel = input && typeof input.id === "string" ? channels.get(input.id) : undefined;
    if (!channel || channel.stopped || channel.resourceId !== input?.resourceId)
      return apiError(404, "notFound", `Channel '${typeof input?.id === "string" ? input.id : ""}' not found for project.`);
    channel.stopped = true;
    return { status: 204 };
  }

  function token(form: Readonly<Record<string, string>>): Answer {
    if (form.client_id !== clientId || form.client_secret !== clientSecret)
      return oauthError(401, "invalid_client", "The OAuth client was not found.");
    if (form.grant_type === "authorization_code") {
      const code = form.code === undefined ? undefined : codes.get(form.code);
      if (!code || code.used || now() >= code.expiresAt) return oauthError(400, "invalid_grant", "Malformed auth code.");
      if (code.redirectUri !== undefined && form.redirect_uri !== code.redirectUri)
        return oauthError(400, "redirect_uri_mismatch", "Bad Request");
      if (!form.code_verifier) return oauthError(400, "invalid_grant", "Missing code verifier.");
      if (createHash("sha256").update(form.code_verifier).digest("base64url") !== code.challenge)
        return oauthError(400, "invalid_grant", "Invalid code verifier.");
      code.used = true;
      const grant = newGrant({ email: code.email, emailVerified: code.emailVerified, scope: code.scope, refreshToken: code.refreshToken });
      return {
        status: 200,
        body: {
          access_token: mintAccess(grant),
          expires_in: accessLifetime,
          ...(grant.refreshToken === null ? {} : { refresh_token: grant.refreshToken }),
          scope: grant.scope,
          token_type: "Bearer",
          ...(code.idToken ? { id_token: idToken(grant) } : {}),
        },
      };
    }
    if (form.grant_type === "refresh_token") {
      const grant = form.refresh_token === undefined ? undefined : byRefresh.get(form.refresh_token);
      if (!grant || grant.revoked) return oauthError(400, "invalid_grant", "Token has been expired or revoked.");
      return { status: 200, body: { access_token: mintAccess(grant), expires_in: accessLifetime, scope: grant.scope, token_type: "Bearer" } };
    }
    return oauthError(400, "unsupported_grant_type", "Invalid grant_type.");
  }

  function revokeEndpoint(form: Readonly<Record<string, string>>, query: Readonly<Record<string, string>>): Answer {
    const value = form.token ?? query.token;
    const grant = value === undefined ? undefined : byRefresh.get(value) ?? byAccess.get(value)?.grant;
    if (!grant || grant.revoked) return oauthError(400, "invalid_token", "Token expired or revoked");
    revoke(grant);
    return { status: 200, body: {} };
  }

  function authorize(query: Readonly<Record<string, string>>): Answer {
    if (query.client_id !== clientId) return { status: 400, body: "Error 401: invalid_client" };
    const redirect = URL.parse(query.redirect_uri ?? "");
    if (!redirect) return { status: 400, body: "Error 400: redirect_uri_mismatch" };
    if (query.response_type !== "code" || query.code_challenge_method !== "S256" || !query.code_challenge)
      return { status: 400, body: "Error 400: invalid_request" };
    if (query.state !== undefined) redirect.searchParams.set("state", query.state);
    if (consent.deny) {
      redirect.searchParams.set("error", "access_denied");
    } else {
      const code = registerCode({
        codeChallenge: query.code_challenge,
        redirectUri: query.redirect_uri!,
        ...(consent.email === undefined ? {} : { email: consent.email }),
        ...(consent.scope === undefined ? {} : { scope: consent.scope }),
        ...(consent.refreshToken === undefined ? {} : { refreshToken: consent.refreshToken }),
      });
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("scope", consent.scope ?? DEFAULT_SCOPE);
    }
    return { status: 302, headers: { location: redirect.toString() } };
  }

  const registerCode: FakeGoogle["registerCode"] = (input) => {
    const code = input.code ?? `fake-code.${hex(16)}`;
    codes.set(code, {
      challenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAt: now() + CODE_LIFETIME_MS,
      used: false,
      email: input.email === undefined ? nextEmail() : input.email,
      emailVerified: input.emailVerified ?? true,
      scope: input.scope ?? DEFAULT_SCOPE,
      refreshToken: input.refreshToken ?? true,
      idToken: input.idToken ?? true,
    });
    return code;
  };

  function real(endpoint: FakeGoogleEndpoint, calendarId: string | undefined, request: FakeGoogleRequest): Answer {
    switch (endpoint) {
      case "authorize": return authorize(request.query);
      case "token": return token(request.form);
      case "revoke": return revokeEndpoint(request.form, request.query);
      default: break;
    }
    if (!liveAccess(request.bearer)) return apiError(401, "authError", "Invalid Credentials");
    switch (endpoint) {
      case "list": return list(calendarId!, request.query);
      case "insert": return insert(calendarId!, request.json);
      case "watch": return watch(calendarId!, request.json);
      default: return stop(request.json);
    }
  }

  function scripted(endpoint: FakeGoogleEndpoint, behaviour: Extract<FakeGoogleBehaviour, { status: number }>): Answer {
    if (behaviour.body !== undefined) return { status: behaviour.status, body: behaviour.body, ...(behaviour.headers ? { headers: behaviour.headers } : {}) };
    const oauth = endpoint === "token" || endpoint === "revoke" || endpoint === "authorize";
    const body = oauth
      ? googleOAuthError(behaviour.reason ?? DEFAULT_OAUTH_ERRORS[behaviour.status] ?? "server_error")
      : googleApiError(behaviour.status, behaviour.reason ?? DEFAULT_REASONS[behaviour.status] ?? "unknown");
    return { status: behaviour.status, body, ...(behaviour.headers ? { headers: behaviour.headers } : {}) };
  }

  async function act(
    behaviour: FakeGoogleBehaviour | undefined,
    route: { endpoint: FakeGoogleEndpoint; calendarId?: string },
    request: FakeGoogleRequest,
    res: ServerResponse,
  ): Promise<void> {
    if (behaviour === undefined) {
      const answer = real(route.endpoint, route.calendarId, request);
      return send(res, answer.status, answer.body, answer.headers);
    }
    if (behaviour === "drop") {
      res.socket?.destroy();
      return;
    }
    if ("hold" in behaviour) {
      behaviour.reached?.();
      await behaviour.hold;
      return act(behaviour.then, route, request, res);
    }
    if ("huge" in behaviour) {
      const head = "{\"items\":[],\"pad\":\"";
      return send(res, behaviour.status ?? 200, `${head}${"a".repeat(Math.max(0, behaviour.huge - head.length - 2))}"}`);
    }
    const answer = scripted(route.endpoint, behaviour);
    return send(res, answer.status, answer.body, answer.headers);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    void (async () => {
      const raw = await readBody(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "";
      const route = endpointOf(method, url.pathname);
      const contentType = String(req.headers["content-type"] ?? "");
      const formFields = contentType.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : {};
      let json: unknown;
      if (contentType.startsWith("application/json")) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = undefined;
        }
      }
      const auth = req.headers.authorization;
      const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
      const refresh = formFields.refresh_token === undefined ? undefined : byRefresh.get(formFields.refresh_token);
      const request: FakeGoogleRequest = {
        endpoint: route?.endpoint ?? null,
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        raw,
        form: formFields,
        json,
        bearer,
        grantId: (bearer === null ? undefined : byAccess.get(bearer)?.grant.id) ?? refresh?.id ?? null,
        at: now(),
      };
      requests.push(request);
      if (!route) return send(res, 404, googleApiError(404, "notFound", "Not Found"));
      return act(scripts.get(route.endpoint)?.shift(), route, request, res);
    })().catch(() => { res.socket?.destroy(); });
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const snapshotChannel = (channel: NonNullable<ReturnType<typeof channels.get>>): FakeChannel => ({ ...channel });

  async function notify(channelId: string, stateName?: "sync" | "exists" | "not_exists"): Promise<number> {
    const channel = channels.get(channelId);
    if (!channel) throw new Error(`fake Google: no channel ${channelId}`);
    if (channel.stopped || now() >= channel.expiration) throw new Error(`fake Google: channel ${channelId} is closed`);
    const number = ++channel.messages;
    const response = await fetch(channel.address, {
      method: "POST",
      redirect: "manual",
      headers: {
        "X-Goog-Channel-ID": channel.id,
        ...(channel.token === null ? {} : { "X-Goog-Channel-Token": channel.token }),
        "X-Goog-Channel-Expiration": new Date(channel.expiration).toUTCString(),
        "X-Goog-Resource-ID": channel.resourceId,
        "X-Goog-Resource-URI": `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(channel.calendarId)}/events?alt=json`,
        "X-Goog-Resource-State": stateName ?? (number === 1 ? "sync" : "exists"),
        "X-Goog-Message-Number": String(number),
      },
    });
    await response.arrayBuffer().catch(() => {});
    return response.status;
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    clientConfig: (over = {}) => ({ clientId, clientSecret, oauthBaseUrl: baseUrl, tokenBaseUrl: baseUrl, apiBaseUrl: baseUrl, ...over }),
    registerCode,
    setConsent(next) { consent = { ...next }; },
    issueGrant(input = {}) {
      const grant = newGrant({ email: input.email === undefined ? nextEmail() : input.email, emailVerified: true, scope: input.scope ?? DEFAULT_SCOPE, refreshToken: true });
      return { grantId: grant.id, refreshToken: grant.refreshToken!, accessToken: mintAccess(grant) };
    },
    revokeGrant(value) {
      const grant = byRefresh.get(value) ?? byAccess.get(value)?.grant;
      if (!grant) throw new Error("fake Google: unknown token");
      revoke(grant);
    },
    expireAccessTokens() {
      for (const entry of byAccess.values()) entry.expiresAt = Math.min(entry.expiresAt, now());
    },
    grants: () => [...grants.values()].map((grant) => ({
      id: grant.id, refreshToken: grant.refreshToken, email: grant.email, scope: grant.scope, revoked: grant.revoked, accessTokens: [...grant.accessTokens],
    })),
    calendar: calendarApi,
    expireSyncTokens(calendarId) {
      for (const [id, calendar] of calendars) if (calendarId === undefined || id === calendarId) calendar.generation += 1;
    },
    setPageSize(size) {
      if (!Number.isInteger(size) || size < 1) throw new Error("fake Google: page size must be a positive integer");
      pageSize = size;
    },
    failNext(endpoint, ...behaviours) {
      const script = scripts.get(endpoint) ?? [];
      script.push(...behaviours);
      scripts.set(endpoint, script);
    },
    requests,
    requestsTo: (endpoint) => requests.filter((request) => request.endpoint === endpoint),
    channels: () => [...channels.values()].map(snapshotChannel),
    channel(channelId) {
      const channel = channels.get(channelId);
      return channel ? snapshotChannel(channel) : undefined;
    },
    notify,
    async notifyCalendar(calendarId) {
      const live = [...channels.values()].filter((channel) => channel.calendarId === calendarId && !channel.stopped && now() < channel.expiration);
      const statuses: number[] = [];
      for (const channel of live) statuses.push(await notify(channel.id));
      return statuses;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
