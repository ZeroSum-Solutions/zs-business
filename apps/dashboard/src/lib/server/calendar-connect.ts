/**
 * Binds a Google Calendar connect flow to the browser that started it (google-calendar.md G-1,
 * G-2). When the owner asks to connect, this server keeps a random key in an httpOnly cookie on
 * that browser and sends the API only the key's SHA-256, which the API signs into the OAuth state.
 * Google sends the browser back to this server's callback route (GOOGLE_REDIRECT_URL), which hands
 * the API the state, the code and the cookie's key. A consent URL opened anywhere else carries no
 * key, so it cannot finish the flow with someone else's Google account.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { CONNECT_BROWSER_KEY_HEADER } from "@zs/contracts";
import { isHttps, reportSetupProblem, type LiveSetup } from "./live-config";

/** The cookie holding the browser key. */
export const CONNECT_COOKIE = "zs-calendar-connect";
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

const CONNECT_START = ["v1", "calendar", "google", "connect"];
export const isConnectStart = (method: string, path: readonly string[]) =>
  method === "POST" && path.length === CONNECT_START.length && path.every((segment, index) => segment === CONNECT_START[index]);

function browserKeyOf(request: Request): string | undefined {
  const value = parseCookieHeader(request.headers.get("cookie") ?? "").find((cookie) => cookie.name === CONNECT_COOKIE)?.value;
  return value !== undefined && BROWSER_KEY.test(value) ? value : undefined;
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

function landing(outcome: { calendar: "connected" } | { calendar: "error"; reason: string }): Response {
  const search = new URLSearchParams(outcome);
  return new Response(null, { status: 303, headers: { Location: `${CONNECT_RETURN_PATH}?${search}`, ...LANDING_HEADERS } });
}

/**
 * GET /api/calendar/google/callback: hand Google's answer and this browser's key to the API, and
 * send the owner to the Connections page with the outcome. Only the outcome of the API's redirect
 * is used, never its address, so the owner always lands on this dashboard.
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
  const reason = location?.searchParams.get("reason");
  if (calendar === "error" && reason && REASON.test(reason)) return landing({ calendar, reason });
  // Google off on the API (404), an outage, or an answer this page does not know.
  return landing({ calendar: "error", reason: "unavailable" });
}
