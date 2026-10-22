import { randomUUID } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";
import { createFakeGoTrue, memoryAuthStore, type FakeGoTrue, type FakeUser } from "../../e2e/live/fake-gotrue";
import type { LiveConfig, LiveSetup } from "../../src/lib/server/live-config";
import { confirmSignIn, requestSignInLink } from "../../src/lib/server/sign-in";
import { AttemptLimiter } from "../../src/lib/server/rate-limit";

/** Synthetic values, built at runtime so secret scanners do not flag a literal. */
export const SECRET = ["fake", "gotrue", "s".repeat(32)].join("-");
export const ANON_KEY = ["anon", "key", "k".repeat(24)].join("-");
export const ISSUER = "http://supabase.test/auth/v1";
export const SUPABASE_URL = "http://supabase.test";
export const API_URL = "http://api.internal:8787";
export const ORIGIN = "http://127.0.0.1:3218";

export interface UpstreamCall {
  url: string;
  init: RequestInit;
}

export interface LiveHarness {
  gotrue: FakeGoTrue;
  store: ReturnType<typeof memoryAuthStore>;
  owner: FakeUser;
  tenantId: string;
  /** Calls that reached the API. */
  apiCalls: UpstreamCall[];
  /** What the API answers; by default it checks the token and its session like the real one. */
  api: (call: UpstreamCall) => Promise<Response>;
  config: LiveConfig;
  setup: LiveSetup;
}

/** The tenant name the fake API's /v1/me reports. */
export const LIVE_BUSINESS = "Tenant A";

export function createLiveHarness(overrides: { ttlSeconds?: number; trustProxy?: boolean } = {}): LiveHarness {
  const tenantId = randomUUID();
  const owner: FakeUser = { id: randomUUID(), email: "owner@example.com", appMetadata: { tenant_id: tenantId } };
  const store = memoryAuthStore([owner]);
  const gotrue = createFakeGoTrue({ jwtSecret: SECRET, issuer: ISSUER, anonKey: ANON_KEY, store, ttlSeconds: overrides.ttlSeconds ?? 3600 });
  const apiCalls: UpstreamCall[] = [];
  const harness: LiveHarness = {
    gotrue,
    store,
    owner,
    tenantId,
    apiCalls,
    // Like the API: a valid token whose session is live, from a member, gets an answer.
    async api(call) {
      const token = /^Bearer (.+)$/.exec(new Headers(call.init.headers).get("authorization") ?? "")?.[1];
      const claims = token ? await jwtVerify(token, new TextEncoder().encode(SECRET)).then((r) => r.payload, () => null) : null;
      if (!claims || !(await store.sessionIsLive(String(claims.session_id)))) {
        return Response.json({ error: { code: "Unauthorized", message: "Session has ended", details: {} } }, { status: 401 });
      }
      if (new URL(call.url).pathname === "/v1/me") {
        return Response.json({
          tenantId, userId: claims.sub, memberId: randomUUID(), role: "owner", permissions: ["calendar"],
          businessName: LIVE_BUSINESS, email: owner.email,
        });
      }
      return Response.json({ items: [] });
    },
    config: undefined as unknown as LiveConfig,
    setup: undefined as unknown as LiveSetup,
  };
  harness.config = {
    apiUrl: API_URL,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: ANON_KEY,
    trustProxy: overrides.trustProxy ?? false,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin === new URL(SUPABASE_URL).origin) return gotrue.fetch(input, init);
      const call = { url, init: init ?? {} };
      apiCalls.push(call);
      return harness.api(call);
    },
  };
  harness.setup = { ok: true, config: harness.config };
  return harness;
}

/** Cookies a response sets, by name; an expired one maps to null. */
export function setCookies(response: Response): Map<string, { value: string | null; header: string }> {
  const cookies = new Map<string, { value: string | null; header: string }>();
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair!.indexOf("=");
    const name = pair!.slice(0, index).trim();
    const value = pair!.slice(index + 1).trim();
    cookies.set(name, { value: /Max-Age=0\b/i.test(header) || value === "" ? null : value, header });
  }
  return cookies;
}

/** A browser's cookie jar: apply Set-Cookie headers, render a Cookie header. */
export class Jar {
  readonly values = new Map<string, string>();
  apply(response: Response): this {
    for (const [name, cookie] of setCookies(response)) {
      if (cookie.value === null) this.values.delete(name);
      else this.values.set(name, cookie.value);
    }
    return this;
  }
  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export const sameOrigin = (headers: Record<string, string> = {}) => ({
  Host: new URL(ORIGIN).host, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", ...headers,
});

export function linkRequest(email: string, next?: string, headers: Record<string, string> = {}, url = `${ORIGIN}/api/sign-in`): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify({ email, ...(next === undefined ? {} : { next }) }),
    headers: { "Content-Type": "application/json", ...sameOrigin({ Host: new URL(url).host, Origin: new URL(url).origin }), ...headers },
  });
}

/** The whole email-link flow: ask for a link, open it, and return the browser's cookies. */
export async function signInThroughLink(harness: LiveHarness, email = harness.owner.email, next = "/"): Promise<Jar> {
  const asked = await requestSignInLink(linkRequest(email, next), harness.setup, new AttemptLimiter());
  if (asked.status !== 204) throw new Error(`sign-in link request answered ${asked.status}`);
  const jar = new Jar().apply(asked);
  const link = harness.gotrue.lastLink(email);
  if (!link) throw new Error("no link was sent");
  const opened = await confirmSignIn(new Request(link, { headers: { Cookie: jar.header() } }), harness.setup);
  if (opened.status !== 303 || opened.headers.get("location")?.startsWith("/sign-in")) throw new Error("the link did not sign in");
  return jar.apply(opened);
}

/** The access token's claims from the session cookie the proxy forwarded. */
export function forwardedClaims(call: UpstreamCall): { sub: string; session_id: string } {
  const token = /^Bearer (.+)$/.exec(new Headers(call.init.headers).get("authorization") ?? "")?.[1];
  if (!token) throw new Error("no bearer token upstream");
  return decodeJwt(token) as { sub: string; session_id: string };
}
