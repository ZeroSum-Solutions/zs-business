// Activepieces as the API deploys it (activepieces.md W-1..W-14): the environment the API and the
// webhook worker parse, the cron route, and one flow end to end over HTTP. An owner adds a webhook
// endpoint and a token, a booking becomes a signed event a local stand-in for an Activepieces flow
// verifies, the flow proposes a contact with its token, and nothing happens until an owner
// approves. No test leaves 127.0.0.1; no system clock.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  automationTokenWithSecretSchema,
  automationWhoAmISchema,
  proposalRecordSchema,
  webhookDeliveryPageSchema,
  webhookEndpointWithSecretSchema,
} from "@zs/contracts";
import { verifyResendWebhook } from "@zs/core";
import { assertActivepiecesCronFits, parseActivepiecesWorkerEnv, type ActivepiecesRunnerEnv } from "../src/activepieces/config.js";
import { activepiecesCronRoutes } from "../src/activepieces/cron.js";
import { createActivepiecesRunner, createWebhookWorkerFromEnv, type ActivepiecesRunSummary } from "../src/activepieces/runner.js";
import { parseServerEnv, PLACEHOLDER_ACTIVEPIECES_KEY_SECRET } from "../src/config.js";
import { ACTIVEPIECES_KEY_SECRET, call, createApiHarness, NOW, signedInMember, type ApiHarness } from "./helpers.js";

/** Synthetic secrets, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const PREVIOUS_KEY = ["test", "activepieces", "p".repeat(32)].join("-");
const DB_PASSWORD = ["pw", "d".repeat(20)].join("-");
const CA_CERT = ["-----BEGIN CERTIFICATE-----", "MIIBtest", "-----END CERTIFICATE-----"].join("\n");
const LOCAL_DB = "postgres://postgres@127.0.0.1:55432/postgres";
const REMOTE_DB = `postgres://postgres:${DB_PASSWORD}@db.abcd.supabase.co:5432/postgres`;

const SERVER_BASE: Record<string, string> = {
  DATABASE_URL: "postgres://zs_api_runtime@127.0.0.1:55432/zs",
  JWT_VERIFIER: "hs256",
  JWT_SECRET: ["test", "jwt", "j".repeat(32)].join("-"),
  SESSION_CHECK: "local-stub",
};
const serverError = (env: Record<string, string>) => {
  try {
    parseServerEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseServerEnv accepted the environment");
};

describe("API environment (W-14)", () => {
  it("leaves the Activepieces routes off until ACTIVEPIECES_KEY_SECRET is set", () => {
    expect(parseServerEnv(SERVER_BASE).activepieces).toBeNull();
    expect(parseServerEnv({ ...SERVER_BASE, ACTIVEPIECES_KEY_SECRET, ACTIVEPIECES_KEY_PREVIOUS_SECRET: PREVIOUS_KEY }).activepieces)
      .toEqual({ keySecrets: { current: ACTIVEPIECES_KEY_SECRET, previous: PREVIOUS_KEY }, allowLoopback: false });
  });

  it("refuses a short or placeholder key, and a previous key on its own", () => {
    expect(serverError({ ...SERVER_BASE, ACTIVEPIECES_KEY_SECRET: "short" })).toMatch(/at least 32 characters/);
    expect(serverError({ ...SERVER_BASE, ACTIVEPIECES_KEY_SECRET: PLACEHOLDER_ACTIVEPIECES_KEY_SECRET })).toMatch(/placeholder/);
    expect(serverError({ ...SERVER_BASE, ACTIVEPIECES_KEY_PREVIOUS_SECRET: PREVIOUS_KEY })).toMatch(/needs ACTIVEPIECES_KEY_SECRET/);
  });

  it("allows loopback receivers only for a loopback database", () => {
    expect(parseServerEnv({ ...SERVER_BASE, ACTIVEPIECES_KEY_SECRET, ACTIVEPIECES_ALLOW_LOOPBACK: "on" }).activepieces?.allowLoopback).toBe(true);
    expect(serverError({
      ...SERVER_BASE, DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT, JWT_VERIFIER: "hs256", SESSION_CHECK: "supabase",
      SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_ANON_KEY: "anon",
      ACTIVEPIECES_KEY_SECRET, ACTIVEPIECES_ALLOW_LOOPBACK: "on",
    })).toMatch(/ACTIVEPIECES_ALLOW_LOOPBACK=on needs a loopback database URL/);
    expect(serverError({ ...SERVER_BASE, ACTIVEPIECES_ALLOW_LOOPBACK: "yes" })).toMatch(/ACTIVEPIECES_ALLOW_LOOPBACK/);
  });
});

const WORKER_ON: Record<string, string> = {
  ACTIVEPIECES_WEBHOOK_WORKER: "on",
  ACTIVEPIECES_DATABASE_URL: LOCAL_DB,
  ACTIVEPIECES_KEY_SECRET,
};
const workerError = (env: Record<string, string | undefined>): string => {
  try {
    parseActivepiecesWorkerEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseActivepiecesWorkerEnv accepted the environment");
};

describe("webhook worker environment (W-14)", () => {
  it("runs nothing and needs nothing else while the switch is unset or off", () => {
    expect(parseActivepiecesWorkerEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseActivepiecesWorkerEnv({ ACTIVEPIECES_WEBHOOK_WORKER: "off", ACTIVEPIECES_DATABASE_URL: "not a url" }))
      .toEqual({ runner: null, cronSecret: null });
    expect(parseActivepiecesWorkerEnv({ CRON_SECRET })).toEqual({ runner: null, cronSecret: CRON_SECRET });
  });

  it.each(["ON", "true", "1", ""])("refuses ACTIVEPIECES_WEBHOOK_WORKER=%j", (value) => {
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_WEBHOOK_WORKER: value })).toMatch(/must be on or off/);
  });

  it("reads a complete environment with its defaults", () => {
    expect(parseActivepiecesWorkerEnv({ ...WORKER_ON, CRON_SECRET, ACTIVEPIECES_KEY_PREVIOUS_SECRET: PREVIOUS_KEY })).toEqual({
      cronSecret: CRON_SECRET,
      runner: {
        serviceDatabaseUrl: LOCAL_DB, databaseCaCert: undefined,
        keySecrets: { current: ACTIVEPIECES_KEY_SECRET, previous: PREVIOUS_KEY }, allowLoopback: false,
        workerId: "activepieces", budgetMs: 20_000, claimLimit: 2, requestTimeoutMs: 5_000, maxAttempts: 8, intervalMs: 15_000,
      },
    });
  });

  it("needs the key, a CA for a remote database, no query string, and a claim limit that fits the budget", () => {
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_KEY_SECRET: undefined })).toMatch(/ACTIVEPIECES_KEY_SECRET/);
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_KEY_SECRET: PLACEHOLDER_ACTIVEPIECES_KEY_SECRET })).toMatch(/placeholder/);
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_DATABASE_URL: REMOTE_DB })).toMatch(/DATABASE_CA_CERT is required/);
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_DATABASE_URL: `${REMOTE_DB}?sslmode=disable`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_CLAIM_LIMIT: "10", ACTIVEPIECES_REQUEST_TIMEOUT_MS: "5000" }))
      .toMatch(/must fit in ACTIVEPIECES_RUN_BUDGET_MS/);
    expect(workerError({ ...WORKER_ON, ACTIVEPIECES_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT, ACTIVEPIECES_ALLOW_LOOPBACK: "on" }))
      .toMatch(/needs a loopback database URL/);
    expect(workerError({ ...WORKER_ON, CRON_SECRET: "short" })).toMatch(/CRON_SECRET must be at least 32/);
  });

  it("lets the Node worker take a long budget, but the cron entry only one its 30 s function can finish", () => {
    const long = parseActivepiecesWorkerEnv({ ...WORKER_ON, ACTIVEPIECES_RUN_BUDGET_MS: "600000" });
    expect(long.runner).toMatchObject({ budgetMs: 600_000 });
    expect(() => assertActivepiecesCronFits(long.runner)).toThrow(/ACTIVEPIECES_RUN_BUDGET_MS must be at most 20000 for the cron function/);
    expect(() => assertActivepiecesCronFits(parseActivepiecesWorkerEnv({ ...WORKER_ON, ACTIVEPIECES_RUN_BUDGET_MS: "20001" }).runner))
      .toThrow(/at most 20000/);
    // The defaults fit, and so does the switch being off.
    expect(() => assertActivepiecesCronFits(parseActivepiecesWorkerEnv(WORKER_ON).runner)).not.toThrow();
    expect(() => assertActivepiecesCronFits(parseActivepiecesWorkerEnv({}).runner)).not.toThrow();
  });

  it("never puts a secret value in an error message", () => {
    const messages = [
      workerError({ ...WORKER_ON, ACTIVEPIECES_DATABASE_URL: REMOTE_DB, ACTIVEPIECES_KEY_SECRET: `${ACTIVEPIECES_KEY_SECRET}` }),
      workerError({ ...WORKER_ON, ACTIVEPIECES_KEY_SECRET: PREVIOUS_KEY.slice(0, 20) }),
      serverError({ ...SERVER_BASE, ACTIVEPIECES_KEY_SECRET: PREVIOUS_KEY.slice(0, 20) }),
    ];
    for (const message of messages)
      for (const secret of [DB_PASSWORD, ACTIVEPIECES_KEY_SECRET, PREVIOUS_KEY.slice(0, 20)]) expect(message).not.toContain(secret);
  });
});

describe("GET /cron/activepieces", () => {
  const result: ActivepiecesRunSummary = { passes: 1, ingested: 2, claimed: 2, delivered: 2, retried: 0, dead: 0, errors: 0, budgetSpent: false };
  const cron = (config: Parameters<typeof activepiecesCronRoutes>[0], authorization?: string) =>
    activepiecesCronRoutes(config).request("/cron/activepieces", authorization === undefined ? {} : { headers: { Authorization: authorization } });

  it("is not found without CRON_SECRET, 401 with a wrong one, and never runs either way", async () => {
    const run = vi.fn(async () => result);
    expect((await cron({ cronSecret: null, runner: { run } }, `Bearer ${CRON_SECRET}`)).status).toBe(404);
    for (const authorization of [undefined, CRON_SECRET, `Bearer ${CRON_SECRET}x`, `bearer ${CRON_SECRET}`])
      expect((await cron({ cronSecret: CRON_SECRET, runner: { run } }, authorization)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("answers 200 without running while the switch is off, and the summary when on", async () => {
    const off = await cron({ cronSecret: CRON_SECRET, runner: null }, `Bearer ${CRON_SECRET}`);
    expect(await off.json()).toEqual({ ran: false, reason: "ACTIVEPIECES_WEBHOOK_WORKER is off" });
    const run = vi.fn(async () => result);
    const on = await cron({ cronSecret: CRON_SECRET, runner: { run } }, `Bearer ${CRON_SECRET}`);
    expect(on.headers.get("cache-control")).toBe("no-store");
    expect(await on.json()).toEqual({ ran: true, ...result });
  });

  it("answers 503 without details when a run throws", async () => {
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner: { run: async () => { throw new Error("pool gone"); } }, onError },
      `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("pool gone");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("one flow over HTTP (W-1..W-13)", () => {
  let at = Date.parse(NOW);
  const clock = { now: () => new Date(at) };
  let h: ApiHarness;
  let off: ApiHarness | undefined;
  let port = 0;
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  const runnerEnv = (): ActivepiecesRunnerEnv => ({
    serviceDatabaseUrl: LOCAL_DB, databaseCaCert: undefined, keySecrets: { current: ACTIVEPIECES_KEY_SECRET }, allowLoopback: true,
    workerId: "api-test", budgetMs: 20_000, claimLimit: 2, requestTimeoutMs: 2_000, maxAttempts: 3, intervalMs: 15_000,
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    port = (receiver.address() as AddressInfo).port;
    h = await createApiHarness({ clock, activepieces: { urlPolicy: { allowLoopback: true } } });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { receiver.closeAllConnections(); receiver.close(() => resolve()); });
    await off?.close();
    await h?.close();
  });

  it("is off, as 404, while the API has no Activepieces key", async () => {
    off = await createApiHarness();
    expect((await call(off.app, "GET", "/v1/integrations/activepieces/webhooks", { token: off.a.token })).status).toBe(404);
    expect((await call(off.app, "GET", "/integrations/activepieces/v1/me")).status).toBe(404);
  });

  it("refuses staff and a public-address check failure at the edge", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const denied = await call(h.app, "POST", "/v1/integrations/activepieces/webhooks", {
      token: staff.token, key: randomUUID(), body: { url: `http://127.0.0.1:${port}/hook`, events: ["booking.created"] },
    });
    expect(denied.status).toBe(403);
    const refused = await call(h.app, "POST", "/v1/integrations/activepieces/webhooks", {
      token: h.a.token, key: randomUUID(), body: { url: "https://169.254.169.254/latest", events: ["booking.created"] },
    });
    expect(refused.status).toBe(400);
  });

  it("sends a signed booking event, takes a proposal with the token, and acts only once an owner approves", async () => {
    // The owner adds the flow's webhook URL and pastes the secret into the flow.
    const created = await call(h.app, "POST", "/v1/integrations/activepieces/webhooks", {
      token: h.a.token, key: randomUUID(), body: { url: `http://127.0.0.1:${port}/api/v1/webhooks/flow1`, events: ["booking.created"] },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { endpoint, signingSecret } = webhookEndpointWithSecretSchema.parse(created.body);
    const listed = await call(h.app, "GET", "/v1/integrations/activepieces/webhooks", { token: h.a.token });
    expect(JSON.stringify(listed.body)).not.toContain(signingSecret);
    // Tenant B sees none of it.
    expect((await call(h.app, "GET", `/v1/integrations/activepieces/webhooks/${endpoint.id}/deliveries`, { token: h.b.token })).status)
      .toBe(404);

    at += 1_000;
    const booking = await call(h.app, "POST", "/v1/booking/bookings", {
      token: h.a.token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: "2026-10-19T10:00:00.000Z" },
    });
    expect(booking.status).toBe(201);
    const worker = createWebhookWorkerFromEnv({ env: runnerEnv(), pool: h.database.servicePool, clock, generateId: randomUUID });
    const summary = await createActivepiecesRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run();
    expect(summary).toMatchObject({ ingested: 1, claimed: 1, delivered: 1 });
    expect(received).toHaveLength(1);
    const [hit] = received;
    const verified = verifyResendWebhook({
      secrets: { current: signingSecret },
      headers: { id: String(hit!.headers["webhook-id"]), timestamp: String(hit!.headers["webhook-timestamp"]), signature: String(hit!.headers["webhook-signature"]) },
      body: Buffer.from(hit!.body),
      now: clock.now(),
    });
    expect(verified).toMatchObject({ ok: true, payload: { type: "booking.created", tenantId: h.a.tenantId } });
    const deliveries = webhookDeliveryPageSchema.parse((await call(h.app, "GET",
      `/v1/integrations/activepieces/webhooks/${endpoint.id}/deliveries`, { token: h.a.token })).body);
    expect(deliveries.items.map((item) => item.status)).toEqual(["delivered"]);

    // The owner makes a token for the flow; the flow then proposes a contact.
    const minted = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
      token: h.a.token, key: randomUUID(), body: { name: "Lead flow", scopes: ["contacts:propose"] },
    });
    expect(minted.status).toBe(201);
    const { token, secret } = automationTokenWithSecretSchema.parse(minted.body);
    const flow = { Authorization: `Bearer ${secret}` };
    const me = await call(h.app, "GET", "/integrations/activepieces/v1/me", { headers: flow });
    expect(automationWhoAmISchema.parse(me.body)).toMatchObject({ tokenId: token.id, scopes: ["contacts:propose"] });
    const unsigned = await call(h.app, "GET", "/integrations/activepieces/v1/me", { headers: { Authorization: "Bearer nope" } });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("www-authenticate")).toBe("Bearer");
    // A member's session token is not an automation token.
    expect((await call(h.app, "GET", "/integrations/activepieces/v1/me", { token: h.a.token })).status).toBe(401);

    const email = `lead-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const proposeKey = randomUUID();
    const propose = () => call(h.app, "POST", "/integrations/activepieces/v1/proposals", {
      headers: flow, key: proposeKey, body: { action: "contact.upsert", input: { displayName: "Rowan Halden", email } },
    });
    const proposed = await propose();
    expect(proposed.status).toBe(201);
    const proposal = proposalRecordSchema.parse(proposed.body);
    expect(proposal).toMatchObject({ action: "contact.upsert", standing: "pending", executed: false });
    expect(proposalRecordSchema.parse((await propose()).body).id).toBe(proposal.id);
    expect((await call(h.app, "POST", "/integrations/activepieces/v1/proposals", {
      headers: flow, key: randomUUID(), body: { action: "booking.create", input: { resourceId: h.a.resourceId, startsAt: "2026-10-19T11:00:00.000Z" } },
    })).status).toBe(403);
    const contacts = async () => (await h.fixture.service((tx) => tx.query(
      "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [h.a.tenantId, email]))).rows;
    expect(await contacts()).toHaveLength(0);

    const approved = await call(h.app, "POST", `/v1/approvals/${proposal.id}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status).toBe(200);
    expect(await contacts()).toHaveLength(1);
    const after = proposalRecordSchema.parse((await call(h.app, "GET", `/integrations/activepieces/v1/proposals/${proposal.id}`,
      { headers: flow })).body);
    expect(after).toMatchObject({ standing: "approved", executed: true });

    // Revoked, the token stops at once.
    expect((await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${token.id}/revoke`, { token: h.a.token, key: randomUUID(), body: {} }))
      .status).toBe(200);
    expect((await call(h.app, "GET", "/integrations/activepieces/v1/me", { headers: flow })).status).toBe(401);
  });
});
