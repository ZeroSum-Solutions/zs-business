// The Google seam over HTTP (docs/requirements/google-calendar.md G-1, G-2, G-6, G-8, G-9,
// G-10). Original code, written from Google's public OAuth 2.0 and Calendar API v3 behaviour in
// our own words. Only the injected fetch is called; nothing here reads the environment or the
// clock. Tokens travel in headers and bodies only and never reach an error message.
import { z } from "zod";
import { secureUrlProblem } from "../edge/auth.js";
import {
  GoogleRequestFailed,
  type GoogleClient,
  type GoogleEvent,
  type GoogleEventPage,
  type GoogleEventTime,
  type GoogleTokenGrant,
  type RequestOptions,
} from "./types.js";

export const GOOGLE_DEFAULT_OAUTH_BASE_URL = "https://accounts.google.com";
export const GOOGLE_DEFAULT_TOKEN_BASE_URL = "https://oauth2.googleapis.com";
export const GOOGLE_DEFAULT_API_BASE_URL = "https://www.googleapis.com";
/** G-1: what the consent screen asks for. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"] as const;
export const GOOGLE_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** G-6: the page size the worker asks for. */
export const GOOGLE_EVENTS_PAGE_SIZE = 250;

/** OAuth answers are a few hundred bytes; an event page of 250 instances stays far below 4 MiB. */
const TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;
const API_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

const secureUrl = (label: string) => z.string().superRefine((value, ctx) => {
  const problem = secureUrlProblem(label, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const googleClientConfigSchema = z.strictObject({
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(512),
  /** Only the API needs it, for the consent URL and the code exchange (G-1, G-2). */
  redirectUrl: secureUrl("redirectUrl").optional(),
  oauthBaseUrl: secureUrl("oauthBaseUrl").default(GOOGLE_DEFAULT_OAUTH_BASE_URL),
  tokenBaseUrl: secureUrl("tokenBaseUrl").default(GOOGLE_DEFAULT_TOKEN_BASE_URL),
  apiBaseUrl: secureUrl("apiBaseUrl").default(GOOGLE_DEFAULT_API_BASE_URL),
});
export type GoogleClientConfig = z.input<typeof googleClientConfigSchema>;
export type ParsedGoogleClientConfig = z.infer<typeof googleClientConfigSchema>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ConfiguredGoogleClient extends GoogleClient {
  readonly config: ParsedGoogleClientConfig;
}

const TOO_LARGE = Symbol("too large");

/** The JSON body, null when empty or not JSON, TOO_LARGE past the limit. A broken stream throws. */
async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * A provider word that may go into an error code: letters and underscores only, so nothing
 * token-shaped (tokens carry digits, dots or slashes) can pass, whatever a response contains.
 */
const word = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z_]{1,60}$/.test(value) ? value.toLowerCase() : null;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const form = (fields: Readonly<Record<string, string>>) => new URLSearchParams(fields).toString();

/** OAuth endpoints answer `{ error, error_description }`. */
function oauthFailure(status: number, body: unknown): GoogleRequestFailed {
  const name = word(record(body)?.error);
  if ((status === 400 || status === 401) && name) return new GoogleRequestFailed(name, false, status);
  const retry = status === 429 || status >= 500;
  return new GoogleRequestFailed(`google_${status}${name ? `_${name}` : ""}`, retry, status);
}

/** Calendar answers `{ error: { code, message, errors: [{ domain, reason }], status } }`. */
function apiFailure(status: number, body: unknown): GoogleRequestFailed {
  const error = record(record(body)?.error);
  const first = Array.isArray(error?.errors) ? record(error.errors[0]) : null;
  const reason = word(first?.reason) ?? word(error?.status);
  // Google reports quota and rate limits as 403 as well as 429; those clear on their own.
  const rateLimited = status === 403 && (reason === "ratelimitexceeded" || reason === "userratelimitexceeded");
  const retry = status === 429 || status >= 500 || rateLimited;
  return new GoogleRequestFailed(`google_${status}${reason ? `_${reason}` : ""}`, retry, status);
}

const unreadable = (status: number) => new GoogleRequestFailed("google_unreadable_response", true, status);
// The same request would get the same oversized answer, so it is not retried.
const tooLarge = (status: number) => new GoogleRequestFailed("google_response_too_large", false, status);

/**
 * The `email` claim of an id_token, or null. The signature is not checked on purpose: the token
 * came back in the body of our own TLS request to Google's token endpoint, authenticated with the
 * client secret, so the channel already proves who issued it (OpenID Connect lets a client rely
 * on that for tokens it gets directly from the token endpoint). The audience must still be this
 * client, and an address Google marks unverified is not used.
 */
function idTokenEmail(idToken: unknown, clientId: string): string | null {
  if (typeof idToken !== "string" || idToken.length > 8192) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  let claims: Record<string, unknown> | null;
  try {
    claims = record(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (!claims) return null;
  const audience = claims.aud;
  if (!(audience === clientId || (Array.isArray(audience) && audience.includes(clientId)))) return null;
  if (claims.email_verified === false || claims.email_verified === "false") return null;
  const email = claims.email;
  return typeof email === "string" && email.length >= 3 && email.length <= 254 && email.includes("@") ? email : null;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(2000).optional(),
  scope: z.string().max(2000).optional(),
  id_token: z.unknown().optional(),
});

const pageSchema = z.object({
  items: z.array(z.unknown()).max(2500).default([]),
  nextPageToken: z.string().min(1).max(4096).optional(),
  nextSyncToken: z.string().min(1).max(4096).optional(),
});

const watchSchema = z.object({
  // calendar_connections.channel_resource_id holds at most 255 characters.
  resourceId: z.string().min(1).max(255),
  expiration: z.union([z.string().regex(/^\d{1,16}$/), z.number().int().nonnegative()]),
});

const str = (value: unknown): value is string => typeof value === "string";

function eventTime(value: unknown): GoogleEventTime | undefined {
  const time = record(value);
  if (!time) return undefined;
  return {
    ...(str(time.dateTime) ? { dateTime: time.dateTime } : {}),
    ...(str(time.date) ? { date: time.date } : {}),
    ...(str(time.timeZone) ? { timeZone: time.timeZone } : {}),
  };
}

/** Keeps only the fields of GoogleEvent, each only when it has the right type; null without an id. */
function pickEvent(value: unknown): GoogleEvent | null {
  const item = record(value);
  if (!item || !str(item.id) || item.id.length === 0 || item.id.length > 1024) return null;
  const start = eventTime(item.start);
  const end = eventTime(item.end);
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.flatMap((entry) => {
      const attendee = record(entry);
      if (!attendee) return [];
      return [{
        ...(typeof attendee.self === "boolean" ? { self: attendee.self } : {}),
        ...(str(attendee.responseStatus) ? { responseStatus: attendee.responseStatus } : {}),
      }];
    })
    : undefined;
  const privateProperties = record(record(item.extendedProperties)?.private);
  return {
    id: item.id,
    ...(str(item.status) ? { status: item.status } : {}),
    ...(str(item.transparency) ? { transparency: item.transparency } : {}),
    ...(str(item.eventType) ? { eventType: item.eventType } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(attendees ? { attendees } : {}),
    ...(privateProperties
      ? { extendedProperties: { private: Object.fromEntries(Object.entries(privateProperties).filter((entry): entry is [string, string] => str(entry[1]))) } }
      : {}),
  };
}

export function createGoogleClient(deps: { readonly config: GoogleClientConfig; readonly fetch?: Fetch }): ConfiguredGoogleClient {
  const parsed = googleClientConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new Error(`Invalid Google config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const config = parsed.data;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const trim = (url: string) => url.replace(/\/+$/, "");
  const oauthBase = trim(config.oauthBaseUrl);
  const tokenBase = trim(config.tokenBaseUrl);
  const apiBase = trim(config.apiBaseUrl);
  const eventsUrl = (calendarId: string) => `${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

  /** One request: the status and the JSON body; a transport failure is google_network (retry). */
  async function send(url: string, init: RequestInit, limit: number, options: RequestOptions | undefined): Promise<{ status: number; body: unknown }> {
    try {
      const response = await doFetch(url, {
        ...init,
        redirect: "manual",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { status: response.status, body: await readJson(response, limit) };
    } catch {
      // The cause is dropped: it could name the URL, and a sync or page token sits in the query.
      throw new GoogleRequestFailed("google_network", true);
    }
  }

  const postForm = (url: string, fields: Readonly<Record<string, string>>, options: RequestOptions | undefined) => send(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form(fields),
  }, TOKEN_RESPONSE_LIMIT_BYTES, options);

  const api = (method: "GET" | "POST", url: string, accessToken: string, json: unknown, options: RequestOptions | undefined) => send(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  }, API_RESPONSE_LIMIT_BYTES, options);

  async function token(fields: Readonly<Record<string, string>>, options: RequestOptions | undefined) {
    const { status, body } = await postForm(`${tokenBase}/token`, { ...fields, client_id: config.clientId, client_secret: config.clientSecret }, options);
    if (body === TOO_LARGE) throw tooLarge(status);
    if (status < 200 || status >= 300) throw oauthFailure(status, body);
    const grant = tokenResponseSchema.safeParse(body);
    if (!grant.success) throw unreadable(status);
    return grant.data;
  }

  return {
    config,

    authorizeUrl({ state, codeChallenge }) {
      if (config.redirectUrl === undefined) throw new Error("Google redirectUrl is not configured");
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUrl,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${oauthBase}/o/oauth2/v2/auth?${query.toString()}`;
    },

    async exchangeCode({ code, codeVerifier }, options): Promise<GoogleTokenGrant> {
      if (config.redirectUrl === undefined) throw new Error("Google redirectUrl is not configured");
      const grant = await token({
        code,
        redirect_uri: config.redirectUrl,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }, options);
      return {
        accessToken: grant.access_token,
        expiresInSeconds: grant.expires_in,
        refreshToken: grant.refresh_token ?? null,
        scope: grant.scope ?? "",
        email: idTokenEmail(grant.id_token, config.clientId),
      };
    },

    async refreshAccessToken(refreshToken, options) {
      const grant = await token({ refresh_token: refreshToken, grant_type: "refresh_token" }, options);
      return { accessToken: grant.access_token, expiresInSeconds: grant.expires_in };
    },

    async revoke(tokenToRevoke, options) {
      const { status, body } = await postForm(`${tokenBase}/revoke`, { token: tokenToRevoke }, options);
      if (status >= 200 && status < 300) return;
      // A token Google no longer knows is as revoked as it gets (G-9).
      if (status === 400 && body !== TOO_LARGE && word(record(body)?.error) === "invalid_token") return;
      if (body === TOO_LARGE) throw tooLarge(status);
      throw oauthFailure(status, body);
    },

    async listEvents(accessToken, query, options): Promise<GoogleEventPage> {
      // showDeleted=true on both kinds of list: an incremental list always carries cancelled
      // events, and Google asks that the other parameters of an incremental list match the full
      // list that produced its sync token. A full list then also shows cancelled instances,
      // which G-7 ignores.
      const params = new URLSearchParams({ singleEvents: "true", maxResults: String(GOOGLE_EVENTS_PAGE_SIZE), showDeleted: "true" });
      const incremental = "syncToken" in query;
      if ("syncToken" in query) params.set("syncToken", query.syncToken);
      else {
        params.set("timeMin", query.timeMin);
        params.set("timeMax", query.timeMax);
      }
      if (query.pageToken !== undefined) params.set("pageToken", query.pageToken);
      const { status, body } = await api("GET", `${eventsUrl(query.calendarId)}?${params.toString()}`, accessToken, undefined, options);
      if (body === TOO_LARGE) throw tooLarge(status);
      // 410 on an incremental list means "start again with a full list" (G-6). On a full list it
      // would mean something else, and mapping it would loop the worker.
      if (status === 410 && incremental) throw new GoogleRequestFailed("sync_token_expired", false, 410);
      if (status < 200 || status >= 300) throw apiFailure(status, body);
      const page = pageSchema.safeParse(body);
      if (!page.success) throw unreadable(status);
      return {
        items: page.data.items.map(pickEvent).filter((event): event is GoogleEvent => event !== null),
        nextPageToken: page.data.nextPageToken ?? null,
        nextSyncToken: page.data.nextPageToken === undefined ? page.data.nextSyncToken ?? null : null,
      };
    },

    async insertEvent(accessToken, calendarId, event, options) {
      const { status, body } = await api("POST", eventsUrl(calendarId), accessToken, {
        id: event.id,
        summary: event.summary,
        start: { dateTime: event.start },
        end: { dateTime: event.end },
        transparency: "opaque",
        extendedProperties: { private: { ...event.privateProperties } },
      }, options);
      if (status >= 200 && status < 300) return "created";
      // The chosen ID is taken: this event was inserted before (G-10).
      if (status === 409) return "exists";
      if (body === TOO_LARGE) throw tooLarge(status);
      throw apiFailure(status, body);
    },

    async watch(accessToken, input, options) {
      const { status, body } = await api("POST", `${eventsUrl(input.calendarId)}/watch`, accessToken, {
        id: input.channelId,
        type: "web_hook",
        address: input.address,
        token: input.token,
      }, options);
      if (body === TOO_LARGE) throw tooLarge(status);
      if (status < 200 || status >= 300) throw apiFailure(status, body);
      const channel = watchSchema.safeParse(body);
      if (!channel.success) throw unreadable(status);
      const expiresAt = Number(channel.data.expiration);
      if (!Number.isSafeInteger(expiresAt)) throw unreadable(status);
      return { resourceId: channel.data.resourceId, expiresAt };
    },

    async stopChannel(accessToken, input, options) {
      const { status, body } = await api("POST", `${apiBase}/calendar/v3/channels/stop`, accessToken, {
        id: input.channelId,
        resourceId: input.resourceId,
      }, options);
      // 404: Google no longer knows the channel (expired or stopped before), which is the goal.
      if ((status >= 200 && status < 300) || status === 404) return;
      if (body === TOO_LARGE) throw tooLarge(status);
      throw apiFailure(status, body);
    },
  };
}
