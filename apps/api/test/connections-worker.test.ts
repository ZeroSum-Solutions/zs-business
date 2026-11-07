// The connections worker app (docs/requirements/connections.md C-3, C-7, C-9): its environment, the five
// signed internal routes and the cron route. The worker itself is core's and is tested there against a
// real database; here a recording stub stands in, so these tests show what the routes refuse and let through.
import { randomUUID } from "node:crypto";
import { CONNECTOR_SIGNATURE_HEADERS, createHttpConnectorPort, signConnectorRequest } from "@zs/core";
import { describe, expect, it } from "vitest";
import { parseConnectionsEnv } from "../src/connections/config.js";
import { connectionsWorkerReporter } from "../src/connections/start.js";
import { connectionsInternalRoutes } from "../src/connections/internal.js";
import { createConnectionsRunner } from "../src/connections/runner.js";
import { cronRoutes } from "../src/delivery/cron.js";

/** Synthetic values, built at runtime so secret scanners do not flag a literal. */
const SECRET = ["test", "internal", "a".repeat(32)].join("-");
const PREVIOUS = ["test", "internal", "p".repeat(32)].join("-");
const CRON = ["test", "cron", "c".repeat(32)].join("-");
const API_KEY = ["test", "composio", "k".repeat(20)].join("-");
const ENV = {
  COMPOSIO_API_KEY: API_KEY,
  CONNECTIONS_ENV: "preview",
  CONNECTIONS_INTERNAL_SECRET: SECRET,
  CONNECTIONS_DATABASE_URL: "postgres://zs_connections@127.0.0.1:55432/zs_dev",
  CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID: "ac_shopify",
  CONNECTIONS_CALLBACK_URL: "https://app.haldenrowe.example/api/connections/callback",
  CRON_SECRET: CRON,
};
const without = (name: string) => Object.fromEntries(Object.entries(ENV).filter(([key]) => key !== name));
const errorOf = (env: Record<string, string | undefined>): string => {
  try {
    parseConnectionsEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseConnectionsEnv accepted the environment");
};

describe("parseConnectionsEnv", () => {
  it("is off, with no error, when no CONNECTIONS_ variable is set (COMPOSIO_API_KEY alone does not switch it on)", () => {
    expect(parseConnectionsEnv({})).toEqual({ worker: null, cronSecret: null });
    // C-6: off means the cron route is off too, and CRON_SECRET (shared with other crons) is not judged here.
    expect(parseConnectionsEnv({ COMPOSIO_API_KEY: API_KEY, CRON_SECRET: CRON })).toEqual({ worker: null, cronSecret: null });
    expect(parseConnectionsEnv({ CRON_SECRET: "short" })).toEqual({ worker: null, cronSecret: null });
    expect(parseConnectionsEnv({ CONNECTIONS_ENV: "" })).toEqual({ worker: null, cronSecret: null });
  });

  it("parses the whole set", () => {
    const parsed = parseConnectionsEnv(ENV);
    expect(parsed.cronSecret).toBe(CRON);
    expect(parsed.worker).toEqual({
      env: "preview",
      composioApiKey: API_KEY,
      internalSecrets: { current: SECRET },
      serviceDatabaseUrl: ENV.CONNECTIONS_DATABASE_URL,
      databaseCaCert: undefined,
      authConfigIds: { shopify: "ac_shopify" },
      callbackUrl: ENV.CONNECTIONS_CALLBACK_URL,
    });
  });

  it("is all or none: any one variable set makes every required one required, and the error names variables only", () => {
    for (const name of ["COMPOSIO_API_KEY", "CONNECTIONS_ENV", "CONNECTIONS_INTERNAL_SECRET", "CONNECTIONS_DATABASE_URL", "CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID", "CONNECTIONS_CALLBACK_URL"]) {
      const message = errorOf(without(name));
      expect(message).toContain(name);
      for (const value of [SECRET, API_KEY, CRON]) expect(message).not.toContain(value);
    }
    expect(errorOf({ CONNECTIONS_ENV: "production" })).toContain("CONNECTIONS_INTERNAL_SECRET");
  });

  it("refuses a short secret, an unknown environment, a bad auth config ID and an unsafe callback URL", () => {
    expect(errorOf({ ...ENV, CONNECTIONS_INTERNAL_SECRET: "short" })).toContain("CONNECTIONS_INTERNAL_SECRET");
    expect(errorOf({ ...ENV, CONNECTIONS_ENV: "staging" })).toContain("CONNECTIONS_ENV");
    expect(errorOf({ ...ENV, CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID: "ac shopify/../" })).toContain("CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID");
    expect(errorOf({ ...ENV, CONNECTIONS_CALLBACK_URL: "http://app.haldenrowe.example/cb" })).toContain("CONNECTIONS_CALLBACK_URL");
    expect(errorOf({ ...ENV, CONNECTIONS_CALLBACK_URL: "https://u:p@app.haldenrowe.example/cb" })).toContain("CONNECTIONS_CALLBACK_URL");
    expect(parseConnectionsEnv({ ...ENV, CONNECTIONS_CALLBACK_URL: "http://127.0.0.1:3000/api/connections/callback" }).worker).not.toBeNull();
  });

  it("accepts a previous secret only if it differs from the current one", () => {
    expect(parseConnectionsEnv({ ...ENV, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: PREVIOUS }).worker?.internalSecrets).toEqual({ current: SECRET, previous: PREVIOUS });
    expect(errorOf({ ...ENV, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: SECRET })).toContain("CONNECTIONS_INTERNAL_PREVIOUS_SECRET");
  });

  it("needs DATABASE_CA_CERT and no query string for a non-loopback database", () => {
    const remote = { ...ENV, CONNECTIONS_DATABASE_URL: "postgres://zs_connections@db.example.test:5432/postgres" };
    expect(errorOf(remote)).toContain("DATABASE_CA_CERT");
    const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(parseConnectionsEnv({ ...remote, DATABASE_CA_CERT: cert }).worker?.databaseCaCert).toBe(cert);
    expect(errorOf({ ...remote, DATABASE_CA_CERT: cert, CONNECTIONS_DATABASE_URL: `${remote.CONNECTIONS_DATABASE_URL}?sslmode=disable` })).toContain("query string");
  });

  it("refuses a short or placeholder CRON_SECRET, and an unset one leaves the cron route off", () => {
    expect(errorOf({ ...ENV, CRON_SECRET: "short" })).toContain("CRON_SECRET");
    expect(errorOf({ ...ENV, CRON_SECRET: "PLACEHOLDER_CRON_SECRET" })).toContain("CRON_SECRET");
    expect(parseConnectionsEnv(without("CRON_SECRET")).cronSecret).toBeNull();
  });
});

const HOST = "worker.haldenrowe.example";
const ORIGIN = `https://${HOST}`;
const NOW = new Date("2026-11-06T12:00:00.000Z");

function harness(options: { worker?: boolean; env?: "production" | "preview"; previous?: string; now?: () => Date } = {}) {
  const calls: { operation: string; body: unknown }[] = [];
  const seen = new Set<string>();
  const worker = options.worker === false ? null : {
    takeNonce: async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true)),
    link: async (request: unknown) => { calls.push({ operation: "link", body: request }); throw new Error("unused"); },
    complete: async (request: unknown) => { calls.push({ operation: "complete", body: request }); throw new Error("unused"); },
    cancel: async (request: unknown) => { calls.push({ operation: "cancel", body: request }); return { outcome: "cancelled" as const, revokeFailed: false }; },
    run: async (request: unknown) => { calls.push({ operation: "run", body: request }); throw new Error("unused"); },
    disconnect: async (request: unknown) => { calls.push({ operation: "disconnect", body: request }); throw new Error("unused"); },
  };
  const refused: string[] = [];
  const errors: unknown[] = [];
  const app = connectionsInternalRoutes({
    worker: worker as never,
    env: options.env ?? "preview",
    secrets: { current: SECRET, ...(options.previous ? { previous: options.previous } : {}) },
    clock: { now: options.now ?? (() => NOW) },
    onRefused: (operation, reason) => refused.push(`${operation}:${reason}`),
    onError: (error) => errors.push(error),
  });
  const body = JSON.stringify({ tenantId: randomUUID(), attemptId: randomUUID() });
  const send = (signed: { secret?: string; env?: "production" | "preview"; host?: string; at?: Date; jti?: string; path?: string } | null, over: { body?: string; path?: string; method?: string; headers?: Record<string, string> } = {}) => {
    const path = over.path ?? "/internal/connections/cancel";
    const text = over.body ?? body;
    const headers: Record<string, string> = { "content-type": "application/json", ...(over.headers ?? {}) };
    if (signed) Object.assign(headers, signConnectorRequest({ secret: signed.secret ?? SECRET, env: signed.env ?? "preview", host: signed.host ?? HOST, path: signed.path ?? path, body: text, now: signed.at ?? NOW, ...(signed.jti ? { jti: signed.jti } : {}) }));
    return app.request(`${ORIGIN}${path}`, over.method === "GET" ? { method: "GET", headers } : { method: over.method ?? "POST", headers, body: text });
  };
  return { app, send, calls, refused, errors, body };
}

describe("POST /internal/connections/<operation>", () => {
  it("accepts a correctly signed request and runs the operation", async () => {
    const h = harness();
    const response = await h.send({});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(h.calls.map((call) => call.operation)).toEqual(["cancel"]);
  });

  it("refuses an unsigned request, a missing header, a forged tag and a wrong secret, running nothing", async () => {
    const h = harness();
    expect((await h.send(null)).status).toBe(401);
    expect((await h.send({ secret: "x".repeat(40) })).status).toBe(401);
    const partial = signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: "/internal/connections/cancel", body: h.body, now: NOW });
    const { [CONNECTOR_SIGNATURE_HEADERS.signature]: _dropped, ...rest } = partial;
    expect((await h.send(null, { headers: rest })).status).toBe(401);
    expect(h.calls).toEqual([]);
    expect(h.refused).toEqual(["cancel:unsigned", "cancel:bad_signature", "cancel:unsigned"]);
  });

  it("refuses a stale or future timestamp (60 s skew) and accepts one inside it", async () => {
    const h = harness();
    expect((await h.send({ at: new Date(NOW.getTime() - 61_000) })).status).toBe(401);
    expect((await h.send({ at: new Date(NOW.getTime() + 61_000) })).status).toBe(401);
    expect((await h.send({ at: new Date(NOW.getTime() - 30_000) })).status).toBe(200);
    expect(h.refused).toEqual(["cancel:stale", "cancel:stale"]);
  });

  it("refuses a request signed for the other environment", async () => {
    const h = harness({ env: "production" });
    expect((await h.send({ env: "preview" })).status).toBe(401);
    expect(h.refused).toEqual(["cancel:wrong_env"]);
    expect(h.calls).toEqual([]);
  });

  it("refuses a request signed for another host or another path (the signature covers both)", async () => {
    const h = harness();
    expect((await h.send({ host: "other.example" })).status).toBe(401);
    expect((await h.send({ path: "/internal/connections/run" })).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("refuses a body changed after signing", async () => {
    const h = harness();
    const signed = signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: "/internal/connections/cancel", body: h.body, now: NOW });
    const tampered = JSON.stringify({ tenantId: randomUUID(), attemptId: randomUUID() });
    expect((await h.send(null, { headers: signed, body: tampered })).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("refuses a replay of the same request, and a forged request does not use up the ID", async () => {
    const h = harness();
    const jti = randomUUID().replaceAll("-", "");
    expect((await h.send({ secret: "y".repeat(40), jti })).status).toBe(401);
    expect((await h.send({ jti })).status).toBe(200);
    expect((await h.send({ jti })).status).toBe(401);
    expect(h.refused).toEqual(["cancel:bad_signature", "cancel:replayed"]);
    expect(h.calls).toHaveLength(1);
  });

  it("accepts the previous secret during a rotation, and only that", async () => {
    const h = harness({ previous: PREVIOUS });
    expect((await h.send({ secret: PREVIOUS })).status).toBe(200);
    const none = harness();
    expect((await none.send({ secret: PREVIOUS })).status).toBe(401);
  });

  it("answers an unknown operation, a GET and an unconfigured worker with a 404 and runs nothing", async () => {
    const h = harness();
    expect((await h.send({}, { path: "/internal/connections/export" })).status).toBe(404);
    expect((await h.send({}, { path: "/internal/connections/" })).status).toBe(404);
    expect((await h.send({}, { method: "GET" })).status).toBe(404);
    const off = harness({ worker: false });
    const response = await off.send({});
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("onfigur");
    expect(h.calls).toEqual([]);
    expect(off.calls).toEqual([]);
  });

  it("rejects a query string and an oversized body before checking the signature", async () => {
    const h = harness();
    const signed = signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: "/internal/connections/cancel", body: h.body, now: NOW });
    const query = await h.app.request(`${ORIGIN}/internal/connections/cancel?x=1`, { method: "POST", headers: signed, body: h.body });
    expect(query.status).toBe(400);
    const huge = "x".repeat(70 * 1024);
    expect((await h.send({}, { body: huge })).status).toBe(400);
    expect(h.refused).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("B-6: refuses a chunked body at the cap without reading the rest, before the signature check", async () => {
    const h = harness();
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 1024 * 1024) controller.close(); else controller.enqueue(chunk);
      },
    });
    const response = await h.app.request(`${ORIGIN}/internal/connections/cancel`, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(128 * 1024);
    expect(h.refused).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("B-6: stops reading a body that stalls, or whose caller went away, before the signature check", async () => {
    const stalled = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); } });
    const calls: string[] = [];
    const app = connectionsInternalRoutes({
      worker: { takeNonce: async () => { calls.push("nonce"); return true; } } as never,
      env: "preview", secrets: { current: SECRET }, clock: { now: () => NOW }, readTimeoutMs: 50,
    });
    const url = `${ORIGIN}/internal/connections/cancel`;
    const started = performance.now();
    const slow = await app.request(url, { method: "POST", body: stalled(), duplex: "half" } as RequestInit);
    expect(slow.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(2_000);
    // The caller leaving ends the read too, long before the read budget.
    const patient = connectionsInternalRoutes({
      worker: { takeNonce: async () => { calls.push("nonce"); return true; } } as never,
      env: "preview", secrets: { current: SECRET }, clock: { now: () => NOW }, readTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const gone = await patient.request(new Request(url, { method: "POST", body: stalled(), duplex: "half", signal: controller.signal } as RequestInit));
    expect(gone.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("B-6: hands the operation the request's abort signal", async () => {
    let seen: AbortSignal | undefined;
    const app = connectionsInternalRoutes({
      worker: {
        takeNonce: async () => true,
        cancel: async (_request: unknown, signal?: AbortSignal) => { seen = signal; return { outcome: "not_found" as const }; },
      } as never,
      env: "preview", secrets: { current: SECRET }, clock: { now: () => NOW },
    });
    const body = JSON.stringify({ tenantId: randomUUID(), attemptId: randomUUID() });
    const headers = signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: "/internal/connections/cancel", body, now: NOW });
    const controller = new AbortController();
    const response = await app.request(new Request(`${ORIGIN}/internal/connections/cancel`, { method: "POST", headers, body, signal: controller.signal }));
    expect(response.status).toBe(200);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });

  it("answers a signed body that does not fit the operation with a 400 and no worker call", async () => {
    const h = harness();
    expect((await h.send({}, { body: "not json" })).status).toBe(400);
    expect((await h.send({}, { body: JSON.stringify({ tenantId: "x", extra: true }) })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("does not log or return the body, the signature or the secret on a refusal", async () => {
    const h = harness();
    const response = await h.send({ secret: "z".repeat(40) });
    const text = await response.text();
    for (const value of [SECRET, h.body, "signature"]) expect(text).not.toContain(value);
    expect(h.refused.join()).not.toContain(h.body);
  });

  it("reports a database failure while taking the ID as 503 and runs nothing", async () => {
    const h = harness();
    const app = connectionsInternalRoutes({
      worker: { takeNonce: async () => { throw new Error("db down"); }, link: async () => { throw new Error("no"); } } as never,
      env: "preview", secrets: { current: SECRET }, clock: { now: () => NOW }, onError: (error) => h.errors.push(error),
    });
    const headers = signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: "/internal/connections/cancel", body: h.body, now: NOW });
    const response = await app.request(`${ORIGIN}/internal/connections/cancel`, { method: "POST", headers, body: h.body });
    expect(response.status).toBe(503);
    expect(h.errors).toHaveLength(1);
  });

  it("serves core's HTTP port end to end: the port signs, the route verifies, the worker answers", async () => {
    const h = harness();
    const port = createHttpConnectorPort({
      workerUrl: ORIGIN,
      env: "preview",
      secrets: { current: SECRET },
      clock: { now: () => NOW },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => h.app.request(input as string, init)) as typeof fetch,
    });
    const tenantId = randomUUID();
    const attemptId = randomUUID();
    await expect(port.cancel({ tenantId, attemptId })).resolves.toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(h.calls).toEqual([{ operation: "cancel", body: { tenantId, attemptId } }]);
  });
});

describe("GET /cron/connections", () => {
  const runner = () => {
    let passes = 0;
    return { passes: () => passes, runner: createConnectionsRunner({ pass: async () => { passes += 1; return { disconnected: 0, swept: 1, checked: 2, composioCalls: 3, stopped: null } as never; } }) };
  };
  const route = (cronSecret: string | null, active: ReturnType<typeof runner> | null) => cronRoutes({
    path: "/cron/connections", killSwitch: "the CONNECTIONS_ variables", name: "Connections", cronSecret, runner: active?.runner ?? null,
  });

  it("is a 404 without CRON_SECRET and a 401 on a missing or wrong bearer, with no pass", async () => {
    const active = runner();
    expect((await route(null, active).request("/cron/connections", { headers: { authorization: `Bearer ${CRON}` } })).status).toBe(404);
    expect((await route(CRON, active).request("/cron/connections")).status).toBe(401);
    expect((await route(CRON, active).request("/cron/connections", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(active.passes()).toBe(0);
  });

  it("runs one pass for the right bearer and answers its counts", async () => {
    const active = runner();
    const response = await route(CRON, active).request("/cron/connections", { headers: { authorization: `Bearer ${CRON}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: true, disconnected: 0, swept: 1, checked: 2, composioCalls: 3, stopped: null });
    expect(active.passes()).toBe(1);
  });

  it("answers 200 ran:false and touches nothing when the worker is not configured", async () => {
    const response = await route(CRON, null).request("/cron/connections", { headers: { authorization: `Bearer ${CRON}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ran: false });
  });

  it("answers 503 when the pass throws, without the error text", async () => {
    const app = cronRoutes({ path: "/cron/connections", name: "Connections", cronSecret: CRON, runner: createConnectionsRunner({ pass: async () => { throw new Error("secret detail"); } }) });
    const response = await app.request("/cron/connections", { headers: { authorization: `Bearer ${CRON}` } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret detail");
  });
});

describe("the worker's operator log (C-7, C-14)", () => {
  const capture = () => {
    const lines: { level: "info" | "warn"; message: string; event: unknown }[] = [];
    return { lines, log: { info: (message: string, event: unknown) => lines.push({ level: "info", message, event }), warn: (message: string, event: unknown) => lines.push({ level: "warn", message, event }) } };
  };

  it("logs every run with tenant, connection, tool, our code and ms, and nothing else", () => {
    const out = capture();
    const report = connectionsWorkerReporter(out.log);
    const tenantId = randomUUID();
    const connectionId = randomUUID();
    report({ kind: "run", tenantId, connectionId, tool: "shopify_list_orders", code: "ok", ms: 120 });
    expect(out.lines).toEqual([{ level: "info", message: "Connections run", event: { tenantId, connectionId, tool: "shopify_list_orders", code: "ok", ms: 120 } }]);
  });

  it("warns on account_mismatch, link_orphan and key_refused, and leaves routine events out", () => {
    const out = capture();
    const report = connectionsWorkerReporter(out.log);
    const tenantId = randomUUID();
    report({ kind: "account_mismatch", tenantId, attemptId: randomUUID() });
    report({ kind: "link_orphan", tenantId, attemptId: randomUUID(), composioAccountId: "ca_orphan" });
    report({ kind: "key_refused", env: "preview", status: 401 });
    report({ kind: "swept", tenantId, attemptId: randomUUID() });
    report({ kind: "restored", tenantId, connectionId: randomUUID() });
    expect(out.lines.map((line) => [line.level, (line.event as { kind: string }).kind])).toEqual([
      ["warn", "account_mismatch"], ["warn", "link_orphan"], ["warn", "key_refused"],
    ]);
  });
});
