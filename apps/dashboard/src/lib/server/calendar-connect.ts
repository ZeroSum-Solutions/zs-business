/**
 * Binds a Google Calendar connect flow to the browser that started it (google-calendar.md G-1,
 * G-2). When the owner asks to connect, this server keeps a random key in an httpOnly cookie on
 * that browser and sends the API only the key's SHA-256, which the API signs into the OAuth state.
 * Google sends the browser back to this server's callback route (GOOGLE_REDIRECT_URL), which hands
 * the API the state, the code and the cookie's key. A consent URL opened anywhere else carries no
 * key, so it cannot finish the flow with someone else's Google account.
 *
 * Even in the starting browser the callback connects nothing: someone could finish a consent URL
 * with their own Google account and relay the resulting callback URL to the owner. The API stages
 * the grant instead; this server keeps it in a second, Strict cookie, and the Connections page
 * shows the owner the Google account it names. Only the owner's confirmation, a same-origin
 * request with their session, connects it (proxy: GET .../pending, POST .../confirm).
 */
import { createHash, randomBytes } from "node:crypto";
import { parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { CONNECT_BROWSER_KEY_HEADER, PENDING_GRANT_HEADER, PENDING_GRANT_PATTERN } from "@zs/contracts";
import { isHttps, reportSetupProblem, trustProxyFromEnv, type LiveSetup } from "./live-config";
import { isSameOrigin } from "./origin";

/** The cookie holding the browser key. */
export const CONNECT_COOKIE = "zs-calendar-connect";
/** The cookie holding a grant the callback staged, until the owner confirms or discards it. */
export const GRANT_COOKIE = "zs-calendar-grant";
/** Sent with the proxied start and with the callback, both under /api. */
const COOKIE_PATH = "/api";
/** As long as the API's signed state lives (CONNECT_STATE_LIFETIME_MS). */
const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const BROWSER_KEY = /^[A-Za-z0-9_-]{43}$/;
/** Where the owner lands, with `calendar` and `reason` saying what happened. */
export const CONNECT_RETURN_PATH = "/account/connections";
const REASON = /^[a-z_]{1,40}$/;
/** Google's codes and our states stay well under this; anything longer is not from them. */
const MAX_PARAM_LENGTH = 4096;

const isRoute = (path: readonly string[], route: readonly string[]) =>
  path.length === route.length && path.every((segment, index) => segment === route[index]);
const CONNECT_START = ["v1", "calendar", "google", "connect"];
export const isConnectStart = (method: string, path: readonly string[]) => method === "POST" && isRoute(path, CONNECT_START);
/** The proxied routes that read the staged grant. */
const GRANT_READERS = [["GET", ["v1", "calendar", "google", "pending"]], ["POST", ["v1", "calendar", "google", "confirm"]]] as const;
export const readsPendingGrant = (method: string, path: readonly string[]) =>
  GRANT_READERS.some(([verb, route]) => verb === method && isRoute(path, route));

/** The value of the first `name` cookie that has the expected form, so a stray duplicate cannot shadow it. */
function cookieOf(request: Request, name: string, pattern: RegExp): string | undefined {
  return parseCookieHeader(request.headers.get("cookie") ?? "")
    .find((cookie) => cookie.name === name && cookie.value !== undefined && pattern.test(cookie.value))?.value;
}
const browserKeyOf = (request: Request) => cookieOf(request, CONNECT_COOKIE, BROWSER_KEY);
/** The staged grant this browser holds, for the API's PENDING_GRANT_HEADER. */
export const pendingGrantOf = (request: Request) => cookieOf(request, GRANT_COOKIE, PENDING_GRANT_PATTERN);

const grantCookie = (value: string, secure: boolean, maxAge: number) => serializeCookieHeader(GRANT_COOKIE, value, {
  path: COOKIE_PATH,
  httpOnly: true,
  // Strict: only this dashboard's own pages may spend it. The callback sets it on a top-level
  // navigation, which browsers allow; it is read by the page's same-origin requests.
  sameSite: "strict",
  secure,
  maxAge,
});
/** Set-Cookie that drops the staged grant. */
export const expiredGrantCookie = (request: Request, trustProxy: boolean) => grantCookie("", isHttps(request, trustProxy), 0);

/**
 * Set-Cookie values that expire the calendar cookies the request carries: the browser key and any
 * staged grant. Sign-out and a refused session drop them with the session (google-calendar.md G-2).
 */
export function expiredCalendarCookies(request: Request, secure: boolean): string[] {
  const names = new Set(parseCookieHeader(request.headers.get("cookie") ?? "").map((cookie) => cookie.name));
  return [CONNECT_COOKIE, GRANT_COOKIE].filter((name) => names.has(name))
    .map((name) => serializeCookieHeader(name, "", { path: COOKIE_PATH, httpOnly: true, sameSite: name === GRANT_COOKIE ? "strict" : "lax", secure, maxAge: 0 }));
}

/**
 * DELETE /api/calendar/google/pending: drop the staged grant without connecting it (the owner
 * pressed Cancel). Same origin only; repeating it changes nothing.
 */
export function discardPendingGrant(request: Request, setup: LiveSetup | null): Response {
  if (!setup) return Response.json({ error: { code: "NotFound", message: "Not found", details: {} } }, { status: 404, headers: { "Cache-Control": "no-store" } });
  // Dropping a cookie needs none of the live settings, only how to read the request's scheme.
  const trustProxy = setup.ok ? setup.config.trustProxy : trustProxyFromEnv();
  if (request.method !== "DELETE") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "DELETE", "Cache-Control": "no-store" } });
  if (!isSameOrigin(request, trustProxy)) return Response.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  response.headers.append("Set-Cookie", expiredGrantCookie(request, trustProxy));
  return response;
}

export interface BoundStart {
  /** The JSON body to send upstream, with the binding this server chose. */
  readonly body: Uint8Array<ArrayBuffer>;
  /** Set-Cookie for the browser key, for a start the API accepted. */
  readonly cookie: string;
}

/**
 * The connect body with `browserBinding` set from this browser's key: the one it already holds
 * (another tab's flow stays valid) or a new one. Null when the body is not a JSON object; the
 * API validates the rest. A binding the page sent is replaced, never trusted.
 */
export function bindConnectStart(request: Request, bytes: Uint8Array, trustProxy: boolean): BoundStart | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const key = browserKeyOf(request) ?? randomBytes(32).toString("base64url");
  const browserBinding = createHash("sha256").update(key, "ascii").digest("base64url");
  return {
    body: new TextEncoder().encode(JSON.stringify({ ...body, browserBinding })) as Uint8Array<ArrayBuffer>,
    cookie: serializeCookieHeader(CONNECT_COOKIE, key, {
      path: COOKIE_PATH,
      httpOnly: true,
      // Lax, not Strict: the browser must send it on Google's cross-site redirect back here.
      sameSite: "lax",
      secure: isHttps(request, trustProxy),
      maxAge: COOKIE_MAX_AGE_SECONDS,
    }),
  };
}

/** The callback lands in a browser: nothing may cache it, and the code must not leak as a Referer. */
const LANDING_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function landing(outcome: { calendar: "connected" | "confirm" } | { calendar: "error"; reason: string }, cookie?: string): Response {
  const search = new URLSearchParams(outcome);
  const response = new Response(null, { status: 303, headers: { Location: `${CONNECT_RETURN_PATH}?${search}`, ...LANDING_HEADERS } });
  if (cookie !== undefined) response.headers.append("Set-Cookie", cookie);
  return response;
}

/**
 * GET /api/calendar/google/callback: hand Google's answer and this browser's key to the API, and
 * send the owner to the Connections page with the outcome. Only the outcome of the API's redirect
 * is used, never its address, so the owner always lands on this dashboard. A staged grant goes into
 * GRANT_COOKIE, never into the address.
 */
export async function completeGoogleConnect(request: Request, setup: LiveSetup | null): Promise<Response> {
  if (!setup) return Response.json({ error: { code: "NotFound", message: "Not found", details: {} } }, { status: 404, headers: LANDING_HEADERS });
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return landing({ calendar: "error", reason: "unavailable" });
  }
  const config = setup.config;
  const given = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ["state", "code", "error"]) {
    const value = given.get(name);
    if (value !== null) query.set(name, value.slice(0, MAX_PARAM_LENGTH));
  }
  const headers = new Headers({ Accept: "application/json" });
  const key = browserKeyOf(request);
  if (key !== undefined) headers.set(CONNECT_BROWSER_KEY_HEADER, key);

  let upstream: Response;
  try {
    upstream = await (config.fetch ?? fetch)(`${config.apiUrl}/oauth/google/callback?${query}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch {
    return landing({ calendar: "error", reason: "unavailable" });
  }
  // A missing, forged or expired state (G-2).
  if (upstream.status === 400) return landing({ calendar: "error", reason: "invalid_state" });
  const location = upstream.status === 303 ? URL.parse(upstream.headers.get("location") ?? "") : null;
  const calendar = location?.searchParams.get("calendar");
  if (calendar === "connected") return landing({ calendar });
  const grant = upstream.headers.get(PENDING_GRANT_HEADER);
  if (calendar === "confirm" && grant !== null && PENDING_GRANT_PATTERN.test(grant))
    return landing({ calendar }, grantCookie(grant, isHttps(request, config.trustProxy), COOKIE_MAX_AGE_SECONDS));
  const reason = location?.searchParams.get("reason");
  if (calendar === "error" && reason && REASON.test(reason)) return landing({ calendar, reason });
  // Google off on the API (404), an outage, or an answer this page does not know.
  return landing({ calendar: "error", reason: "unavailable" });
}
