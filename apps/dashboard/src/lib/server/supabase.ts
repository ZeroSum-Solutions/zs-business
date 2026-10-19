/**
 * Supabase Auth on the dashboard server. One client per request, created by authFor(): it
 * reads the session from the request's cookies, refreshes an expiring access token on the
 * server, and records every cookie change so finish() can put it on the response. The
 * cookies are httpOnly and SameSite=Strict (Secure over https): page scripts never see a
 * token, and other sites cannot make the browser send one.
 */
import { createServerClient, parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";
import { isAuthRetryableFetchError, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { isHttps, type LiveConfig } from "./live-config";

/** Cookie name of the Supabase session (chunks are `zs-auth.0`, `zs-auth.1`, ...). */
export const AUTH_COOKIE = "zs-auth";
/** The retired pilot gate's cookie. It opens nothing now; every response that sees one expires it. */
export const PILOT_COOKIE = "zs_dashboard_session";

const isAuthCookie = (name: string) => name === AUTH_COOKIE || name.startsWith(`${AUTH_COOKIE}.`) || name.startsWith(`${AUTH_COOKIE}-`);

/**
 * Set-Cookie values that expire every auth cookie and the pilot cookie the request carries.
 * For when there is no Supabase client to sign out with (live mode not set up).
 */
export function expiredCookies(request: Request, secure: boolean): string[] {
  return parseCookieHeader(request.headers.get("cookie") ?? "")
    .filter((cookie) => isAuthCookie(cookie.name) || cookie.name === PILOT_COOKIE)
    .map((cookie) => serializeCookieHeader(cookie.name, "", { path: "/", sameSite: "strict", httpOnly: true, secure, maxAge: 0 }));
}

/** True when the request carries a Supabase session cookie (not just the retired pilot cookie). */
export function hasSessionCookie(request: Request): boolean {
  return parseCookieHeader(request.headers.get("cookie") ?? "").some((cookie) => isAuthCookie(cookie.name));
}

export interface AuthContext {
  readonly client: SupabaseClient;
  /** True when the browser sent a session cookie or the old pilot cookie: a missing session then "ended". */
  readonly hadSession: boolean;
  /** Expire every auth cookie the browser sent, for example after the API refused the session. */
  clearAll(): void;
  /** Remember the cookie changes so far; the returned function drops any made after it. */
  checkpoint(): () => void;
  /** Put this request's cookie changes on the response. */
  finish(response: Response): Response;
}

export function authFor(request: Request, config: LiveConfig): AuthContext {
  const forced: CookieOptions = { path: "/", sameSite: "strict", httpOnly: true, secure: isHttps(request, config.trustProxy) };
  const sent = parseCookieHeader(request.headers.get("cookie") ?? "");
  const jar = new Map(sent.filter((cookie) => isAuthCookie(cookie.name)).map((cookie) => [cookie.name, cookie.value ?? ""]));
  const writes = new Map<string, string>();
  const headers: Record<string, string> = {};
  const expire = (name: string) => {
    writes.set(name, serializeCookieHeader(name, "", { ...forced, maxAge: 0 }));
    jar.delete(name);
  };
  const hadPilot = sent.some((cookie) => cookie.name === PILOT_COOKIE);
  const hadSession = hadPilot || jar.size > 0;
  if (hadPilot) writes.set(PILOT_COOKIE, serializeCookieHeader(PILOT_COOKIE, "", { ...forced, maxAge: 0 }));

  const client = createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookieOptions: { name: AUTH_COOKIE, ...forced },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll(cookies, cacheHeaders) {
        for (const { name, value, options } of cookies) {
          writes.set(name, serializeCookieHeader(name, value, { ...options, ...forced }));
          if (value && options.maxAge !== 0) jar.set(name, value);
          else jar.delete(name);
        }
        Object.assign(headers, cacheHeaders);
      },
    },
    global: { fetch: config.fetch ?? fetch },
  });

  return {
    client,
    hadSession,
    clearAll() {
      for (const name of [...jar.keys()]) expire(name);
    },
    checkpoint() {
      const [savedJar, savedWrites] = [new Map(jar), new Map(writes)];
      return () => {
        jar.clear();
        writes.clear();
        for (const [name, value] of savedJar) jar.set(name, value);
        for (const [name, value] of savedWrites) writes.set(name, value);
      };
    },
    finish(response) {
      for (const cookie of writes.values()) response.headers.append("Set-Cookie", cookie);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    },
  };
}

export type SessionLookup =
  | { status: "signed_in"; session: Session }
  | { status: "signed_out" }
  /** Supabase Auth could not be reached to refresh the session. */
  | { status: "unavailable" };

/**
 * The browser's session, refreshed on the server when its access token is about to expire.
 * The access token is not verified here: the API verifies it, and checks the session is
 * still live, on every call.
 */
export async function lookupSession(auth: AuthContext): Promise<SessionLookup> {
  const { data, error } = await auth.client.auth.getSession();
  if (data.session) return { status: "signed_in", session: data.session };
  if (error && isAuthRetryableFetchError(error)) return { status: "unavailable" };
  return { status: "signed_out" };
}
