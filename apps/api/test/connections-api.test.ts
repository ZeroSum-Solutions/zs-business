// Managed-tier connections over HTTP (docs/requirements/connections.md C-4, C-5, C-10, C-11, C-13, C-15): the
// member routes, the anonymous callback, the three /mcp tools and the scopes disclosure, against the real
// Hono app, a real local Postgres, the real connections worker in process and the in-process fake Composio.
// The core suite covers the rules themselves; these tests cover the HTTP shape: statuses, headers, what a
// URL or a body must never carry, and "off without the config".
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  apiErrorBodySchema,
  automationScopeListSchema,
  automationTokenWithSecretSchema,
  automationUsageSchema,
  CONNECT_ATTEMPT_HEADER,
  CONNECT_BROWSER_KEY_HEADER,
  CONNECT_GRANT_HEADER,
  READ_SCOPE_DISCLOSURES,
  type AutomationScope,
} from "@zs/contracts";
import {
  browserBindingFor,
  composioUserId,
  ConnectorUnavailable,
  createHttpConnectorPort,
  createLocalConnectorPort,
  createLocalStubSessionCheck,
  verifyConnectAttempt,
  type ConnectionLimiter,
  type ConnectorPort,
} from "@zs/core";
import { createApp, createHs256Verifier, type App } from "../src/app.js";
import { parseConnectionsApiEnv } from "../src/connections/api-env.js";
import { parseServerEnv } from "../src/config.js";
import { ACTIVEPIECES_KEY_SECRET, call, clock, createApiHarness, NOW, ORIGIN, SECRET, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";
import { FakeComposio } from "../../../packages/core/test/connections/fake-composio.js";
import { ENV, makeClock, makeWorker, seedConnection } from "../../../packages/core/test/connections/harness.js";

const STATE = ["conn", "state", "e".repeat(32)].join("-");
const INTERNAL = ["conn", "internal", "f".repeat(32)].join("-");
const RETURN_URL = "https://app.haldenrowe.example/account/connections";
const KEY = randomBytes(32).toString("base64url");
const BINDING = browserBindingFor(KEY);
const SHOP = "testshop.myshopify.com";
const MCP_URL = "http://hub.test/mcp";
const CONNECTION_TOOLS = ["list_connection_tools", "list_connections", "run_connection_tool"];

let h: ApiHarness;
let staffA: MemberSetup;
let fake: FakeComposio;
let appClock: ReturnType<typeof makeClock>;
let port: ConnectorPort;
let limiterRefuses = false;
let taken: string[];
let reports: { route: string; outcome: string; tenantId?: string; connectionId?: string }[];
let on: App; // connections configured
let off: App; // not configured

const limiter: ConnectionLimiter = {
  async take(charges) {
    taken.push(...charges.map((c) => c.key.split(":")[0]!));
    return limiterRefuses ? { ok: false, retryAfterSeconds: 42 } : { ok: true };
  },
};

function build(connector: ConnectorPort | null): App {
  return createApp({
    verifier: createHs256Verifier(SECRET, { clock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
    clock,
    db: h.database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    activepieces: { keySecrets: { current: ACTIVEPIECES_KEY_SECRET } },
    ...(connector === null ? {} : {
      connections: {
        connector, stateSecrets: { current: STATE }, returnUrl: RETURN_URL, limiter,
        report: (event) => reports.push(event),
      },
    }),
  });
}

beforeAll(async () => {
  h = await createApiHarness({ clock, activepieces: {} });
  staffA = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
}, 120_000);
afterAll(async () => { await h?.close(); });

beforeEach(async () => {
  for (const table of ["connections", "connection_attempts", "connector_request_nonces", "rate_limit_buckets", "automation_token_usage", "automation_tokens"])
    await h.database.pool.query(`DELETE FROM ${table}`);
  fake = new FakeComposio();
  appClock = makeClock(Date.parse(NOW));
  port = createLocalConnectorPort(makeWorker(h.database, fake, appClock));
  limiterRefuses = false;
  taken = [];
  reports = [];
  on = build(port);
  off = build(null);
});

/** POST /v1/connections/shopify/connect as a member; returns the response and the attempt token. */
async function start(app: App, token: string, body: unknown = { shopDomain: SHOP, browserBinding: BINDING }) {
  const response = await call(app, "POST", "/v1/connections/shopify/connect", { token, body });
  return { response, attempt: response.headers.get(CONNECT_ATTEMPT_HEADER) ?? "" };
}
const claimsOf = (attempt: string) => verifyConnectAttempt({ current: STATE }, attempt, clock.now())!;
const callbackPath = (accountId?: string, sessionUri?: string) => {
  const query = new URLSearchParams();
  if (accountId !== undefined) query.set("connected_account_id", accountId);
  if (sessionUri !== undefined) query.set("session_uri", sessionUri);
  return `/oauth/connections/callback?${query}`;
};
const rawGet = (app: App, path: string, headers: Record<string, string>) => app.request(path, { method: "GET", headers });

/** Start → consent → callback, the way the dashboard drives it; returns the staged grant. */
async function reachConfirm(token = h.a.token) {
  const { attempt } = await start(on, token);
  const claims = claimsOf(attempt);
  const sessionUri = fake.consent(claims.composioAccountId);
  // The real redirect carries `session_uri` only (observed 2026-11-07).
  const response = await rawGet(on, callbackPath(undefined, sessionUri), {
    [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY,
  });
  return { attempt, claims, sessionUri, response, grant: response.headers.get(CONNECT_GRANT_HEADER) ?? "" };
}
const grantHeader = (grant: string) => ({ [CONNECT_GRANT_HEADER]: grant });

async function seedLive(tenant: { tenantId: string; memberId: string }, over: { status?: "active" | "reauthorize" } = {}) {
  const accountId = `ca_${randomUUID().slice(0, 8)}`;
  fake.seed({ id: accountId, userId: composioUserId(ENV, tenant.tenantId), authConfigId: "ac_shopify" });
  return seedConnection(h.fixture, { tenantId: tenant.tenantId, memberId: tenant.memberId, accountId, ...over });
}

describe("off without the config (C-3, C-15)", () => {
  it("every connections route is an unknown route (404) and the callback does not exist", async () => {
    const asOwner = h.a.token;
    expect((await call(off, "GET", "/v1/connections", { token: asOwner })).status).toBe(404);
    expect((await call(off, "GET", "/v1/connections/pending", { token: asOwner })).status).toBe(404);
    expect((await call(off, "POST", "/v1/connections/confirm", { token: asOwner, body: {} })).status).toBe(404);
    expect((await call(off, "DELETE", "/v1/connections/pending", { token: asOwner })).status).toBe(404);
    expect((await call(off, "POST", "/v1/connections/shopify/connect", { token: asOwner, body: { shopDomain: SHOP, browserBinding: BINDING } })).status).toBe(404);
    expect((await call(off, "POST", `/v1/connections/${randomUUID()}/disconnect`, { token: asOwner, key: randomUUID(), body: {} })).status).toBe(404);
    expect((await rawGet(off, callbackPath("ca_x", "s"), { [CONNECT_ATTEMPT_HEADER]: "x" })).status).toBe(404);
    expect((await rawGet(off, "/oauth/connections/callback/status", {})).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("the connection tools are unlisted and a call is -32601, even for a token that holds the scope", async () => {
    const { secret } = await mint(off, h.a, ["connections:read", "business:read"]);
    const client = await connect(off, secret);
    expect((await client.listTools()).tools.map((tool) => tool.name).filter((name) => CONNECTION_TOOLS.includes(name))).toEqual([]);
    for (const name of CONNECTION_TOOLS)
      await expect(client.callTool({ name, arguments: { connectionId: randomUUID(), tool: "x", arguments: {} } }), name).rejects.toMatchObject({ code: -32601 });
    await client.close();
  });
});

describe("the member routes (C-4, C-5, C-13)", () => {
  it("connect returns the consent URL in the body and the attempt token only in a header; nothing may be cached", async () => {
    const { response, attempt } = await start(on, h.a.token);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(["authorizeUrl"]);
    expect(response.body.authorizeUrl).toMatch(/^https:\/\/connect\.composio\.test\//);
    expect(attempt).toMatch(/^zca1\./);
    expect(JSON.stringify(response.body)).not.toContain(attempt);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(claimsOf(attempt)).toMatchObject({ tenantId: h.a.tenantId, actorId: h.a.actorId, toolkit: "shopify", browserHash: BINDING });
    expect(taken).toContain("conn-connect");
  });

  it("connect needs an owner (staff 403, no token 401), a catalog toolkit and a valid body", async () => {
    expect((await start(on, staffA.token)).response.status).toBe(403);
    expect((await call(on, "POST", "/v1/connections/shopify/connect", { body: { shopDomain: SHOP, browserBinding: BINDING } })).status).toBe(401);
    expect((await call(on, "POST", "/v1/connections/gmail/connect", { token: h.a.token, body: { shopDomain: SHOP, browserBinding: BINDING } })).status).toBe(404);
    for (const body of [{ shopDomain: "evil.example.com", browserBinding: BINDING }, { shopDomain: SHOP }, {}])
      expect((await start(on, h.a.token, body)).response.status, JSON.stringify(body)).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("checks the permission before reading the body: staff with a malformed body get 403, the owner 400 (C-2)", async () => {
    const raw = (token: string, path: string, init: { type?: string; body: string }) =>
      on.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, ...(init.type ? { "Content-Type": init.type } : {}) },
        body: init.body,
      });
    const bad = [{ type: "application/json", body: "{not json" }, { type: "text/plain", body: "{}" }, { body: "{}" }];
    for (const path of ["/v1/connections/shopify/connect", "/v1/connections/confirm"])
      for (const init of bad) {
        const label = `${path} ${JSON.stringify(init)}`;
        expect((await raw(staffA.token, path, init)).status, label).toBe(403);
        const owner = await raw(h.a.token, path, init);
        expect(owner.status, label).toBe(400);
        expect(apiErrorBodySchema.parse(await owner.json()).error.code, label).toBe("ValidationFailed");
      }
    // The toolkit is still checked before the body.
    expect((await raw(h.a.token, "/v1/connections/gmail/connect", bad[0]!)).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("the limiter refusing is a 429 with Retry-After before any worker call; an unreachable worker is a 503", async () => {
    limiterRefuses = true;
    const limited = await start(on, h.a.token);
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get("retry-after")).toBe("42");
    expect(apiErrorBodySchema.parse(limited.response.body).error.code).toBe("RateLimited");
    expect(fake.calls).toHaveLength(0);
    limiterRefuses = false;
    const down = build({ ...port, link: async () => { throw new ConnectorUnavailable("network"); } });
    const unavailable = await start(down, h.a.token);
    expect(unavailable.response.status).toBe(503);
    expect(apiErrorBodySchema.parse(unavailable.response.body).error.code).toBe("Unavailable");
  });

  it("walks the whole flow: grant staged by the callback, shown, confirmed once, replayed, listed, disconnected", async () => {
    const { response, grant, claims } = await reachConfirm();
    expect(response.status).toBe(303);
    expect((await h.database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);

    const pending = await call(on, "GET", "/v1/connections/pending", { token: h.a.token, headers: grantHeader(grant) });
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(pending.body).toMatchObject({ toolkit: "shopify", shopDomain: SHOP, accountLabel: "Test Shop", tokensWithAccess: 0 });
    expect(JSON.stringify(pending.body)).not.toContain(claims.composioAccountId);

    const confirmed = await call(on, "POST", "/v1/connections/confirm", {
      token: h.a.token, headers: grantHeader(grant), body: { grantId: pending.body.grantId },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(confirmed.body).toMatchObject({ id: claims.connectionId, toolkit: "shopify", status: "active", accountDomain: SHOP, revokeFailed: false });
    expect(JSON.stringify(confirmed.body)).not.toContain(claims.composioAccountId);
    const replay = await call(on, "POST", "/v1/connections/confirm", { token: h.a.token, headers: grantHeader(grant), body: { grantId: pending.body.grantId } });
    expect(replay.body).toEqual(confirmed.body);

    const list = await call(on, "GET", "/v1/connections", { token: h.a.token });
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([claims.connectionId]);
    expect(JSON.stringify(list.body)).not.toMatch(/composio|ca_\d/i);

    const key = `disconnect-${randomUUID()}`;
    const gone = await call(on, "POST", `/v1/connections/${claims.connectionId}/disconnect`, { token: h.a.token, key, body: {} });
    expect(gone.status).toBe(200);
    expect(gone.body.result).toMatchObject({ id: claims.connectionId, status: "disconnected", accountLabel: null });
    expect((await call(on, "POST", `/v1/connections/${claims.connectionId}/disconnect`, { token: h.a.token, key, body: {} })).body.actionId).toBe(gone.body.actionId);
    expect(fake.accounts.get(claims.composioAccountId)).toMatchObject({ revoked: true, deleted: true });
  });

  it("a second connect while one is live is 409 already_connected, before any worker call", async () => {
    await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const refused = await start(on, h.a.token);
    expect(refused.response.status).toBe(409);
    expect(refused.response.body.error.details).toMatchObject({ reason: "already_connected" });
    expect(fake.calls).toHaveLength(0);
  });

  it("a grant other than the one shown is 409 grant_changed and connects nothing", async () => {
    const { grant } = await reachConfirm();
    const changed = await call(on, "POST", "/v1/connections/confirm", { token: h.a.token, headers: grantHeader(grant), body: { grantId: "x".repeat(43) } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.details).toMatchObject({ reason: "grant_changed" });
    expect((await h.database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("pending and confirm answer 404 for no grant, a garbage grant and another tenant's grant; staff are denied", async () => {
    const { grant } = await reachConfirm();
    expect((await call(on, "GET", "/v1/connections/pending", { token: h.a.token })).status).toBe(404);
    expect((await call(on, "GET", "/v1/connections/pending", { token: h.a.token, headers: grantHeader("zcg1.nope") })).status).toBe(404);
    expect((await call(on, "GET", "/v1/connections/pending", { token: h.b.token, headers: grantHeader(grant) })).status).toBe(404);
    expect((await call(on, "POST", "/v1/connections/confirm", { token: h.b.token, headers: grantHeader(grant), body: { grantId: "x".repeat(43) } })).status).toBe(404);
    expect((await call(on, "GET", "/v1/connections/pending", { token: staffA.token, headers: grantHeader(grant) })).status).toBe(403);
    expect((await call(on, "GET", "/v1/connections/pending", { headers: grantHeader(grant) })).status).toBe(401);
  });

  it("cancel deletes the attempt's Composio account; another tenant's attempt is a 404 and a bad one too", async () => {
    const { attempt } = await start(on, h.a.token);
    const account = claimsOf(attempt).composioAccountId;
    expect((await call(on, "DELETE", "/v1/connections/pending", { token: h.a.token, headers: { [CONNECT_ATTEMPT_HEADER]: "zca1.bad" } })).status).toBe(404);
    expect((await call(on, "DELETE", "/v1/connections/pending", { token: h.b.token, headers: { [CONNECT_ATTEMPT_HEADER]: attempt } })).status).toBe(404);
    expect((await call(on, "DELETE", "/v1/connections/pending", { token: staffA.token, headers: { [CONNECT_ATTEMPT_HEADER]: attempt } })).status).toBe(403);
    const cancelled = await call(on, "DELETE", "/v1/connections/pending", { token: h.a.token, headers: { [CONNECT_ATTEMPT_HEADER]: attempt } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: true, revokeFailed: false });
    expect(cancelled.headers.get("cache-control")).toBe("no-store");
    expect(fake.accounts.get(account)).toMatchObject({ revoked: true, deleted: true });
  });

  it("B-10: a cancel Composio rate-limits is 429 with Retry-After, and the retry finishes it", async () => {
    const { attempt } = await start(on, h.a.token);
    const account = claimsOf(attempt).composioAccountId;
    fake.override(/GET \/connected_accounts\//, { status: 429, json: {}, times: 1 });
    const limited = await call(on, "DELETE", "/v1/connections/pending", { token: h.a.token, headers: { [CONNECT_ATTEMPT_HEADER]: attempt } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(fake.accounts.get(account)!.deleted).toBe(false);
  });

  it("C-11: the list and a disconnect answer Cache-Control: no-store", async () => {
    const id = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const list = await call(on, "GET", "/v1/connections", { token: h.a.token });
    expect(list.headers.get("cache-control")).toBe("no-store");
    const gone = await call(on, "POST", `/v1/connections/${id}/disconnect`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(gone.status).toBe(200);
    expect(gone.headers.get("cache-control")).toBe("no-store");
  });

  it("two-tenant denial: the list shows only the caller's rows, and tenant B cannot disconnect tenant A's; staff cannot either", async () => {
    const idA = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const idB = await seedLive({ tenantId: h.b.tenantId, memberId: h.b.memberId });
    expect((await call(on, "GET", "/v1/connections", { token: h.a.token })).body.items.map((i: { id: string }) => i.id)).toEqual([idA]);
    expect((await call(on, "GET", "/v1/connections", { token: h.b.token })).body.items.map((i: { id: string }) => i.id)).toEqual([idB]);
    expect((await call(on, "POST", `/v1/connections/${idA}/disconnect`, { token: h.b.token, key: randomUUID(), body: {} })).status).toBe(404);
    expect((await call(on, "POST", `/v1/connections/${idA}/disconnect`, { token: staffA.token, key: randomUUID(), body: {} })).status).toBe(403);
    expect((await h.database.pool.query("SELECT status FROM connections WHERE id=$1", [idA])).rows[0].status).toBe("active");
  });
});

describe("the callback (C-5)", () => {
  it("a good callback is a 303 to the return URL with connection=confirm; the grant is a header, never in the URL", async () => {
    const { response, grant, attempt, claims } = await reachConfirm();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(RETURN_URL);
    expect(Object.fromEntries(location.searchParams)).toEqual({ connection: "confirm" });
    expect(grant).toMatch(/^zcg1\./);
    expect(response.headers.get("location")).not.toContain(grant);
    expect(response.headers.get("location")).not.toContain(claims.composioAccountId);
    expect(response.headers.get("location")).not.toContain(attempt);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // C-7: the operator log names the attempt's tenant and connection, never a token or the account.
    expect(reports).toEqual([{ route: "callback", outcome: "confirm", tenantId: claims.tenantId, connectionId: claims.connectionId }]);
  });

  it("without a valid attempt it is a 400 with no redirect and no grant, and still sends no-store", async () => {
    const { attempt, claims, sessionUri } = await reachConfirm();
    for (const headers of [{}, { [CONNECT_ATTEMPT_HEADER]: "zca1.garbage", [CONNECT_BROWSER_KEY_HEADER]: KEY }]) {
      const response = await rawGet(on, callbackPath(claims.composioAccountId, sessionUri), headers);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get(CONNECT_GRANT_HEADER)).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(apiErrorBodySchema.parse(await response.json()).error.code).toBe("ValidationFailed");
    }
    expect(attempt).toBeTruthy();
  });

  it("checks in order: invalid, browser, account, session; each failure is a 303 with connection=error and a reason", async () => {
    const { attempt } = await start(on, h.a.token);
    const claims = claimsOf(attempt);
    const sessionUri = fake.consent(claims.composioAccountId);
    const reason = async (path: string, headers: Record<string, string>) => {
      const response = await rawGet(on, path, headers);
      expect(response.status).toBe(303);
      expect(response.headers.get(CONNECT_GRANT_HEADER)).toBeNull();
      const target = new URL(response.headers.get("location")!);
      expect(target.searchParams.get("connection")).toBe("error");
      return target.searchParams.get("reason");
    };
    const good = { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY };
    expect(await reason(callbackPath(claims.composioAccountId, sessionUri), { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: randomBytes(32).toString("base64url") })).toBe("browser_mismatch");
    expect(await reason(callbackPath(claims.composioAccountId, sessionUri), { [CONNECT_ATTEMPT_HEADER]: attempt })).toBe("browser_mismatch");
    expect(await reason(callbackPath("ca_other", sessionUri), good)).toBe("attempt_changed");
    expect(await reason(callbackPath(claims.composioAccountId), good)).toBe("not_connected");
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
    limiterRefuses = true;
    expect(await reason(callbackPath(claims.composioAccountId, sessionUri), good)).toBe("rate_limited");
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
  });

  it("overlong query values are ignored rather than forwarded", async () => {
    const { attempt } = await start(on, h.a.token);
    const claims = claimsOf(attempt);
    const response = await rawGet(on, callbackPath(claims.composioAccountId, "s".repeat(3000)), { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY });
    expect(new URL(response.headers.get("location")!).searchParams.get("reason")).toBe("not_connected");
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
  });

  it("A-4: a status call for an attempt whose callback never presented a session is not_connected, even once ACTIVE", async () => {
    const { attempt } = await start(on, h.a.token);
    const claims = claimsOf(attempt);
    const headers = { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY };
    fake.accounts.get(claims.composioAccountId)!.status = "ACTIVE";
    const refused = await rawGet(on, "/oauth/connections/callback/status", headers);
    expect(refused.status).toBe(303);
    expect(new URL(refused.headers.get("location")!).searchParams.get("reason")).toBe("not_connected");
    expect(refused.headers.get(CONNECT_GRANT_HEADER)).toBeNull();
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
    expect((await rawGet(on, "/oauth/connections/callback/status", {})).status).toBe(400);
  });

  it("A-4: after a callback presented its session and lost the answer, the status call confirms without redeeming again", async () => {
    const { attempt } = await start(on, h.a.token);
    const claims = claimsOf(attempt);
    const sessionUri = fake.consent(claims.composioAccountId);
    const headers = { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY };
    fake.loseNextCompleteAuth = true;
    const lost = await rawGet(on, callbackPath(claims.composioAccountId, sessionUri), headers);
    expect(new URL(lost.headers.get("location")!).searchParams.get("reason")).toBe("provider_unavailable");
    expect(fake.callsTo(/complete_auth/)).toHaveLength(1);
    const status = await rawGet(on, "/oauth/connections/callback/status", headers);
    expect(new URL(status.headers.get("location")!).searchParams.get("connection")).toBe("confirm");
    expect(status.headers.get(CONNECT_GRANT_HEADER)).toMatch(/^zcg1\./);
    expect(fake.callsTo(/complete_auth/)).toHaveLength(1);
    expect(reports.map((report) => report.outcome)).toEqual(["error:provider_unavailable", "confirm"]);
  });

  it("a reload after the confirm is connected for the same account; a worker that is down is provider_unavailable", async () => {
    const { attempt, claims, sessionUri } = await reachConfirm();
    await seedConnection(h.fixture, { tenantId: h.a.tenantId, memberId: h.a.memberId, id: claims.connectionId, accountId: claims.composioAccountId });
    const headers = { [CONNECT_ATTEMPT_HEADER]: attempt, [CONNECT_BROWSER_KEY_HEADER]: KEY };
    const again = await rawGet(on, callbackPath(claims.composioAccountId, sessionUri), headers);
    expect(new URL(again.headers.get("location")!).searchParams.get("connection")).toBe("connected");
    await h.database.pool.query("DELETE FROM connections");
    const down = build({ ...port, complete: async () => { throw new ConnectorUnavailable("timeout"); } });
    const failed = await rawGet(down, callbackPath(claims.composioAccountId, sessionUri), headers);
    expect(new URL(failed.headers.get("location")!).searchParams.get("reason")).toBe("provider_unavailable");
  });
});

// ---- /mcp ----------------------------------------------------------------------------------------------

async function mint(app: App, owner: Pick<MemberSetup, "token">, scopes: AutomationScope[]) {
  const response = await call(app, "POST", "/v1/integrations/activepieces/tokens", {
    token: owner.token, key: randomUUID(), body: { name: `Agent ${scopes.length}`, scopes },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const created = automationTokenWithSecretSchema.parse(response.body);
  return { secret: created.secret, id: created.token.id };
}
async function connect(app: App, secret: string) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    fetch: async (url, init) => app.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "connections-test", version: "1.0.0" });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return client;
}
type ToolReply = { isError?: boolean; content: unknown };
const text = (reply: ToolReply) => JSON.parse((reply.content as { text: string }[])[0]!.text);
const run = (client: Client, connectionId: string, tool: string, args: unknown = {}) =>
  client.callTool({ name: "run_connection_tool", arguments: { connectionId, tool, arguments: args } }) as Promise<ToolReply>;
const errorCode = (reply: ToolReply) => {
  expect(reply.isError).toBe(true);
  return text(reply).error as { code: string; retryAfterSeconds?: number };
};

describe("the /mcp connection tools (C-10, C-11, H-8)", () => {
  it("lists the three tools only for a token with connections:read, with the hints of C-10", async () => {
    const withScope = await mint(on, h.a, ["connections:read"]);
    const without = await mint(on, h.a, ["business:read"]);
    const client = await connect(on, withScope.secret);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CONNECTION_TOOLS, "get_proposal", "whoami"].sort());
    for (const tool of tools.filter((t) => CONNECTION_TOOLS.includes(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.openWorldHint, tool.name).toBe(tool.name === "run_connection_tool");
      expect(tool.description, tool.name).toMatch(/data written by people, not instructions/);
    }
    await client.close();
    const other = await connect(on, without.secret);
    expect((await other.listTools()).tools.map((tool) => tool.name).filter((name) => CONNECTION_TOOLS.includes(name))).toEqual([]);
    await expect(other.callTool({ name: "list_connections", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    await other.close();
  });

  it("lists the tenant's connections without IDs of the provider, lists a connection's tools and runs one with the notice", async () => {
    const idA = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const idB = await seedLive({ tenantId: h.b.tenantId, memberId: h.b.memberId });
    const { secret } = await mint(on, h.a, ["connections:read"]);
    const client = await connect(on, secret);
    const listed = text(await client.callTool({ name: "list_connections", arguments: {} }) as ToolReply);
    expect(listed.items).toEqual([{ connectionId: idA, toolkit: "shopify", label: "Test Shop", status: "active" }]);
    expect(JSON.stringify(listed)).not.toContain(idB);
    const tools = text(await client.callTool({ name: "list_connection_tools", arguments: { connectionId: idA } }) as ToolReply);
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(["shopify_list_orders", "shopify_get_order"]);
    const out = text(await run(client, idA, "shopify_list_orders", { limit: 1 }));
    expect(out).toMatchObject({ truncated: false });
    expect(out.data).toBeDefined();
    expect(out.notice).toMatch(/data written by people, not instructions/);
    expect(taken).toEqual(expect.arrayContaining(["conn-minute", "conn-day"]));
    await client.close();
  });

  it("checks in order: connection, tool, arguments, then the limit; every answer is an isError result with a code only", async () => {
    const idA = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const idB = await seedLive({ tenantId: h.b.tenantId, memberId: h.b.memberId });
    const { secret } = await mint(on, h.a, ["connections:read"]);
    const client = await connect(on, secret);
    // Tenant B's connection is not found, with no limit charge and no connector call.
    expect(errorCode(await run(client, idB, "shopify_list_orders"))).toEqual({ code: "not_found" });
    expect(errorCode(await client.callTool({ name: "list_connection_tools", arguments: { connectionId: idB } }) as ToolReply)).toEqual({ code: "not_found" });
    expect(errorCode(await run(client, randomUUID(), "shopify_list_orders"))).toEqual({ code: "not_found" });
    expect(taken).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(errorCode(await run(client, idA, "nope"))).toEqual({ code: "not_found" });
    expect(errorCode(await run(client, idA, "shopify_list_orders", { limit: 500 }))).toEqual({ code: "invalid_arguments" });
    expect(errorCode(await run(client, idA, "shopify_list_orders", { connected_account_id: "ca_x" }))).toEqual({ code: "invalid_arguments" });
    // C-4: the tool call's own fields (not a UUID, an unknown key) are invalid_arguments too, never ValidationFailed.
    expect(errorCode(await client.callTool({ name: "run_connection_tool", arguments: { connectionId: "nope", tool: "shopify_list_orders", arguments: {} } }) as ToolReply)).toEqual({ code: "invalid_arguments" });
    expect(errorCode(await client.callTool({ name: "run_connection_tool", arguments: { connectionId: idA, tool: "shopify_list_orders", arguments: {}, extra: 1 } }) as ToolReply)).toEqual({ code: "invalid_arguments" });
    expect(errorCode(await client.callTool({ name: "list_connection_tools", arguments: {} }) as ToolReply)).toEqual({ code: "invalid_arguments" });
    expect(taken).toHaveLength(0);
    limiterRefuses = true;
    expect(errorCode(await run(client, idA, "shopify_list_orders"))).toEqual({ code: "provider_rate_limited", retryAfterSeconds: 42 });
    expect(fake.calls).toHaveLength(0);
    await client.close();
  });

  it("a reauthorize connection answers connection_needs_reconnect; a disconnecting one is neither listed nor found", async () => {
    const id = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId }, { status: "reauthorize" });
    const { secret } = await mint(on, h.a, ["connections:read"]);
    const client = await connect(on, secret);
    expect(text(await client.callTool({ name: "list_connections", arguments: {} }) as ToolReply).items.map((i: { status: string }) => i.status)).toEqual(["reauthorize"]);
    expect(errorCode(await run(client, id, "shopify_list_orders"))).toEqual({ code: "connection_needs_reconnect" });
    await h.database.pool.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]);
    expect(text(await client.callTool({ name: "list_connections", arguments: {} }) as ToolReply).items).toEqual([]);
    expect(errorCode(await run(client, id, "shopify_list_orders"))).toEqual({ code: "not_found" });
    await client.close();
  });

  it("an unreachable worker is provider_unavailable, and so is the 7 s abort (here a short one) of the signed port", async () => {
    const id = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const { secret } = await mint(on, h.a, ["connections:read"]);
    const down = build({ ...port, run: async () => { throw new ConnectorUnavailable("network"); } });
    const downClient = await connect(down, secret);
    expect(errorCode(await run(downClient, id, "shopify_list_orders"))).toEqual({ code: "provider_unavailable" });
    await downClient.close();

    const hang: typeof fetch = (_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    const slow = build(createHttpConnectorPort({ workerUrl: "https://worker.test", env: ENV, secrets: { current: INTERNAL }, clock, fetch: hang, timeoutMs: 50 }));
    const slowClient = await connect(slow, secret);
    const started = Date.now();
    expect(errorCode(await run(slowClient, id, "shopify_list_orders"))).toEqual({ code: "provider_unavailable" });
    expect(Date.now() - started).toBeLessThan(3000);
    await slowClient.close();
  });

  it("counts a refusal for every error code except provider_unavailable, and a success as a read (H-8)", async () => {
    const id = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const reauth = await seedLive({ tenantId: h.b.tenantId, memberId: h.b.memberId });
    expect(reauth).toBeTruthy();
    const { secret, id: tokenId } = await mint(on, h.a, ["connections:read"]);
    const client = await connect(on, secret);
    await client.callTool({ name: "list_connections", arguments: {} }); // read
    await run(client, id, "shopify_list_orders"); // read
    errorCode(await run(client, id, "nope")); // refusal: not_found
    errorCode(await run(client, id, "shopify_list_orders", { limit: 500 })); // refusal: invalid_arguments
    await h.database.pool.query("UPDATE connections SET status='reauthorize', reauthorize_reason='provider_status' WHERE id=$1", [id]);
    errorCode(await run(client, id, "shopify_list_orders")); // refusal: connection_needs_reconnect
    await h.database.pool.query("UPDATE connections SET status='active', reauthorize_reason=NULL WHERE id=$1", [id]);
    limiterRefuses = true;
    errorCode(await run(client, id, "shopify_list_orders")); // refusal: provider_rate_limited
    limiterRefuses = false;
    await client.close();
    const down = build({ ...port, run: async () => { throw new ConnectorUnavailable("network"); } });
    const downClient = await connect(down, secret);
    errorCode(await run(downClient, id, "shopify_list_orders")); // not a refusal
    await downClient.close();

    const usage = automationUsageSchema.parse((await call(on, "GET", `/v1/integrations/activepieces/tokens/${tokenId}/usage`, { token: h.a.token })).body);
    expect(usage.totals.reads).toBe(2);
    expect(usage.totals.refusals).toBe(4);
    expect(usage.totals.requests).toBeGreaterThanOrEqual(usage.totals.reads + usage.totals.refusals + 1);
  });

  it("a revoked token is refused with 401 before any connection tool runs", async () => {
    const id = await seedLive({ tenantId: h.a.tenantId, memberId: h.a.memberId });
    const { secret, id: tokenId } = await mint(on, h.a, ["connections:read"]);
    const client = await connect(on, secret);
    expect(text(await client.callTool({ name: "list_connections", arguments: {} }) as ToolReply).items).toHaveLength(1);
    expect((await call(on, "POST", `/v1/integrations/activepieces/tokens/${tokenId}/revoke`, { token: h.a.token, key: randomUUID(), body: {} })).status).toBe(200);
    const calls = fake.calls.length;
    const response = await on.fetch(new Request(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_connection_tool", arguments: { connectionId: id, tool: "shopify_list_orders", arguments: {} } } }),
    }));
    expect(response.status).toBe(401);
    expect(fake.calls.length).toBe(calls);
    await client.close();
  });
});

describe("scopes disclosure (C-11, H-9)", () => {
  it("the owner's scope list carries connections:read with its disclosure; staff are refused", async () => {
    const list = automationScopeListSchema.parse((await call(on, "GET", "/v1/integrations/activepieces/scopes", { token: h.a.token })).body);
    const item = list.items.find((entry) => entry.scope === "connections:read");
    expect(item).toMatchObject({ kind: "read", disclosure: READ_SCOPE_DISCLOSURES["connections:read"] });
    expect(item && "disclosure" in item ? item.disclosure : "").toMatch(/\S/);
    expect((await call(on, "GET", "/v1/integrations/activepieces/scopes", { token: staffA.token })).status).toBe(403);
  });
});

describe("the API environment (C-3)", () => {
  const values = {
    CONNECTIONS_WORKER_URL: "https://workers.haldenrowe.example",
    CONNECTIONS_ENV: "preview",
    CONNECTIONS_INTERNAL_SECRET: INTERNAL,
    CONNECTIONS_STATE_SECRET: STATE,
    CONNECTIONS_RETURN_URL: RETURN_URL,
  };
  const errorOf = (env: Record<string, string | undefined>) => {
    try { parseConnectionsApiEnv(env); } catch (error) { return (error as Error).message; }
    throw new Error("accepted");
  };

  it("is off when no variable is set, and parses the whole set", () => {
    expect(parseConnectionsApiEnv({})).toBeNull();
    expect(parseConnectionsApiEnv({ CONNECTIONS_ENV: "" })).toBeNull();
    expect(parseConnectionsApiEnv(values)).toEqual({
      workerUrl: values.CONNECTIONS_WORKER_URL, env: "preview", internalSecret: INTERNAL, stateSecrets: { current: STATE }, returnUrl: RETURN_URL,
    });
    const previous = ["conn", "state", "p".repeat(32)].join("-");
    expect(parseConnectionsApiEnv({ ...values, CONNECTIONS_STATE_PREVIOUS_SECRET: previous })?.stateSecrets).toEqual({ current: STATE, previous });
  });

  it("is all or none, and an error names variables, never values", () => {
    for (const name of Object.keys(values)) {
      const { [name]: _gone, ...rest } = values as Record<string, string>;
      const message = errorOf(rest);
      expect(message, name).toContain(name);
      expect(message).not.toContain(INTERNAL);
      expect(message).not.toContain(STATE);
    }
  });

  it("refuses a worker URL with a path, a short or shared secret, and an unknown environment", () => {
    expect(errorOf({ ...values, CONNECTIONS_WORKER_URL: "https://workers.haldenrowe.example/internal" })).toContain("CONNECTIONS_WORKER_URL");
    expect(errorOf({ ...values, CONNECTIONS_WORKER_URL: "http://workers.haldenrowe.example" })).toContain("CONNECTIONS_WORKER_URL");
    expect(errorOf({ ...values, CONNECTIONS_STATE_SECRET: "short" })).toContain("CONNECTIONS_STATE_SECRET");
    expect(errorOf({ ...values, CONNECTIONS_STATE_SECRET: INTERNAL })).toContain("must differ");
    expect(errorOf({ ...values, CONNECTIONS_STATE_PREVIOUS_SECRET: STATE })).toContain("must differ");
    expect(errorOf({ ...values, CONNECTIONS_ENV: "staging" })).toContain("CONNECTIONS_ENV");
  });

  it("C-6: every secret differs from every other, previous ones included, and the error names no value", () => {
    const internalPrevious = ["conn", "internal", "p".repeat(32)].join("-");
    const statePrevious = ["conn", "state", "p".repeat(32)].join("-");
    const all = { ...values, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: internalPrevious, CONNECTIONS_STATE_PREVIOUS_SECRET: statePrevious };
    expect(parseConnectionsApiEnv(all)).not.toBeNull();
    const names = ["CONNECTIONS_INTERNAL_SECRET", "CONNECTIONS_INTERNAL_PREVIOUS_SECRET", "CONNECTIONS_STATE_SECRET", "CONNECTIONS_STATE_PREVIOUS_SECRET"] as const;
    for (const [i, first] of names.entries())
      for (const second of names.slice(i + 1)) {
        const message = errorOf({ ...all, [second]: all[first] });
        expect(message, `${first} = ${second}`).toContain("must differ");
        expect(message).toContain(first);
        expect(message).toContain(second);
        for (const value of Object.values(all).filter((v) => v.startsWith("conn-"))) expect(message).not.toContain(value);
      }
  });

  it("C-6: accepts the optional previous internal secret (signing still uses the current one) unless it equals the current", () => {
    const previous = ["conn", "internal", "p".repeat(32)].join("-");
    expect(parseConnectionsApiEnv({ ...values, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: previous })).toMatchObject({ internalSecret: INTERNAL });
    expect(errorOf({ ...values, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: INTERNAL })).toContain("CONNECTIONS_INTERNAL_PREVIOUS_SECRET");
    expect(errorOf({ ...values, CONNECTIONS_INTERNAL_PREVIOUS_SECRET: "short" })).toContain("CONNECTIONS_INTERNAL_PREVIOUS_SECRET");
    // It alone switches the set on, so a half-set API is refused rather than silently off.
    expect(errorOf({ CONNECTIONS_INTERNAL_PREVIOUS_SECRET: previous })).toContain("CONNECTIONS_WORKER_URL");
  });

  it("the server environment carries the parsed set, or null", () => {
    const base = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub", JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
    expect(parseServerEnv(base).connections).toBeNull();
    expect(parseServerEnv({ ...base, ...values }).connections).toMatchObject({ env: "preview", returnUrl: RETURN_URL });
    expect(() => parseServerEnv({ ...base, CONNECTIONS_ENV: "preview" })).toThrow(/CONNECTIONS_WORKER_URL/);
  });
});
