import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { AttemptLimiter, checkSessionValue, clientAddress, DIRECT_ADDRESS, SESSION_COOKIE, type PilotGateConfig } from "../src/lib/server/pilot-gate";
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

/** An attempt whose body arrives a moment later, as a slow or deliberate client sends it. */
function slowAttempt(code: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify({ code }));
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Request(`${ORIGIN}/api/sign-in`, {
    method: "POST",
    body,
    duplex: "half",
    headers: { "Content-Type": "application/json", Host: new URL(ORIGIN).host, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "203.0.113.7", ...headers },
  } as RequestInit);
}

const setup = (config: PilotGateConfig = GATE) => ({ ok: true as const, config });
/** Behind a trusted proxy, so X-Forwarded-For names the caller. */
const proxied = () => setup({ ...GATE, trustProxy: true });
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
      { apiUrl: "http://api.internal", token: "t", gate: setup(), now: () => NOW, fetch: async () => Response.json({ items: [] }) },
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
      expect((await signIn(attempt(`wrong-${index}`), proxied(), limiter, NOW)).status).toBe(401);
    }
    const limited = await signIn(attempt("wrong-again"), proxied(), limiter, NOW);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBe(15 * 60);
    const right = await signIn(attempt(GATE.accessCode), proxied(), limiter, NOW);
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();

    // Another address still gets in; this one does once the window has passed.
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "198.51.100.4" }), proxied(), limiter, NOW)).status).toBe(204);
    const later = new Date(NOW.getTime() + LIMITS.windowMs + 1000);
    expect((await signIn(attempt(GATE.accessCode), proxied(), limiter, later)).status).toBe(204);
  });

  it("trips the global limit when wrong codes come from many addresses", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    for (let index = 0; index < LIMITS.global; index += 1) {
      const response = await signIn(attempt(`wrong-${index}`, { "X-Forwarded-For": `192.0.2.${index}` }), proxied(), limiter, NOW);
      expect(response.status).toBe(401);
    }
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "192.0.2.250" }), proxied(), limiter, NOW)).status).toBe(429);
  });

  it("refuses cross-site and non-JSON attempts before counting them, and counts a malformed body", async () => {
    const limiter = new AttemptLimiter({ ...LIMITS, perAddress: 2 });
    expect((await signIn(attempt(GATE.accessCode, { Origin: "https://evil.example" }), setup(), limiter, NOW)).status).toBe(403);
    expect((await signIn(attempt(GATE.accessCode, { "Sec-Fetch-Site": "cross-site" }), setup(), limiter, NOW)).status).toBe(403);
    expect((await signIn(attempt(GATE.accessCode, { "Content-Type": "text/plain" }), setup(), limiter, NOW)).status).toBe(415);
    // A body is read only after its attempt is reserved, so a malformed one still spends it.
    const garbled = new Request(`${ORIGIN}/api/sign-in`, { method: "POST", body: "{", headers: { "Content-Type": "application/json" } });
    expect((await signIn(garbled, setup(), limiter, NOW)).status).toBe(400);
    expect((await signIn(attempt(GATE.accessCode), setup(), limiter, NOW)).status).toBe(204);
    expect((await signIn(attempt("wrong-code-here"), setup(), limiter, NOW)).status).toBe(401);
    expect((await signIn(attempt(GATE.accessCode), setup(), limiter, NOW)).status).toBe(429);
  });

  it("gives the attempt back only when the sign-in succeeds", async () => {
    const limiter = new AttemptLimiter({ ...LIMITS, perAddress: 2 });
    for (let index = 0; index < 6; index += 1) {
      expect((await signIn(attempt(GATE.accessCode), setup(), limiter, NOW)).status).toBe(204);
    }
    expect((await signIn(attempt("wrong-code-one"), setup(), limiter, NOW)).status).toBe(401);
    expect((await signIn(attempt("wrong-code-two"), setup(), limiter, NOW)).status).toBe(401);
    expect((await signIn(attempt(GATE.accessCode), setup(), limiter, NOW)).status).toBe(429);
  });

  it("lets at most the per-address limit past when attempts arrive together with slow bodies", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    const statuses = await Promise.all(Array.from({ length: 40 }, (_, index) => signIn(slowAttempt(`wrong-${index}`), proxied(), limiter, NOW).then((response) => response.status)));
    expect(statuses.filter((status) => status !== 429)).toHaveLength(LIMITS.perAddress);
    expect(statuses.filter((status) => status === 401)).toHaveLength(LIMITS.perAddress);
  });

  it("lets at most the global limit past when many addresses attempt together with slow bodies", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    const statuses = await Promise.all(Array.from({ length: 80 }, (_, index) =>
      signIn(slowAttempt(`wrong-${index}`, { "X-Forwarded-For": `192.0.2.${index}` }), proxied(), limiter, NOW).then((response) => response.status)));
    expect(statuses.filter((status) => status !== 429)).toHaveLength(LIMITS.global);
  });

  it("ignores X-Forwarded-For without a trusted proxy, so forged addresses share one key", async () => {
    const limiter = new AttemptLimiter(LIMITS);
    for (let index = 0; index < LIMITS.perAddress; index += 1) {
      expect((await signIn(attempt(`wrong-${index}`, { "X-Forwarded-For": `198.51.100.${index}` }), setup(), limiter, NOW)).status).toBe(401);
    }
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "198.51.100.200" }), setup(), limiter, NOW)).status).toBe(429);
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "" }), setup(), limiter, NOW)).status).toBe(429);
  });

  it("keys on the right-most X-Forwarded-For entry behind a trusted proxy", async () => {
    const forwarded = (sent: string) => ({ "X-Forwarded-For": `${sent}, 203.0.113.9` });
    expect(clientAddress(attempt("x", forwarded("1.2.3.4")), true)).toBe("203.0.113.9");
    expect(clientAddress(attempt("x", forwarded("1.2.3.4")), false)).toBe(DIRECT_ADDRESS);
    expect(clientAddress(attempt("x", { "X-Forwarded-For": "" }), true)).toBe(DIRECT_ADDRESS);

    // What the caller sends to the left of the proxy's entry changes nothing.
    const limiter = new AttemptLimiter(LIMITS);
    for (let index = 0; index < LIMITS.perAddress; index += 1) {
      expect((await signIn(attempt(`wrong-${index}`, forwarded(`10.0.0.${index}`)), proxied(), limiter, NOW)).status).toBe(401);
    }
    expect((await signIn(attempt(GATE.accessCode, forwarded("10.0.0.99")), proxied(), limiter, NOW)).status).toBe(429);
    expect((await signIn(attempt(GATE.accessCode, { "X-Forwarded-For": "10.0.0.1, 203.0.113.10" }), proxied(), limiter, NOW)).status).toBe(204);
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
