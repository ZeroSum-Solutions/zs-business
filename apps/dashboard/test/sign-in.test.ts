import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { AttemptLimiter, checkSessionValue, SESSION_COOKIE, type PilotGateConfig } from "../src/lib/server/pilot-gate";
import { signIn, signOut } from "../src/lib/server/sign-in";
import { GATE } from "./helpers/gate";

const ORIGIN = "http://127.0.0.1:3218";
const NOW = new Date("2026-10-18T12:00:00.000Z");
const LIMITS = { windowMs: 15 * 60 * 1000, perAddress: 5, global: 30 };

function attempt(code: string, headers: Record<string, string> = {}, url = `${ORIGIN}/api/sign-in`) {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify({ code }),
    headers: { "Content-Type": "application/json", Host: new URL(url).host, Origin: new URL(url).origin, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "203.0.113.7", ...headers },
  });
}

const setup = (config: PilotGateConfig = GATE) => ({ ok: true as const, config });
const cookieValue = (response: Response) => /^zs_dashboard_session=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;

describe("pilot sign-in", () => {
  it("refuses a wrong code with 401 and sets no cookie", async () => {
    const response = await signIn(attempt("not-the-code-at-all"), setup(), new AttemptLimiter(LIMITS), NOW);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "wrong_code" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sets an httpOnly, SameSite=Strict, signed and expiring cookie for the right code", async () => {
    const response = await signIn(attempt(GATE.accessCode), setup(), new AttemptLimiter(LIMITS), NOW);
    expect(response.status).toBe(204);
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${12 * 60 * 60}`);
    // Plain http on loopback: a Secure cookie would never come back.
    expect(header).not.toContain("Secure");
    const value = cookieValue(response)!;
    expect(checkSessionValue(value, GATE, NOW)).toBe("valid");
    expect(checkSessionValue(value, GATE, new Date(NOW.getTime() + 12 * 60 * 60 * 1000))).toBe("expired");

    // The proxy lets that cookie through.
    const proxied = await proxyApiRequest(
      new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers: { Cookie: `${SESSION_COOKIE}=${value}` } }),
      ["v1", "crm", "contacts"],
      { apiUrl: "http://api.internal", token: "t", gate: setup(), fetch: async () => Response.json({ items: [] }) },
    );
    expect(proxied.status).toBe(200);
  });

  it("marks the cookie Secure over https, and trusts X-Forwarded-Proto only behind a trusted proxy", async () => {
    const https = await signIn(attempt(GATE.accessCode, {}, "https://app.example.com/api/sign-in"), setup(), new AttemptLimiter(LIMITS), NOW);
    expect(https.headers.get("set-cookie")).toContain("Secure");
    const forwarded = { "X-Forwarded-Proto": "https" };
    const untrusted = await signIn(attempt(GATE.accessCode, forwarded), setup(), new AttemptLimiter(LIMITS), NOW);
    expect(untrusted.headers.get("set-cookie")).not.toContain("Secure");
    const trusted = await signIn(attempt(GATE.accessCode, forwarded), setup({ ...GATE, trustProxy: true }), new AttemptLimiter(LIMITS), NOW);
    expect(trusted.headers.get("set-cookie")).toContain("Secure");
  });

  it("trips the per-address limit after repeated wrong codes, and then refuses even the right one", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    for (let index = 0; index < LIMITS.perAddress; index += 1) {
      expect((await signIn(attempt(`wrong-${index}`), setup(), limiter, NOW)).status).toBe(401);
    }
    const limited = await signIn(attempt("wrong-again"), setup(), limiter, NOW);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBe(15 * 60);
    const right = await signIn(attempt(GATE.accessCode), setup(), limiter, NOW);
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();

    // Another address still gets in; this one does once the window has passed.
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "198.51.100.4" }), setup(), limiter, NOW)).status).toBe(204);
    const later = new Date(NOW.getTime() + LIMITS.windowMs + 1000);
    expect((await signIn(attempt(GATE.accessCode), setup(), limiter, later)).status).toBe(204);
  });

  it("trips the global limit when wrong codes come from many addresses", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    for (let index = 0; index < LIMITS.global; index += 1) {
      const response = await signIn(attempt(`wrong-${index}`, { "X-Forwarded-For": `192.0.2.${index}` }), setup(), limiter, NOW);
      expect(response.status).toBe(401);
    }
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "192.0.2.250" }), setup(), limiter, NOW)).status).toBe(429);
  });

  it("refuses cross-site, non-JSON and malformed attempts without counting them as guesses", async () => {
    const limiter = new AttemptLimiter({ ...LIMITS, perAddress: 1 });
    expect((await signIn(attempt(GATE.accessCode, { Origin: "https://evil.example" }), setup(), limiter, NOW)).status).toBe(403);
    expect((await signIn(attempt(GATE.accessCode, { "Sec-Fetch-Site": "cross-site" }), setup(), limiter, NOW)).status).toBe(403);
    expect((await signIn(attempt(GATE.accessCode, { "Content-Type": "text/plain" }), setup(), limiter, NOW)).status).toBe(415);
    const garbled = new Request(`${ORIGIN}/api/sign-in`, { method: "POST", body: "{", headers: { "Content-Type": "application/json" } });
    expect((await signIn(garbled, setup(), limiter, NOW)).status).toBe(400);
    expect((await signIn(attempt(GATE.accessCode), setup(), limiter, NOW)).status).toBe(204);
  });

  it("has no gate in demo mode and refuses to sign in when live mode is not set up", async () => {
    expect((await signIn(attempt("anything-at-all-123"), null, new AttemptLimiter(LIMITS), NOW)).status).toBe(404);
    const unset = await signIn(attempt("anything-at-all-123"), { ok: false, problem: "no code" }, new AttemptLimiter(LIMITS), NOW);
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "misconfigured" });
  });

  it("signs out by clearing the cookie", async () => {
    const response = signOut(new Request(`${ORIGIN}/api/sign-out`, { method: "POST", headers: { Origin: ORIGIN, Host: "127.0.0.1:3218" } }), {});
    expect(response.status).toBe(204);
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(signOut(new Request(`${ORIGIN}/api/sign-out`, { method: "POST", headers: { Origin: "https://evil.example" } }), {}).status).toBe(403);
  });
});
