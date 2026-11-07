// Connections edge (docs/requirements/connections.md C-4, C-5, C-10, C-13, C-15): the member session, the
// anonymous callback, the /mcp tools and the signed connector port, against a real local Postgres, the
// worker in process and the in-process fake Composio.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTION_CONNECT_ACTION,
  Conflict,
  NotFound,
  TenantDenied,
  ValidationFailed,
  type ActionCommand,
} from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  ConnectionsRefused,
  ConnectorUnavailable,
  browserBindingFor,
  composioUserId,
  connectIdempotencyKey,
  createConnectionsCallback,
  createConnectionsSession,
  createConnectionsTools,
  createHttpConnectorPort,
  createLocalConnectorPort,
  derivedId,
  handleConnectorOperation,
  mapError,
  memberDispatch,
  signConnectAttempt,
  signConnectGrant,
  verifyConnectAttempt,
  verifyConnectorRequest,
  type ConnectionLimiter,
  type ConnectionsCallbackOutcome,
  type ConnectionsCallbackReport,
  type ConnectorPort,
  type EdgeDependencies,
} from "../../src/index.js";
import { NEVER_APPROVED_ACTIONS } from "../../src/approvals/policy.js";
import { FakeComposio } from "./fake-composio.js";
import { addMember, ENV, makeClock, makeWorker, newTenant, seedConnection, T0, type TestClock } from "./harness.js";

const STATE = ["conn", "state", "e".repeat(32)].join("-");
const INTERNAL = ["conn", "internal", "f".repeat(32)].join("-");
const KEY = randomBytes(32).toString("base64url");
const BINDING = browserBindingFor(KEY);
const SHOP = "testshop.myshopify.com";
const DAY_MS = 86_400_000;

let database: TestDatabase;
let fixture: TwoTenantFixture;
let fake: FakeComposio;
let clock: TestClock;
let worker: ReturnType<typeof makeWorker>;
let port: ConnectorPort;
let limiterRefuses = false;
let taken: string[];
let a: { tenantId: string; owner: { userId: string; memberId: string }; staff: { userId: string; memberId: string } };
let b: { tenantId: string; owner: { userId: string; memberId: string } };

const limiter: ConnectionLimiter = {
  async take(charges) {
    taken.push(...charges.map((c) => c.key.split(":")[0]!));
    return limiterRefuses ? { ok: false, retryAfterSeconds: 42 } : { ok: true };
  },
};
const deps = (connections = true): EdgeDependencies => ({
  db: database.db, clock, generateId: randomUUID,
  ...(connections ? { connections: { connector: port, stateSecrets: { current: STATE }, limiter } } : {}),
});
const session = (tenantId: string, actorId: string, withConnections = true) => createConnectionsSession(deps(withConnections), { tenantId, actorId });
/**
 * The callback as the routes see it, minus the log tags (C-14): every answer to a verified attempt names that
 * attempt's tenant and connection, and only those; an invalid one names nothing.
 */
const untag = (outcome: ConnectionsCallbackReport): ConnectionsCallbackOutcome => {
  const { tenantId, connectionId, ...rest } = outcome;
  if (outcome.kind === "invalid") expect({ tenantId, connectionId }).toEqual({ tenantId: undefined, connectionId: undefined });
  else expect([typeof tenantId, typeof connectionId]).toEqual(["string", "string"]);
  return rest as ConnectionsCallbackOutcome;
};
const callback = () => {
  const real = createConnectionsCallback(deps());
  return {
    callback: async (...args: Parameters<typeof real.callback>) => untag(await real.callback(...args)),
    status: async (...args: Parameters<typeof real.status>) => untag(await real.status(...args)),
  };
};

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  a = {
    tenantId: fixture.a.tenantId,
    owner: await addMember(fixture, fixture.a.tenantId, "owner"),
    staff: await addMember(fixture, fixture.a.tenantId, "staff"),
  };
  b = { tenantId: fixture.b.tenantId, owner: await addMember(fixture, fixture.b.tenantId, "owner") };
}, 120_000);
afterAll(async () => { await database?.close(); });

beforeEach(async () => {
  for (const table of ["connections", "connection_attempts", "connector_request_nonces", "rate_limit_buckets"]) await database.pool.query(`DELETE FROM ${table}`);
  await database.pool.query("DELETE FROM automation_tokens");
  fake = new FakeComposio();
  clock = makeClock();
  worker = makeWorker(database, fake, clock);
  port = createLocalConnectorPort(worker);
  limiterRefuses = false;
  taken = [];
});

const attemptStatus = async (attemptId: string) =>
  (await database.pool.query<{ status: string }>("SELECT status FROM connection_attempts WHERE id=$1", [attemptId])).rows[0]?.status;

/** Start → consent → callback: returns what the dashboard holds just before the confirm screen. */
async function reachConfirm(tenant = a.tenantId, actor = a.owner.userId) {
  const started = await session(tenant, actor).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
  const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
  const sessionUri = fake.consent(claims.composioAccountId);
  // C-5: the real redirect carries `session_uri` only.
  const outcome = await callback().callback({ attempt: started.attempt, browserKey: KEY, sessionUri });
  if (outcome.kind !== "confirm") throw new Error(`expected confirm, got ${JSON.stringify(outcome)}`);
  return { started, claims, sessionUri, grant: outcome.grant };
}

describe("start (C-4)", () => {
  it("returns Composio's consent URL and a signed attempt bound to the tenant, member, account and browser", async () => {
    const { started, claims } = await reachConfirm();
    expect(started.authorizeUrl).toMatch(/^https:\/\/connect\.composio\.test\//);
    expect(claims).toMatchObject({ tenantId: a.tenantId, actorId: a.owner.userId, toolkit: "shopify", browserHash: BINDING });
    expect(claims.expiresAt).toBe(T0 + 10 * 60_000);
    expect(taken).toContain("conn-connect");
  });

  it("records the member row, not the user, as the attempt's creator (C-7)", async () => {
    const { claims } = await reachConfirm();
    expect((await database.pool.query("SELECT created_by FROM connection_attempts WHERE id=$1", [claims.attemptId])).rows[0]).toEqual({ created_by: a.owner.memberId });
  });

  it("C-2: the permission answers before the toolkit, the body or the key is looked at", async () => {
    const staff = session(a.tenantId, a.staff.userId);
    await expect(staff.start("not a slug!", { nonsense: true })).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.start("gmail", {})).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.disconnect("not-a-uuid", undefined)).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.pending("zcg1.nope")).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.confirm("zcg1.nope", { nonsense: true })).rejects.toBeInstanceOf(TenantDenied);
    await expect(staff.cancel({ attempt: "zca1.nope" })).rejects.toBeInstanceOf(TenantDenied);
  });

  it("needs the integrations permission, a catalog toolkit and a configured server", async () => {
    await expect(session(a.tenantId, a.staff.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING })).rejects.toBeInstanceOf(TenantDenied);
    await expect(session(a.tenantId, a.owner.userId).start("gmail", { shopDomain: SHOP, browserBinding: BINDING })).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.owner.userId).start("not a slug!", { shopDomain: SHOP, browserBinding: BINDING })).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.owner.userId, false).start("shopify", { shopDomain: SHOP, browserBinding: BINDING })).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.owner.userId, false).list()).rejects.toBeInstanceOf(NotFound);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a shop domain that is not a myshopify host, and a missing browser binding", async () => {
    for (const body of [{ shopDomain: "evil.example.com", browserBinding: BINDING }, { shopDomain: "a.myshopify.com.evil.com", browserBinding: BINDING }, { shopDomain: SHOP }, { shopDomain: SHOP, browserBinding: "short" }])
      await expect(session(a.tenantId, a.owner.userId).start("shopify", body)).rejects.toMatchObject({ name: "ValidationFailed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses when the tenant already has a live connection of the toolkit, before any worker call", async () => {
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.owner.memberId, accountId: "ca_existing" });
    await expect(session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING })).rejects.toBeInstanceOf(Conflict);
    expect(fake.calls).toHaveLength(0);
  });

  it("the per-tenant limit refuses before the connector is called (429 with Retry-After)", async () => {
    limiterRefuses = true;
    const error = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionsRefused);
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 42 });
    expect(fake.calls).toHaveLength(0);
  });

  it("a worker that cannot be reached is a 503, a Composio 429 is a 429", async () => {
    const down: ConnectorPort = { ...port, link: async () => { throw new ConnectorUnavailable("network"); } };
    const error = await createConnectionsSession({ ...deps(), connections: { connector: down, stateSecrets: { current: STATE }, limiter } }, { tenantId: a.tenantId, actorId: a.owner.userId })
      .start("shopify", { shopDomain: SHOP, browserBinding: BINDING }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unavailable" });
    fake.override(/POST \/connected_accounts\/link/, { status: 429, json: {}, times: 1 });
    const limited = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING }).catch((e: unknown) => e);
    expect(limited).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
  });
});

describe("callback (C-5)", () => {
  it("a good callback stages a grant and connects nothing", async () => {
    const { grant } = await reachConfirm();
    expect(grant.length).toBeLessThanOrEqual(3500);
    expect((await database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("checks in order: invalid token, browser, account, membership, limit", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const sessionUri = fake.consent(claims.composioAccountId);
    const input = { attempt: started.attempt, browserKey: KEY, sessionUri };
    expect(await callback().callback({ ...input, attempt: "zca1.garbage" })).toEqual({ kind: "invalid" });
    expect(await callback().callback({ ...input, attempt: undefined })).toEqual({ kind: "invalid" });
    expect(await callback().callback({ ...input, browserKey: randomBytes(32).toString("base64url") })).toEqual({ kind: "error", reason: "browser_mismatch" });
    expect(await callback().callback({ ...input, browserKey: undefined })).toEqual({ kind: "error", reason: "browser_mismatch" });
    expect(await callback().callback({ ...input, accountId: "ca_other" })).toEqual({ kind: "error", reason: "attempt_changed" });
    expect(await callback().callback({ ...input, accountId: "" })).toEqual({ kind: "error", reason: "attempt_changed" });
    expect(await callback().callback({ ...input, sessionUri: undefined })).toEqual({ kind: "error", reason: "not_connected" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
    limiterRefuses = true;
    expect(await callback().callback(input)).toEqual({ kind: "error", reason: "rate_limited" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
  });

  it("C-5: a callback with session_uri and no account ID finishes: the account comes from complete_auth and is the attempt's", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const sessionUri = fake.consent(claims.composioAccountId);
    const outcome = await callback().callback({ attempt: started.attempt, browserKey: KEY, sessionUri });
    expect(outcome).toMatchObject({ kind: "confirm" });
    expect(fake.callsTo(/complete_auth/)[0]!.body).toEqual({ session_uri: sessionUri, user_id: composioUserId(ENV, a.tenantId) });
    expect(fake.accounts.get(claims.composioAccountId)!.status).toBe("ACTIVE");
    // A reload with the same session and no account ID is still safe; an account ID that matches is accepted too.
    expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri })).toMatchObject({ kind: "confirm" });
  });

  it("C-5: an account ID that complete_auth names, other than the attempt's, never connects", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const sessionUri = fake.consent(claims.composioAccountId);
    fake.override(/POST \/connected_accounts\/complete_auth/, { json: { connected_account_id: "ca_another", toolkit_slug: "shopify" }, times: 1 });
    expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, sessionUri })).toEqual({ kind: "error", reason: "not_connected" });
    expect((await database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
    expect(await attemptStatus(claims.attemptId)).toBe("started");
  });

  it("C-5: a user or toolkit that differs from the attempt's is refused when the callback carries no account ID", async () => {
    for (const change of [{ userId: composioUserId(ENV, b.tenantId) }, { toolkit: "gmail" }, { authConfigId: "ac_other" }]) {
      const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
      const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
      const sessionUri = fake.consent(claims.composioAccountId);
      Object.assign(fake.accounts.get(claims.composioAccountId)!, change);
      expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, sessionUri })).toEqual({ kind: "error", reason: "not_connected" });
      expect(await attemptStatus(claims.attemptId)).toBe("started");
    }
  });

  it("C-5: a lost complete_auth answer recovers on the retry of the same session_uri-only callback", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const sessionUri = fake.consent(claims.composioAccountId);
    fake.loseNextCompleteAuth = true;
    const input = { attempt: started.attempt, browserKey: KEY, sessionUri };
    expect(await callback().callback(input)).toEqual({ kind: "error", reason: "provider_unavailable" });
    // The session is now used (404); the attempt's own stored account is read instead.
    expect(await callback().callback(input)).toMatchObject({ kind: "confirm" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(2);
  });

  it("C-15: a session_uri replayed from another tenant, with no account ID, never connects either side", async () => {
    const mine = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const myClaims = verifyConnectAttempt({ current: STATE }, mine.attempt, clock.now())!;
    const other = await session(b.tenantId, b.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const otherClaims = verifyConnectAttempt({ current: STATE }, other.attempt, clock.now())!;
    const foreign = fake.consent(otherClaims.composioAccountId);
    expect(await callback().callback({ attempt: mine.attempt, browserKey: KEY, sessionUri: foreign })).toEqual({ kind: "error", reason: "not_connected" });
    expect(fake.accounts.get(otherClaims.composioAccountId)!.status).toBe("INITIATED");
    expect(fake.accounts.get(myClaims.composioAccountId)!.status).toBe("INITIATED");
    // The other tenant's own callback still works afterwards.
    expect(await callback().callback({ attempt: other.attempt, browserKey: KEY, sessionUri: foreign })).toMatchObject({ kind: "confirm" });
  });

  it("C-4: with two starts, the older link's callback ends as attempt_changed and the newest attempt still finishes", async () => {
    const older = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const newer = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const olderClaims = verifyConnectAttempt({ current: STATE }, older.attempt, clock.now())!;
    const newerClaims = verifyConnectAttempt({ current: STATE }, newer.attempt, clock.now())!;
    // The browser's cookie holds the newest attempt; the older link brings its own session_uri.
    const olderSession = fake.consent(olderClaims.composioAccountId);
    expect(await callback().callback({ attempt: newer.attempt, browserKey: KEY, sessionUri: olderSession })).toEqual({ kind: "error", reason: "attempt_changed" });
    expect(await attemptStatus(newerClaims.attemptId)).toBe("started");
    expect(await callback().callback({ attempt: newer.attempt, browserKey: KEY, sessionUri: fake.consent(newerClaims.composioAccountId) })).toMatchObject({ kind: "confirm" });
  });

  it("a member demoted since the start is forbidden", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    await database.pool.query("UPDATE tenant_members SET role='staff' WHERE user_id=$1", [a.owner.userId]);
    try {
      expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri: "s" })).toEqual({ kind: "error", reason: "forbidden" });
    } finally {
      await database.pool.query("UPDATE tenant_members SET role='owner' WHERE user_id=$1", [a.owner.userId]);
    }
  });

  it("an expired attempt is invalid", async () => {
    const { started } = await reachConfirm();
    clock.ms = T0 + 10 * 60_000 + 1;
    expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, accountId: "x", sessionUri: "s" })).toEqual({ kind: "invalid" });
  });

  it("A-4: the status call never redeems a session and connects nothing a callback did not reach", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    fake.consent(claims.composioAccountId);
    fake.accounts.get(claims.composioAccountId)!.status = "ACTIVE";
    expect(await callback().status({ attempt: started.attempt, browserKey: KEY })).toEqual({ kind: "error", reason: "not_connected" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
    // C-5: it is charged per attempt and on the tenant's run buckets as well as its own.
    expect(taken).toEqual(["conn-connect", "conn-status", "conn-status-attempt", "conn-minute", "conn-day"]);
  });

  it("A-4: after a callback whose redemption answer was lost, the status call picks the account up", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const sessionUri = fake.consent(claims.composioAccountId);
    fake.loseNextCompleteAuth = true;
    expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri }))
      .toEqual({ kind: "error", reason: "provider_unavailable" });
    expect(await callback().status({ attempt: started.attempt, browserKey: KEY })).toMatchObject({ kind: "confirm" });
  });

  it("a reload after the confirm answers connected only for the same toolkit and account; anything else is a conflict", async () => {
    const { started, claims, sessionUri } = await reachConfirm();
    const input = { attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri };
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.owner.memberId, id: claims.connectionId, accountId: claims.composioAccountId });
    expect(await callback().callback(input)).toEqual({ kind: "connected" });
    await database.pool.query("UPDATE connections SET composio_account_id='ca_someone_else' WHERE id=$1", [claims.connectionId]);
    expect(await callback().callback(input)).toEqual({ kind: "error", reason: "conflict" });
    await database.pool.query("UPDATE connections SET composio_account_id=$2, status='disconnecting' WHERE id=$1", [claims.connectionId, claims.composioAccountId]);
    expect(await callback().callback(input)).toEqual({ kind: "error", reason: "conflict" });
  });

  it("a worker that cannot be reached is provider_unavailable; a session of another tenant is not_connected", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    const down: ConnectorPort = { ...port, complete: async () => { throw new ConnectorUnavailable("timeout"); } };
    const outcome = await createConnectionsCallback({ ...deps(), connections: { connector: down, stateSecrets: { current: STATE }, limiter } })
      .callback({ attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri: "s" });
    // C-14: the log names the attempt's tenant and connection.
    expect(outcome).toEqual({ kind: "error", reason: "provider_unavailable", tenantId: claims.tenantId, connectionId: claims.connectionId });
    const other = await session(b.tenantId, b.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const otherClaims = verifyConnectAttempt({ current: STATE }, other.attempt, clock.now())!;
    const foreignSession = fake.consent(otherClaims.composioAccountId);
    expect(await callback().callback({ attempt: started.attempt, browserKey: KEY, accountId: claims.composioAccountId, sessionUri: foreignSession }))
      .toEqual({ kind: "error", reason: "not_connected" });
    expect(fake.accounts.get(claims.composioAccountId)!.status).toBe("INITIATED");
  });
});

describe("pending and confirm (C-5)", () => {
  it("shows the label, shop, scopes-holding token count and expiry from the signed grant", async () => {
    await database.pool.query(
      "INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at) VALUES ($1,$2,'t1','{connections:read}',$3,$4,$6),($1,$5,'t2','{inbox:read}',$3,$4,$6)",
      [a.tenantId, randomUUID(), a.owner.userId, new Date(T0 - 1000), randomUUID(), new Date(T0 + 30 * DAY_MS)]);
    const { grant } = await reachConfirm();
    const pending = await session(a.tenantId, a.owner.userId).pending(grant);
    expect(pending).toMatchObject({ toolkit: "shopify", shopDomain: SHOP, accountLabel: "Test Shop", tokensWithAccess: 1, expiresAt: new Date(T0 + 10 * 60_000).toISOString() });
    expect(JSON.stringify(pending)).not.toMatch(/ca_\d|8812345/);
  });

  it("only the member who started can read or confirm the grant; garbage, another tenant and an expired grant are not found", async () => {
    const { grant } = await reachConfirm();
    await expect(session(a.tenantId, a.staff.userId).pending(grant)).rejects.toBeInstanceOf(TenantDenied);
    await expect(session(b.tenantId, b.owner.userId).pending(grant)).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.owner.userId).pending("zcg1.nope")).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.owner.userId).pending(undefined)).rejects.toBeInstanceOf(NotFound);
    clock.ms = T0 + 10 * 60_000 + 1;
    await expect(session(a.tenantId, a.owner.userId).pending(grant)).rejects.toBeInstanceOf(NotFound);
  });

  it("A-6: a repeat after the row moved replays the stored result through the dispatcher", async () => {
    const { grant, claims } = await reachConfirm();
    const s = session(a.tenantId, a.owner.userId);
    const shown = await s.pending(grant);
    const first = await s.confirm(grant, { grantId: shown.grantId });
    await database.pool.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [claims.connectionId]);
    expect(await s.confirm(grant, { grantId: shown.grantId })).toEqual(first);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM actions WHERE tenant_id=$1 AND action_type='connection.connect' AND target->>'id'=$2", [a.tenantId, claims.connectionId])).rows[0].n).toBe(1);
  });

  it("A-3: a grant whose attempt was cancelled meanwhile never connects (409 attempt_changed)", async () => {
    const { grant } = await reachConfirm();
    const s = session(a.tenantId, a.owner.userId);
    const shown = await s.pending(grant);
    expect(await s.cancel({ grant })).toEqual({ cancelled: true, revokeFailed: false });
    const error = await s.confirm(grant, { grantId: shown.grantId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toMatchObject({ details: { reason: "attempt_changed" } });
    expect((await database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("confirm connects under connect:<id>, records the member, and a repeat replays the same row", async () => {
    const { grant, claims } = await reachConfirm();
    const s = session(a.tenantId, a.owner.userId);
    const shown = await s.pending(grant);
    const first = await s.confirm(grant, { grantId: shown.grantId });
    expect(first).toMatchObject({ id: claims.connectionId, toolkit: "shopify", status: "active", accountLabel: "Test Shop", accountDomain: SHOP, revokeFailed: false });
    expect(JSON.stringify(first)).not.toContain(claims.composioAccountId);
    expect(await s.confirm(grant, { grantId: shown.grantId })).toEqual(first);
    const row = (await database.pool.query("SELECT connected_by, composio_account_id, external_account_id FROM connections WHERE id=$1", [claims.connectionId])).rows[0];
    expect(row).toEqual({ connected_by: a.owner.memberId, composio_account_id: claims.composioAccountId, external_account_id: "8812345" });
    const events = await database.pool.query("SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='connection.connected' AND payload->>'connectionId'=$2", [a.tenantId, claims.connectionId]);
    expect(events.rows).toHaveLength(1);
    expect(JSON.stringify(events.rows[0].payload)).not.toContain(claims.composioAccountId);
    expect((await s.list()).items.map((i) => i.id)).toEqual([claims.connectionId]);
  });

  it("a grant different from the one shown is 409 grant_changed and connects nothing", async () => {
    const { grant } = await reachConfirm();
    const s = session(a.tenantId, a.owner.userId);
    const error = await s.confirm(grant, { grantId: "x".repeat(43) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toMatchObject({ details: { reason: "grant_changed" } });
    expect((await database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("a second confirm of another grant for the same toolkit is a conflict", async () => {
    const first = await reachConfirm();
    const s = session(a.tenantId, a.owner.userId);
    await s.confirm(first.grant, { grantId: (await s.pending(first.grant)).grantId });
    // The tenant now holds a live connection: a new start is refused, and so is a hand-staged second grant.
    const claims = verifyConnectAttempt({ current: STATE }, first.started.attempt, clock.now())!;
    const second = signConnectGrant(STATE, {
      tenantId: a.tenantId, actorId: a.owner.userId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), composioAccountId: "ca_other",
      authConfigId: "ac_shopify", browserHash: BINDING, accountDomain: SHOP, externalAccountId: "1", accountLabel: "Other", expiresAt: T0 + 60_000,
    })!;
    const error = await s.confirm(second, { grantId: (await s.pending(second)).grantId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Conflict);
    expect(claims.connectionId).toBeTruthy();
  });
});

describe("the connect action (C-5)", () => {
  const command = (key: string, connectionId = randomUUID()): ActionCommand => ({
    actionType: CONNECTION_CONNECT_ACTION,
    target: { tenantId: a.tenantId, type: "connection", id: connectionId },
    approvalReference: { tenantId: a.tenantId, id: derivedId(a.tenantId, key, "approval") },
    idempotencyKey: key,
    payload: { connectionId, toolkit: "shopify", externalAccountId: "1", accountDomain: SHOP, accountLabel: "Shop" },
  });
  /** The verified attempt the worker would have left for this connection ID. */
  const verifiedAttempt = (connectionId: string, accountId = `ca_${randomUUID().slice(0, 8)}`) => fixture.service((tx) => tx.query(
    `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,created_by,browser_hash,status,external_account_id,expires_at,created_at,updated_at)
     VALUES ($1,$2,$3,'shopify',$4,'ac_shopify',$5,$6,$7,'verified','1',$8,$9,$9)`,
    [a.tenantId, randomUUID(), connectionId, accountId, SHOP, a.owner.memberId, BINDING, new Date(T0 + 600_000), new Date(T0)]));

  it("B-12: a connect that loses the race for the toolkit's live slot is 409 already_connected", async () => {
    const run = memberDispatch(deps(), { tenantId: a.tenantId, actorId: a.owner.userId });
    const id = randomUUID();
    await verifiedAttempt(id);
    // Another confirm's insert is in flight: its row is not visible yet, so the handler's check passes and the
    // insert waits on the live-per-toolkit index until the other transaction commits.
    const other = await database.pool.connect();
    try {
      await other.query("BEGIN");
      const holder = (await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await other.query(
        `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
         VALUES ($1,$2,'composio','shopify',$3,'2',$4,'Other','active',$5,$6,$6,$6)`,
        [a.tenantId, randomUUID(), `ca_${randomUUID().slice(0, 8)}`, SHOP, a.owner.memberId, new Date(T0)]);
      const losing = run(command(connectIdempotencyKey(id), id)).catch((e: unknown) => e);
      for (let tries = 0; ; tries += 1) {
        const blocked = await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [holder]);
        if (blocked.rowCount) break;
        if (tries > 200) throw new Error("the second insert never waited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await other.query("COMMIT");
      const error = await losing;
      expect(error).toBeInstanceOf(Conflict);
      expect(error).toMatchObject({ details: { reason: "already_connected" } });
    } finally {
      await other.query("ROLLBACK").catch(() => undefined);
      other.release();
    }
  });

  it("is refused under any key other than connect:<id>", async () => {
    const run = memberDispatch(deps(), { tenantId: a.tenantId, actorId: a.owner.userId });
    await expect(run(command("some-other-key"))).rejects.toBeInstanceOf(ValidationFailed);
    const id = randomUUID();
    await verifiedAttempt(id);
    const ok = await run(command(connectIdempotencyKey(id), id));
    expect(ok.result).toMatchObject({ id, status: "active" });
  });

  it("C-1: names no Composio account; without the worker's verified attempt the insert is refused", async () => {
    const run = memberDispatch(deps(), { tenantId: a.tenantId, actorId: a.owner.userId });
    const id = randomUUID();
    await expect(run({ ...command(connectIdempotencyKey(id), id), payload: { ...(command("k", id).payload as Record<string, unknown>), composioAccountId: "ca_x" } } as ActionCommand)).rejects.toBeInstanceOf(ValidationFailed);
    const error = await run(command(connectIdempotencyKey(id), id)).catch((e: unknown) => e);
    expect(error).toMatchObject({ details: { reason: "attempt_changed" } });
    await verifiedAttempt(id, "ca_named");
    await run(command(connectIdempotencyKey(id), id));
    const logged = await database.pool.query("SELECT a.payload, a.result, o.payload AS event FROM actions a LEFT JOIN outbox o ON o.tenant_id=a.tenant_id AND o.action_id=a.id WHERE a.tenant_id=$1 AND a.action_type=$2 AND a.target->>'id'=$3", [a.tenantId, CONNECTION_CONNECT_ACTION, id]);
    expect(logged.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged.rows)).not.toContain("ca_named");
    expect((await database.pool.query("SELECT composio_account_id FROM connections WHERE id=$1", [id])).rows[0]).toEqual({ composio_account_id: "ca_named" });
  });

  it("is refused for a member without integrations and is never an approval action", async () => {
    const id = randomUUID();
    await expect(memberDispatch(deps(), { tenantId: a.tenantId, actorId: a.staff.userId })(command(connectIdempotencyKey(id), id))).rejects.toBeInstanceOf(TenantDenied);
    expect(NEVER_APPROVED_ACTIONS.has("connection.connect")).toBe(true);
    expect(NEVER_APPROVED_ACTIONS.has("connection.disconnect")).toBe(true);
  });
});

describe("cancel and disconnect (C-5, C-13)", () => {
  it("cancel deletes the attempt's account at once; it ignores another member's attempt", async () => {
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    await expect(session(a.tenantId, a.owner.userId).cancel({ attempt: "zca1.bad" })).rejects.toBeInstanceOf(NotFound);
    await expect(session(b.tenantId, b.owner.userId).cancel({ attempt: started.attempt })).rejects.toBeInstanceOf(NotFound);
    expect(await session(a.tenantId, a.owner.userId).cancel({ attempt: started.attempt })).toEqual({ cancelled: true, revokeFailed: false });
    expect(fake.accounts.get(claims.composioAccountId)).toMatchObject({ revoked: true, deleted: true });
  });

  it("D-2: the staged grant names the attempt to cancel, over the attempt cookie", async () => {
    const first = await reachConfirm();
    const newer = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const newerClaims = verifyConnectAttempt({ current: STATE }, newer.attempt, clock.now())!;
    expect(await session(a.tenantId, a.owner.userId).cancel({ grant: first.grant, attempt: newer.attempt })).toEqual({ cancelled: true, revokeFailed: false });
    expect(fake.accounts.get(first.claims.composioAccountId)!.deleted).toBe(true);
    expect(fake.accounts.get(newerClaims.composioAccountId)!.deleted).toBe(false);
  });

  it("B-10: cancel shows a failed revoke, refuses a foreign account with 409 and a spent budget with 429", async () => {
    const s = session(a.tenantId, a.owner.userId);
    const one = await s.start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500, times: 1 });
    expect(await s.cancel({ attempt: one.attempt })).toEqual({ cancelled: true, revokeFailed: true });
    const two = await s.start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    fake.accounts.get(verifyConnectAttempt({ current: STATE }, two.attempt, clock.now())!.composioAccountId)!.userId = composioUserId(ENV, b.tenantId);
    expect(await s.cancel({ attempt: two.attempt }).catch((e: unknown) => e)).toMatchObject({ details: { reason: "account_mismatch" } });
    const three = await s.start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    fake.override(/GET \/connected_accounts\//, { status: 429, json: {}, times: 1 });
    expect(await s.cancel({ attempt: three.attempt }).catch((e: unknown) => e)).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
  });

  it("B-10: a cancel that overlaps another's removal is 409 cancel_in_progress, never a cancelled answer before the outcome is known", async () => {
    const s = session(a.tenantId, a.owner.userId);
    const started = await s.start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500, times: 1 });
    let overlapping: unknown;
    fake.gate = async (call) => {
      if (call.path.endsWith("/tools/execute/proxy") && overlapping === undefined) {
        overlapping = null;
        overlapping = await s.cancel({ attempt: started.attempt }).catch((e: unknown) => e);
      }
    };
    try {
      expect(await s.cancel({ attempt: started.attempt })).toEqual({ cancelled: true, revokeFailed: true });
    } finally {
      fake.gate = null;
    }
    expect(overlapping).toBeInstanceOf(Conflict);
    expect(overlapping).toMatchObject({ details: { reason: "cancel_in_progress" } });
    expect(mapError(overlapping).status).toBe(409);
    expect(await s.cancel({ attempt: started.attempt })).toEqual({ cancelled: true, revokeFailed: true });
  });

  it("disconnect runs the action, finishes at once and replays under the same key", async () => {
    const accountId = "ca_live";
    fake.seed({ id: accountId, userId: composioUserId(ENV, a.tenantId), authConfigId: "ac_shopify" });
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.owner.memberId, accountId });
    const s = session(a.tenantId, a.owner.userId);
    const key = `disconnect-${randomUUID()}`;
    const first = await s.disconnect(id, key);
    expect(first.result).toMatchObject({ id, status: "disconnected", accountLabel: null, revokeFailed: false });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect((await s.disconnect(id, key)).actionId).toBe(first.actionId);
    expect((await s.list()).items[0]).toMatchObject({ id, status: "disconnected" });
  });

  it("a worker that is down leaves it disconnecting for the pass; a revoke failure is shown", async () => {
    const accountId = "ca_live2";
    fake.seed({ id: accountId, userId: composioUserId(ENV, a.tenantId), authConfigId: "ac_shopify" });
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.owner.memberId, accountId });
    const down: ConnectorPort = { ...port, disconnect: async () => { throw new ConnectorUnavailable("network"); } };
    const s = createConnectionsSession({ ...deps(), connections: { connector: down, stateSecrets: { current: STATE }, limiter } }, { tenantId: a.tenantId, actorId: a.owner.userId });
    expect((await s.disconnect(id, `k-${randomUUID()}`)).result.status).toBe("disconnecting");
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500 });
    expect((await worker.pass()).disconnected).toBe(1);
    expect((await session(a.tenantId, a.owner.userId).list()).items[0]).toMatchObject({ status: "disconnected", revokeFailed: true });
  });

  it("tenant B cannot disconnect tenant A's connection, and staff cannot disconnect", async () => {
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.owner.memberId, accountId: "ca_a" });
    await expect(session(b.tenantId, b.owner.userId).disconnect(id, `k-${randomUUID()}`)).rejects.toBeInstanceOf(NotFound);
    await expect(session(a.tenantId, a.staff.userId).disconnect(id, `k-${randomUUID()}`)).rejects.toBeInstanceOf(TenantDenied);
    expect((await database.pool.query("SELECT status FROM connections WHERE id=$1", [id])).rows[0].status).toBe("active");
  });
});

describe("tools (C-10)", () => {
  async function seeded(tenant: { tenantId: string; memberId: string }) {
    const accountId = `ca_${randomUUID().slice(0, 8)}`;
    fake.seed({ id: accountId, userId: composioUserId(ENV, tenant.tenantId), authConfigId: "ac_shopify" });
    return seedConnection(fixture, { tenantId: tenant.tenantId, memberId: tenant.memberId, accountId });
  }
  const tools = (tenantId: string, withConnections = true) => createConnectionsTools(deps(withConnections), tenantId);

  it("lists only the caller's tenant, its catalog, and runs a tool", async () => {
    const idA = await seeded({ tenantId: a.tenantId, memberId: a.owner.memberId });
    const idB = await seeded({ tenantId: b.tenantId, memberId: b.owner.memberId });
    expect((await tools(a.tenantId).list()).map((c) => c.id)).toEqual([idA]);
    expect((await tools(b.tenantId).list()).map((c) => c.id)).toEqual([idB]);
    const listed = (await tools(a.tenantId).tools(idA))!;
    expect(listed.map((t) => t.name)).toEqual(["shopify_list_orders", "shopify_get_order"]);
    // A-7: plain JSON Schema an MCP client can read, not a zod object.
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed);
    expect(listed[1]!.inputSchema).toMatchObject({ type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] });
    expect(listed[0]!.inputSchema).toMatchObject({ type: "object", properties: { limit: { type: "integer" } } });
    expect(await tools(a.tenantId).tools(idB)).toBeNull();
    const out = await tools(a.tenantId).run({ connectionId: idA, tool: "shopify_list_orders", arguments: { limit: 1 } });
    expect(out).toMatchObject({ ok: true, truncated: false });
    expect(taken).toEqual(expect.arrayContaining(["conn-minute", "conn-day"]));
  });

  it("tenant A's token cannot run tenant B's connection: not_found, no limit charge, no connector call", async () => {
    const idB = await seeded({ tenantId: b.tenantId, memberId: b.owner.memberId });
    const out = await tools(a.tenantId).run({ connectionId: idB, tool: "shopify_list_orders", arguments: {} });
    expect(out).toEqual({ ok: false, error: { code: "not_found" } });
    expect(taken).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("checks in order: connection, tool, arguments, then the limit; the limit refuses before the worker", async () => {
    const id = await seeded({ tenantId: a.tenantId, memberId: a.owner.memberId });
    expect(await tools(a.tenantId).run({ connectionId: id, tool: "nope", arguments: {} })).toEqual({ ok: false, error: { code: "not_found" } });
    expect(await tools(a.tenantId).run({ connectionId: id, tool: "shopify_list_orders", arguments: { connected_account_id: "ca_x" } })).toEqual({ ok: false, error: { code: "invalid_arguments" } });
    expect(await tools(a.tenantId).run({ connectionId: id, tool: "shopify_list_orders", arguments: { limit: 500 } })).toEqual({ ok: false, error: { code: "invalid_arguments" } });
    expect(taken).toHaveLength(0);
    limiterRefuses = true;
    expect(await tools(a.tenantId).run({ connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ ok: false, error: { code: "provider_rate_limited", retryAfterSeconds: 42 } });
    expect(fake.calls).toHaveLength(0);
  });

  it("a reauthorize connection is listed and answers connection_needs_reconnect; a disconnecting one is neither", async () => {
    const t = await newTenant(fixture);
    const re = await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: "ca_re", status: "reauthorize" });
    expect((await tools(t.tenantId).list()).map((c) => c.status)).toEqual(["reauthorize"]);
    expect(await tools(t.tenantId).run({ connectionId: re, tool: "shopify_list_orders", arguments: {} })).toEqual({ ok: false, error: { code: "connection_needs_reconnect" } });
    await database.pool.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [re]);
    expect(await tools(t.tenantId).list()).toEqual([]);
    expect(await tools(t.tenantId).tools(re)).toBeNull();
    expect(await tools(t.tenantId).run({ connectionId: re, tool: "shopify_list_orders", arguments: {} })).toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("an unconfigured server is NotFound, and a worker that is unreachable is provider_unavailable", async () => {
    await expect(tools(a.tenantId, false).list()).rejects.toBeInstanceOf(NotFound);
    const id = await seeded({ tenantId: a.tenantId, memberId: a.owner.memberId });
    const down: ConnectorPort = { ...port, run: async () => { throw new ConnectorUnavailable("timeout"); } };
    const t = createConnectionsTools({ ...deps(), connections: { connector: down, stateSecrets: { current: STATE }, limiter } }, a.tenantId);
    expect(await t.run({ connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ ok: false, error: { code: "provider_unavailable" } });
  });
});

describe("the signed connector port (C-3, C-10)", () => {
  /** A stand-in for the worker's route: verify, then run the shared handler. */
  const route = (clockNow: () => Date, secrets: { current: string; previous?: string } = { current: INTERNAL }): typeof fetch => async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    const headers = new Headers(init?.headers);
    const verified = await verifyConnectorRequest({
      secrets, env: ENV, host: url.host, method: init?.method ?? "GET", path: url.pathname, body: String(init?.body ?? ""), now: clockNow(), headers,
      takeNonce: (jti) => worker.takeNonce(jti, new Date(clockNow().getTime() + 300_000)),
    });
    if (!verified.ok) return new Response("{}", { status: 401 });
    const operation = url.pathname.split("/").pop()!;
    const out = await handleConnectorOperation(worker, operation as never, String(init?.body ?? ""), init?.signal ?? undefined);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  };
  const http = (doFetch: typeof fetch, extra: { timeoutMs?: number; secret?: string } = {}) => createHttpConnectorPort({
    workerUrl: "https://worker.example.test", env: ENV, secrets: { current: extra.secret ?? INTERNAL }, clock, fetch: doFetch, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });

  it("a signed link reaches the worker and its answer is parsed by the contract", async () => {
    const attemptId = randomUUID();
    const out = await http(route(() => clock.now())).link({ tenantId: a.tenantId, toolkit: "shopify", attemptId, connectionId: randomUUID(), shopDomain: SHOP, createdBy: a.owner.memberId, browserHash: BINDING });
    expect(out).toMatchObject({ outcome: "linked", authConfigId: "ac_shopify" });
  });

  it("the route refuses a wrong secret, a stale clock and a replayed request", async () => {
    await expect(http(route(() => clock.now()), { secret: "wrong-secret-wrong-secret-wrong-secret" }).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toBeInstanceOf(ConnectorUnavailable);
    const stale = http(route(() => new Date(clock.ms + 120_000)));
    await expect(stale.cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "status" });
    const seen: Request[] = [];
    const replaying: typeof fetch = async (input, init) => { seen.push(new Request(input as string, init)); return route(() => clock.now())(input, init); };
    await http(replaying).cancel({ tenantId: a.tenantId, attemptId: randomUUID() });
    const first = seen[0]!;
    const again = await route(() => clock.now())(first.url, { method: "POST", headers: first.headers, body: JSON.stringify({ tenantId: a.tenantId, attemptId: randomUUID() }) });
    expect(again.status).toBe(401);
  });

  it("gives up at its own timeout, on a non-200 answer, on a body that is not the contract and on an oversized body", async () => {
    const hang: typeof fetch = (_input, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(http(hang, { timeoutMs: 30 }).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "timeout" });
    await expect(http(async () => new Response("{}", { status: 500 })).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "status" });
    await expect(http(async () => new Response(JSON.stringify({ outcome: "weird" }), { status: 200 })).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "malformed" });
    await expect(http(async () => new Response("x".repeat(300 * 1024), { status: 200 })).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "too_large" });
    await expect(http(async () => { throw new TypeError("fetch failed"); }).cancel({ tenantId: a.tenantId, attemptId: randomUUID() })).rejects.toMatchObject({ detail: "network" });
  });

  it("the shared handler answers 400 for a body that is not JSON or does not fit, and 502 for a Composio failure", async () => {
    expect(await handleConnectorOperation(worker, "run", "not json")).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await handleConnectorOperation(worker, "run", JSON.stringify({ tenantId: "nope" }))).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await handleConnectorOperation(worker, "cancel", JSON.stringify({ tenantId: a.tenantId, attemptId: randomUUID(), extra: 1 }))).toEqual({ status: 400, body: { error: "invalid_body" } });
    const started = await session(a.tenantId, a.owner.userId).start("shopify", { shopDomain: SHOP, browserBinding: BINDING });
    const claims = verifyConnectAttempt({ current: STATE }, started.attempt, clock.now())!;
    fake.override(/DELETE \/connected_accounts/, { status: 500 });
    expect(await handleConnectorOperation(worker, "cancel", JSON.stringify({ tenantId: a.tenantId, attemptId: claims.attemptId }))).toEqual({ status: 502, body: { error: "provider_unavailable" } });
  });
});

describe("attempt token", () => {
  it("is signed with the current secret only and carries no Composio secret or tenant data beyond IDs", () => {
    const token = signConnectAttempt(STATE, {
      tenantId: a.tenantId, actorId: a.owner.userId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(),
      composioAccountId: "ca_1", authConfigId: "ac_shopify", browserHash: BINDING, expiresAt: T0 + 1000,
    });
    expect(verifyConnectAttempt({ current: STATE }, token, clock.now())).not.toBeNull();
    expect(verifyConnectAttempt({ current: "other-secret-other-secret-other-secret" }, token, clock.now())).toBeNull();
  });
});
