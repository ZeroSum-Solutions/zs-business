// The Supabase session check: asks GET /auth/v1/user with the caller's token, fails closed when
// Supabase Auth cannot answer, and reuses only live answers, briefly. No database.
import { describe, expect, it } from "vitest";
import {
  AuthUnavailable,
  createSupabaseSessionCheck,
  mapError,
  parseSessionCheckEnv,
  type SessionCheckInput,
} from "../src/index.js";

const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const ACTOR = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const T0 = Date.parse("2026-10-19T08:00:00.000Z");

interface Call { url: string; headers: Headers }

/** A Supabase Auth stand-in: answers each call with the next queued response (or a thrown error). */
function fakeAuth(...answers: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  };
  return { fetch, calls };
}
const user = (fields: Record<string, unknown> = {}) => Response.json({ id: ACTOR, email: "owner@example.com", ...fields });
const refused = (status: number, code: string) => Response.json({ code: status, error_code: code, msg: code }, { status });

function setup(answers: Parameters<typeof fakeAuth>, cacheSeconds = 5) {
  let now = T0;
  const auth = fakeAuth(...answers);
  const check = createSupabaseSessionCheck({
    supabaseUrl: SUPABASE_URL, anonKey: "anon-key", clock: { now: () => new Date(now) }, fetch: auth.fetch, cacheSeconds,
  });
  return { check, calls: auth.calls, advance: (ms: number) => { now += ms; } };
}
const input = (token = "header.payload.sig", expiresAt = T0 / 1000 + 3600): SessionCheckInput =>
  ({ token, tenantId: "t", actorId: ACTOR, sessionId: "s", expiresAt });

describe("Supabase session check", () => {
  it("asks /auth/v1/user with the caller's own token and the anon key", async () => {
    const { check, calls } = setup([user()]);
    expect(await check.isLive(input())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SUPABASE_URL}/auth/v1/user`);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(calls[0]!.headers.get("apikey")).toBe("anon-key");
  });

  it.each([
    [403, "session_not_found"], [401, "bad_jwt"], [403, "user_banned"], [404, "user_not_found"],
  ])("treats %i %s as an ended session", async (status, code) => {
    const { check } = setup([refused(status, code)]);
    expect(await check.isLive(input())).toBe(false);
  });

  it("refuses a user that is not the token's subject, a banned user and a deleted user", async () => {
    expect(await setup([user({ id: "someone-else" })]).check.isLive(input())).toBe(false);
    expect(await setup([user({ banned_until: "2026-10-20T00:00:00Z" })]).check.isLive(input())).toBe(false);
    expect(await setup([user({ banned_until: "2026-10-18T00:00:00Z" })]).check.isLive(input())).toBe(true);
    expect(await setup([user({ deleted_at: "2026-10-18T00:00:00Z" })]).check.isLive(input())).toBe(false);
  });

  it("fails closed with AuthUnavailable (503, never 401) when Supabase Auth cannot answer", async () => {
    const cases: Parameters<typeof fakeAuth>[] = [
      [new TypeError("fetch failed")],
      [new Response("bad gateway", { status: 502 })],
      [new Response("slow down", { status: 429 })],
      [new Response("not json", { status: 200 })],
      [Response.json({ unexpected: true })],
    ];
    for (const answers of cases) {
      const error = await setup(answers).check.isLive(input()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthUnavailable);
      expect(mapError(error)).toMatchObject({ status: 503, body: { error: { code: "Unavailable" } } });
    }
  });

  it("reuses a live answer for the cache window only, and never a refusal", async () => {
    const { check, calls, advance } = setup([user()]);
    expect(await check.isLive(input())).toBe(true);
    advance(4_999);
    expect(await check.isLive(input())).toBe(true);
    expect(calls).toHaveLength(1);
    advance(1);
    expect(await check.isLive(input())).toBe(true);
    expect(calls).toHaveLength(2);

    const ended = setup([refused(403, "session_not_found"), user()]);
    expect(await ended.check.isLive(input())).toBe(false);
    expect(await ended.check.isLive(input())).toBe(true);
    expect(ended.calls).toHaveLength(2);
  });

  it("sees a sign-out once the cached answer runs out, and never caches past the token's exp", async () => {
    const signedOut = setup([user(), refused(403, "session_not_found")]);
    expect(await signedOut.check.isLive(input())).toBe(true);
    signedOut.advance(5_000);
    expect(await signedOut.check.isLive(input())).toBe(false);

    const expiring = setup([user()]);
    expect(await expiring.check.isLive(input("a.b.c", T0 / 1000 + 2))).toBe(true);
    expiring.advance(2_000);
    expect(await expiring.check.isLive(input("a.b.c", T0 / 1000 + 2))).toBe(true);
    expect(expiring.calls).toHaveLength(2);
  });

  it("keys the cache by token: another token is asked about on its own", async () => {
    const { check, calls } = setup([user()]);
    await check.isLive(input("a.b.c"));
    await check.isLive(input("d.e.f"));
    expect(calls).toHaveLength(2);
  });

  it("with a zero cache asks every time", async () => {
    const { check, calls } = setup([user()], 0);
    await check.isLive(input());
    await check.isLive(input());
    expect(calls).toHaveLength(2);
  });

  it("refuses a cache window above 30 seconds", () => {
    expect(() => createSupabaseSessionCheck({ supabaseUrl: SUPABASE_URL, anonKey: "k", clock: { now: () => new Date(T0) }, cacheSeconds: 31 }))
      .toThrow(/0 to 30/);
  });
});

describe("SESSION_CHECK config", () => {
  it("is a required choice", () => {
    expect(() => parseSessionCheckEnv({})).toThrow(/SESSION_CHECK must be supabase or local-stub/);
    expect(() => parseSessionCheckEnv({ SESSION_CHECK: "database" })).toThrow(/SESSION_CHECK/);
    expect(parseSessionCheckEnv({ SESSION_CHECK: "local-stub" })).toEqual({ method: "local-stub" });
  });

  it("supabase needs an https (or loopback http) SUPABASE_URL and the anon key", () => {
    expect(() => parseSessionCheckEnv({ SESSION_CHECK: "supabase" })).toThrow(/SUPABASE_URL is required.*SUPABASE_ANON_KEY is required/);
    for (const url of ["http://abcd.supabase.co", "ftp://abcd.supabase.co", "https://user:pw@abcd.supabase.co", "not a url"])
      expect(() => parseSessionCheckEnv({ SESSION_CHECK: "supabase", SUPABASE_URL: url, SUPABASE_ANON_KEY: "k" })).toThrow(/SUPABASE_URL/);
    expect(parseSessionCheckEnv({ SESSION_CHECK: "supabase", SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "k", SESSION_CACHE_SECONDS: "0" }))
      .toEqual({ method: "supabase", supabaseUrl: "http://127.0.0.1:54321", anonKey: "k", cacheSeconds: 0 });
  });
});
