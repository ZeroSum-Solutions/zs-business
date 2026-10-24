// enrichment.md E-1, E-2, E-11, E-12, E-13, E-18, E-20: the Treg adapter against a stubbed fetch and
// recorded-shape fixtures. Nothing here reaches the network. The response shapes are the adapter's
// documented assumptions, not captured live responses (see the contract's Known limits).
import { describe, expect, it, vi } from "vitest";
import { ENRICHMENT_TOOLS, createTregEnrichment, isAllowedTool, type EnrichmentCall } from "../../src/index.js";

const TOKEN = "treg_secret_token_value_0123456789";
const TENANT = "11111111-2222-4333-8444-555555555555";
const clock = { now: () => new Date("2026-10-23T09:00:00.000Z") };
const call: EnrichmentCall = { op: "company.enrich", domain: "acme.example", idempotencyKey: "enrichment:req-1", priceCents: 5, tenantId: TENANT };

interface Seen { url: string; init: RequestInit }
function stub(responder: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), init: init ?? {} };
    seen.push(entry);
    return responder(entry);
  });
  return { seen, fetcher: fetcher as unknown as typeof fetch };
}
const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });
const adapter = (fetcher: typeof fetch) => createTregEnrichment({ token: TOKEN, fetch: fetcher, clock });

const HIT_BODY = {
  output: {
    name: "Acme Inc", domain: "acme.example", industry: "Software", employees: 120, founded: 2011, location: "Austin, Texas, United States",
    linkedin_url: "https://www.linkedin.com/company/acme",
    // Everything else Treg returns is dropped, never stored (E-13).
    raw: { ssn: "000-00-0000" }, ceo_email: "ceo@acme.example", phone: "+15125550100",
  },
};

describe("the request (E-4, E-8, E-18)", () => {
  it("sends one POST with the token, key, exact price cap, tenant tag and only the domain", async () => {
    const { seen, fetcher } = stub(() => json(HIT_BODY, { headers: { "x-treg-call-id": "call-9", "x-treg-cost-micro": "40000", "x-treg-provider": "pdl" } }));
    await adapter(fetcher).run(call);
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe("https://api.treg.to/v1/call");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Treg-Token"]).toBe(TOKEN);
    expect(headers["Idempotency-Key"]).toBe("enrichment:req-1");
    expect(headers["X-Treg-Route-Max-Cost"]).toBe("0.05");
    expect(headers["X-Treg-Meta"]).toBe(`tenant=${TENANT}, feature=company.enrich`);
    expect(JSON.parse(String(init.body))).toEqual({ tool: "treg.companies.enrich", input: { domain: "acme.example" } });
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("writes whole cents as exact dollars", async () => {
    for (const [cents, header] of [[1, "0.01"], [5, "0.05"], [10, "0.10"], [99, "0.99"], [100, "1.00"], [105, "1.05"], [1234, "12.34"]] as const) {
      const { seen, fetcher } = stub(() => json({ output: {} }));
      await adapter(fetcher).run({ ...call, priceCents: cents });
      expect((seen[0]!.init.headers as Record<string, string>)["X-Treg-Route-Max-Cost"]).toBe(header);
    }
    const { fetcher } = stub(() => json({}));
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(adapter(fetcher).run({ ...call, priceCents: bad })).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("the answer (E-11, E-13)", () => {
  it("a hit keeps the eight allowlisted fields as bounded strings and the call id, provider and cost", async () => {
    const { fetcher } = stub(() => json(HIT_BODY, { headers: { "x-treg-call-id": "call-9", "x-treg-cost-micro": "40000", "x-treg-provider": "pdl" } }));
    const outcome = await adapter(fetcher).run(call);
    expect(outcome).toEqual({
      status: "hit", callId: "call-9", provider: "pdl", costMicro: 40000,
      fields: {
        name: "Acme Inc", domain: "acme.example", industry: "Software", employees: "120", founded: "2011",
        location: "Austin, Texas, United States", linkedin_url: "https://www.linkedin.com/company/acme",
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/ssn|ceo@|\+1512/);
  });

  it("drops a field that fails its bound and keeps the rest", async () => {
    const { fetcher } = stub(() => json({ output: { name: "x".repeat(201), industry: "Software", employees: -4, founded: 1999, linkedin_url: "http://evil.example/company/x" } }, { headers: { "x-treg-call-id": "c" } }));
    const outcome = await adapter(fetcher).run(call);
    expect(outcome).toMatchObject({ status: "hit", fields: { industry: "Software", founded: "1999" } });
    if (outcome.status === "hit") expect(Object.keys(outcome.fields).sort()).toEqual(["founded", "industry"]);
  });

  it("an empty output is a miss", async () => {
    const { fetcher } = stub(() => json({ output: null }, { headers: { "x-treg-call-id": "c-miss", "x-treg-cost-micro": "0" } }));
    expect(await adapter(fetcher).run(call)).toEqual({ status: "miss", callId: "c-miss", provider: "treg", costMicro: 0 });
  });

  it("a hit with no call id cannot be recorded, so it is uncertain", async () => {
    const { fetcher } = stub(() => json(HIT_BODY));
    expect(await adapter(fetcher).run(call)).toEqual({ status: "uncertain", code: "no_call_id" });
  });
});

describe("statuses and errors (E-11, E-12)", () => {
  const run = (response: () => Response) => adapter(stub(response).fetcher).run(call);

  it("409 is still in flight, 410 means the key expired", async () => {
    expect(await run(() => json({}, { status: 409 }))).toEqual({ status: "uncertain", code: "in_flight" });
    expect(await run(() => json({}, { status: 410, headers: { "x-treg-call-id": "c-old" } }))).toEqual({ status: "key_expired", callId: "c-old" });
  });

  it("402 and an insufficient_balance code end as insufficient_balance, route_max_cost as its own kind", async () => {
    expect(await run(() => json({ error: { code: "insufficient_balance" } }, { status: 402, headers: { "x-treg-error": "1" } })))
      .toMatchObject({ status: "failed", kind: "insufficient_balance" });
    expect(await run(() => json({ error: { code: "route_max_cost" } }, { status: 400, headers: { "x-treg-error": "1" } })))
      .toMatchObject({ status: "failed", kind: "route_max_cost", code: "route_max_cost" });
    expect(await run(() => json({}, { status: 403 }))).toMatchObject({ status: "failed", kind: "refused" });
    expect(await run(() => json({ error: "nope" }, { status: 401 }))).toMatchObject({ status: "failed", kind: "refused" });
  });

  it("429 and 5xx fail with retry, honouring Retry-After and capping it", async () => {
    expect(await run(() => json({}, { status: 429, headers: { "retry-after": "30" } }))).toMatchObject({ status: "failed", kind: "rate_limited", retryAfterS: 30 });
    expect(await run(() => json({}, { status: 429, headers: { "retry-after": "999999" } }))).toMatchObject({ retryAfterS: 86_400 });
    expect(await run(() => json({}, { status: 503 }))).toMatchObject({ status: "failed", kind: "provider_error" });
  });

  it("another 4xx is rejected with a short safe code", async () => {
    expect(await run(() => json({ error: { code: "bad input <script>" } }, { status: 422, headers: { "x-treg-cost-micro": "0" } })))
      .toEqual({ status: "rejected", code: "bad_input__script_", callId: null, costMicro: 0 });
  });

  it("a thrown error or timeout is uncertain, never a failure", async () => {
    const down = adapter((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    expect(await down.run(call)).toEqual({ status: "uncertain", code: "provider_unreachable" });
    const slow = createTregEnrichment({
      token: TOKEN, clock, timeoutMs: 20,
      fetch: ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    });
    expect(await slow.run(call)).toEqual({ status: "uncertain", code: "provider_timeout" });
  });
});

describe("lookup, balance and whoami (E-5, E-12, E-16)", () => {
  it("looks a call up by id, or by key when the id is unknown", async () => {
    const { seen, fetcher } = stub((entry) => entry.url.includes("idempotency_key") ? json({ calls: [] }) : json({ id: "call-9" }));
    const port = adapter(fetcher);
    expect(await port.lookup({ callId: "call-9", idempotencyKey: "enrichment:r" })).toEqual({ status: "charged", callId: "call-9" });
    expect(await port.lookup({ callId: null, idempotencyKey: "enrichment:r" })).toEqual({ status: "not_found" });
    expect(seen.map((entry) => entry.url)).toEqual(["https://api.treg.to/v1/calls/call-9", "https://api.treg.to/v1/calls?idempotency_key=enrichment%3Ar"]);
    expect(await adapter(stub(() => json({}, { status: 404 })).fetcher).lookup({ callId: "x", idempotencyKey: "k" })).toEqual({ status: "not_found" });
    expect(await adapter(stub(() => json({}, { status: 500 })).fetcher).lookup({ callId: "x", idempotencyKey: "k" })).toEqual({ status: "unknown", code: "http_500" });
  });

  it("reads the balance and the token role", async () => {
    const port = adapter(stub((entry) => entry.url.endsWith("balance") ? json({ balance_micro: 4_990_000 }) : json({ role: "agent" })).fetcher);
    expect(await port.balance()).toEqual({ balanceMicro: 4_990_000 });
    expect(await port.whoami()).toEqual({ role: "agent" });
    await expect(adapter(stub(() => json({}, { status: 500 })).fetcher).balance()).rejects.toThrow("balance_http_500");
    await expect(adapter(stub(() => json({ nope: 1 })).fetcher).balance()).rejects.toThrow("balance_unreadable");
  });

  it("sends the token on every request", async () => {
    const { seen, fetcher } = stub(() => json({ balance_micro: 1, role: "agent" }));
    const port = adapter(fetcher);
    await port.balance();
    await port.whoami();
    await port.lookup({ callId: "c", idempotencyKey: "k" });
    expect(seen.map((entry) => (entry.init.headers as Record<string, string>)["X-Treg-Token"])).toEqual([TOKEN, TOKEN, TOKEN]);
  });
});

describe("the allowlist (E-2)", () => {
  it("names exactly one tool, and no people, email or search tool", () => {
    expect(ENRICHMENT_TOOLS).toEqual({ "company.enrich": "treg.companies.enrich" });
    expect(Object.isFrozen(ENRICHMENT_TOOLS)).toBe(true);
    expect(isAllowedTool("treg.companies.enrich")).toBe(true);
    for (const tool of ["treg.people.enrich", "treg.people.search", "treg.email.find", "treg.email.verify", "treg.companies.search", "treg.companies.enrich ", ""])
      expect(isAllowedTool(tool), tool).toBe(false);
  });

  it("refuses an op that is not on the list before any network call", async () => {
    const { seen, fetcher } = stub(() => json({}));
    await expect(adapter(fetcher).run({ ...call, op: "people.enrich" as never })).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(seen).toHaveLength(0);
  });

  it("requires a token", () => {
    expect(() => createTregEnrichment({ token: "", clock })).toThrow();
  });
});

describe("no secret in logs (E-18)", () => {
  it("never writes the token, a body or a domain to the console, whatever the outcome", async () => {
    const written: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never);
    try {
      const responses = [
        () => json(HIT_BODY, { headers: { "x-treg-call-id": "c" } }),
        () => json({ error: { code: "boom" } }, { status: 500 }),
        () => json({}, { status: 409 }),
        () => { throw new TypeError("network down"); },
      ];
      for (const response of responses) {
        const port = adapter(stub(response).fetcher);
        await port.run(call);
        await port.lookup({ callId: "c", idempotencyKey: "k" });
        await port.balance().catch(() => undefined);
        await port.whoami().catch(() => undefined);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(written.join("\n")).not.toContain(TOKEN);
    expect(written.join("\n")).not.toContain("acme.example");
    expect(written).toHaveLength(0);
  });
});
