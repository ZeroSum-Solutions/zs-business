/**
 * The three cookies of a managed-tier connect flow (docs/requirements/connections.md C-4, C-5). All are
 * httpOnly and sit under /api/connections, so the browser sends them only to the dedicated routes
 * there and never to the generic /api/v1 proxy:
 *
 * - `zs-connect-browser`: a random key that binds the flow to the browser that started it; Lax, so the
 *   provider's redirect back (a cross-site top-level navigation) carries it. 10 minutes.
 * - `zs-connect-attempt`: the API's signed attempt token; Lax, 10 minutes, set only when the API answered 200.
 * - `zs-connect-grant`: the grant the callback staged, until the owner confirms or cancels; Strict, 10 minutes.
 *
 * This module has no session or API code, so supabase.ts can drop all three at sign-out without a cycle.
 */
import { createHash } from "node:crypto";
import { parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { CONNECT_ATTEMPT_PATTERN, CONNECT_GRANT_PATTERN } from "@zs/contracts";

export const BROWSER_COOKIE = "zs-connect-browser";
export const ATTEMPT_COOKIE = "zs-connect-attempt";
export const GRANT_COOKIE = "zs-connect-grant";
export const CONNECTIONS_COOKIE_PATH = "/api/connections";
/** As long as the API's signed attempt and grant live. */
export const CONNECTIONS_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const BROWSER_KEY = /^[A-Za-z0-9_-]{43}$/;

const SAME_SITE = { [BROWSER_COOKIE]: "lax", [ATTEMPT_COOKIE]: "lax", [GRANT_COOKIE]: "strict" } as const;
type CookieName = keyof typeof SAME_SITE;

/** The value of the first `name` cookie that has the expected form, so a stray duplicate cannot shadow it. */
function cookieOf(request: Request, name: string, pattern: RegExp): string | undefined {
  return parseCookieHeader(request.headers.get("cookie") ?? "")
    .find((cookie) => cookie.name === name && cookie.value !== undefined && pattern.test(cookie.value))?.value;
}
export const browserKeyOf = (request: Request) => cookieOf(request, BROWSER_COOKIE, BROWSER_KEY);
export const attemptOf = (request: Request) => cookieOf(request, ATTEMPT_COOKIE, CONNECT_ATTEMPT_PATTERN);
export const grantOf = (request: Request) => cookieOf(request, GRANT_COOKIE, CONNECT_GRANT_PATTERN);

/** The base64url SHA-256 of the browser key: the only form of it the API sees at connect. */
export const bindingOf = (key: string) => createHash("sha256").update(key, "ascii").digest("base64url");

/** Set-Cookie for one connect cookie. */
export const connectCookie = (name: CookieName, value: string, secure: boolean, maxAge = CONNECTIONS_COOKIE_MAX_AGE_SECONDS) =>
  serializeCookieHeader(name, value, { path: CONNECTIONS_COOKIE_PATH, httpOnly: true, sameSite: SAME_SITE[name], secure, maxAge });
/** Set-Cookie that drops one connect cookie, at the path it was set on or the browser keeps it. */
export const expiredConnectCookie = (name: CookieName, secure: boolean) => connectCookie(name, "", secure, 0);

/**
 * Set-Cookie values that expire all three connect cookies. Sign-out and a refused session drop them with
 * the session (C-5): a flow started or a grant staged under it must not outlive it. Unlike the calendar
 * cookies (path /api) these sit under /api/connections, so the browser does not send them to /api/sign-out
 * or to the /api/v1 proxy: the response cannot tell which it holds, and expires all three.
 */
export function expiredConnectionCookies(secure: boolean): string[] {
  return (Object.keys(SAME_SITE) as CookieName[]).map((name) => expiredConnectCookie(name, secure));
}

/**
 * Whether a confirm body names this grant (`grantId` is its token's SHA-256). One naming another grant
 * was shown a grant this one has since replaced: the API refuses it and this grant stays for the page.
 */
export function namesGrant(bytes: Uint8Array | undefined, grant: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  const grantId = body !== null && typeof body === "object" ? (body as { grantId?: unknown }).grantId : undefined;
  return grantId === createHash("sha256").update(grant, "utf8").digest("base64url");
}
