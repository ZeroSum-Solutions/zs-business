import { SIGN_IN_ADMIT_PATH, SIGN_IN_WINDOW_MS, signInAdmitBodySchema } from "@zs/contracts";
import { createSharedSignInLimiter, type AttemptLimits, type SignInLimiter } from "../../src/lib/server/rate-limit";

export const LIMITER_SECRET = ["test", "sign-in-limiter", "l".repeat(32)].join("-");
const API_URL = "http://api.internal:8787";

/**
 * Stands in for POST /public/v1/sign-in/admit on the API: the same buckets and all-or-nothing charge as
 * public.rate_limit_take (apps/api/test/sign-in-limit.test.ts runs the real route against Postgres). Every limiter
 * built from one store shares its counts, like dashboard instances sharing the database.
 */
export function sharedLimiterStore() {
  const buckets = new Map<string, { start: number; count: number }>();
  const store = {
    now: Date.parse("2026-10-18T12:00:00.000Z"),
    /** "down": the API answers 503; "unreachable": the request fails. */
    outage: null as null | "down" | "unreachable",
    calls: [] as { url: string; headers: Headers; body: unknown }[],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body: unknown = JSON.parse(String(init?.body));
      store.calls.push({ url: String(input), headers, body });
      if (store.outage === "unreachable") throw new TypeError("fetch failed");
      if (store.outage === "down") return Response.json({ error: { code: "Unavailable" } }, { status: 503, headers: { "Retry-After": "1" } });
      if (String(input) !== `${API_URL}${SIGN_IN_ADMIT_PATH}` || headers.get("authorization") !== `Bearer ${LIMITER_SECRET}`) return new Response(null, { status: 401 });
      const parsed = signInAdmitBodySchema.parse(body);
      const charges = parsed.scope === "address"
        ? [{ key: `address:${parsed.address}`, limit: parsed.perAddress }, { key: "global", limit: parsed.global }]
        : [{ key: `email:${parsed.emailHash}`, limit: parsed.perEmail }];
      let wait = 0;
      for (const { key, limit } of charges) {
        const bucket = buckets.get(key);
        if (bucket && store.now - bucket.start < SIGN_IN_WINDOW_MS && bucket.count >= limit) wait = Math.max(wait, bucket.start + SIGN_IN_WINDOW_MS - store.now);
      }
      if (wait > 0) return Response.json({ error: { code: "RateLimited" } }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } });
      for (const { key } of charges) {
        const bucket = buckets.get(key);
        if (bucket && store.now - bucket.start < SIGN_IN_WINDOW_MS) bucket.count += 1;
        else buckets.set(key, { start: store.now, count: 1 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    /** One dashboard instance's limiter on this store. */
    limiter(limits: Partial<AttemptLimits> = {}, secret: string | null = LIMITER_SECRET): SignInLimiter {
      return createSharedSignInLimiter({
        apiUrl: API_URL,
        secret,
        limits: { perAddress: 5, global: 30, perEmail: 100, ...limits },
        fetch: store.fetch,
      });
    },
  };
  return store;
}
