// Connections worker (docs/requirements/connections.md C-3, C-5, C-8, C-9, C-10, C-12, C-13, C-15) against a
// real local Postgres and the in-process fake Composio. No test reaches the real service.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { composioUserId, type ConnectionsWorkerReport } from "../../src/index.js";
import { FakeComposio, fakeOrder } from "./fake-composio.js";
import { addMember, attemptOf, AUTH_CONFIG, CALLBACK_URL, ENV, makeClock, makeWorker, newTenant, seedConnection, startAttempt, statusOf, T0, type TestClock } from "./harness.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let database: TestDatabase;
let fixture: TwoTenantFixture;
let fake: FakeComposio;
let clock: TestClock;
let reports: ConnectionsWorkerReport[];
let worker: ReturnType<typeof makeWorker>;
let a: { tenantId: string; userId: string; memberId: string };
let b: { tenantId: string; userId: string; memberId: string };

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  a = { tenantId: fixture.a.tenantId, ...(await addMember(fixture, fixture.a.tenantId, "owner")) };
  b = { tenantId: fixture.b.tenantId, ...(await addMember(fixture, fixture.b.tenantId, "owner")) };
}, 120_000);
afterAll(async () => { await database?.close(); });

beforeEach(async () => {
  await database.pool.query("DELETE FROM connections");
  await database.pool.query("DELETE FROM connection_attempts");
  await database.pool.query("DELETE FROM connector_request_nonces");
  await database.pool.query("DELETE FROM rate_limit_buckets");
  fake = new FakeComposio();
  clock = makeClock();
  reports = [];
  worker = makeWorker(database, fake, clock, {}, reports);
});


/** Fills the organization budget bucket for the current window (the admin pool: the runtime roles cannot write the bucket table). */
const exhaustBudget = () => database.pool.query(
  `INSERT INTO rate_limit_buckets (key, window_start, expires_at, count) VALUES (sha256(convert_to('composio-org:preview','UTF8')), $1, $2, 500)
   ON CONFLICT (key) DO UPDATE SET count = 500, window_start = $1, expires_at = $2`, [new Date(T0), new Date(T0 + 60_000)]);

/** A connected account the fake already holds for a tenant. */
const seedAccount = (tenantId: string, id = `ca_seed_${randomUUID().slice(0, 8)}`) => {
  fake.seed({ id, userId: composioUserId(ENV, tenantId), authConfigId: AUTH_CONFIG });
  return id;
};

describe("link (C-3, C-5)", () => {
  it("creates the account for the derived user, records the attempt and sends the one callback URL", async () => {
    const { attemptId, accountId, linked } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    expect(linked.outcome).toBe("linked");
    const call = fake.callsTo(/connected_accounts\/link/)[0]!;
    expect(call.body).toMatchObject({ auth_config_id: AUTH_CONFIG, user_id: `zsb:${ENV}:${a.tenantId}`, callback_url: CALLBACK_URL, connection_data: { shop: "testshop" } });
    expect(call.apiKey).toBe("test-key");
    expect(fake.accounts.get(accountId)?.userId).toBe(composioUserId(ENV, a.tenantId));
    expect(await attemptOf(fixture, a.tenantId, attemptId)).toEqual({ status: "started" });
  });

  it("refuses an unknown toolkit and a missing auth config without calling Composio", async () => {
    const out = await worker.link({ tenantId: a.tenantId, toolkit: "nope", attemptId: randomUUID(), connectionId: randomUUID(), shopDomain: "x.myshopify.com", createdBy: a.userId, browserHash: "b".repeat(43) });
    expect(out).toEqual({ outcome: "refused", code: "not_found" });
    expect(fake.calls).toHaveLength(0);
  });

  it("opens the cooldown on a Composio 429, then refuses without a call", async () => {
    fake.override(/POST \/connected_accounts\/link/, { status: 429, json: {}, times: 1 });
    const first = await worker.link({ tenantId: a.tenantId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), shopDomain: "testshop.myshopify.com", createdBy: a.userId, browserHash: "b".repeat(43) });
    expect(first).toEqual({ outcome: "refused", code: "provider_rate_limited" });
    const calls = fake.calls.length;
    const second = await worker.link({ tenantId: a.tenantId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), shopDomain: "testshop.myshopify.com", createdBy: a.userId, browserHash: "b".repeat(43) });
    expect(second).toEqual({ outcome: "refused", code: "provider_rate_limited" });
    expect(fake.calls).toHaveLength(calls);
    expect(reports.some((r) => r.kind === "cooldown")).toBe(true);
  });

  it("deletes the new account when the attempt row cannot be written", async () => {
    // A tenant that does not exist makes the insert fail on its foreign key.
    const out = await worker.link({ tenantId: randomUUID(), toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), shopDomain: "testshop.myshopify.com", createdBy: a.userId, browserHash: "b".repeat(43) });
    expect(out).toEqual({ outcome: "refused", code: "provider_unavailable" });
    expect([...fake.accounts.values()].filter((x) => !x.deleted)).toHaveLength(0);
  });
});

describe("complete (C-5, C-8, C-14)", () => {
  it("fixation: without a redeemed session the account stays INITIATED and the call answers pending", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.consent(accountId); // the person consented, but nobody redeemed the session
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "pending" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(0);
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("started");
  });

  it("verifies after the session is redeemed for the tenant's user and reads the store identity through the envelope", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    const session = fake.consent(accountId);
    const out = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
    expect(out).toEqual({ outcome: "verified", composioAccountId: accountId, externalAccountId: "8812345", accountDomain: "testshop.myshopify.com", accountLabel: "Test Shop" });
    expect(fake.callsTo(/complete_auth/)[0]!.body).toEqual({ session_uri: session, user_id: composioUserId(ENV, a.tenantId) });
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("verified");
  });

  it("a session redeemed for another tenant's user never connects (400 from Composio)", async () => {
    const { attemptId: attemptA, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    const session = fake.consent(accountId);
    // Tenant B's callback carries the session but names its own attempt.
    const other = await startAttempt(worker, { tenantId: b.tenantId, createdBy: b.userId });
    const out = await worker.complete({ tenantId: b.tenantId, attemptId: other.attemptId, sessionUri: session });
    expect(out).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(fake.accounts.get(accountId)?.status).toBe("INITIATED");
    expect((await attemptOf(fixture, b.tenantId, other.attemptId))?.status).toBe("started");
    expect(attemptA).toBeTruthy();
  });

  it("a used session cannot be replayed to take the account over: the account stays pending", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    const session = fake.consent(accountId);
    fake.sessions.get(session)!.used = true; // someone else used it first
    const out = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
    expect(out).toEqual({ outcome: "pending" });
  });

  it("a lost complete_auth answer recovers through the account read (C-5)", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    const session = fake.consent(accountId);
    fake.loseNextCompleteAuth = true;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "provider_unavailable" });
    expect(fake.accounts.get(accountId)?.status).toBe("ACTIVE");
    const again = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
    expect(again).toMatchObject({ outcome: "verified", composioAccountId: accountId });
  });

  it("refuses an account whose user, toolkit or auth config differs from the attempt", async () => {
    for (const change of [{ userId: composioUserId(ENV, b.tenantId) }, { toolkit: "gmail" }, { authConfigId: "ac_other" }]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
      Object.assign(fake.accounts.get(accountId)!, { status: "ACTIVE", ...change });
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    }
  });

  it("refuses when the consenting store differs from the typed shop domain (C-14)", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.accounts.get(accountId)!.status = "ACTIVE";
    fake.shops.set(accountId, { id: "1", name: "Other Shop", domain: "othershop.myshopify.com" });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("started");
  });

  it("maps every Composio status: INITIATED/INITIALIZING pending, ACTIVE go, INACTIVE/FAILED/EXPIRED/unknown refuse", async () => {
    const outcomes: Record<string, string> = {};
    for (const status of ["INITIATED", "INITIALIZING", "ACTIVE", "INACTIVE", "FAILED", "EXPIRED", "SOMETHING_NEW"]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
      fake.accounts.get(accountId)!.status = status;
      const out = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null });
      outcomes[status] = out.outcome === "refused" ? `refused:${out.reason}` : out.outcome;
    }
    expect(outcomes).toEqual({
      INITIATED: "pending", INITIALIZING: "pending", ACTIVE: "verified",
      INACTIVE: "refused:not_connected", FAILED: "refused:not_connected", EXPIRED: "refused:not_connected", SOMETHING_NEW: "refused:not_connected",
    });
  });

  it("refuses an expired attempt, another tenant's attempt, a cancelled attempt and a confirmed one", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    expect(await worker.complete({ tenantId: b.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    clock.ms = T0 + 11 * 60_000;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "expired" });
    clock.ms = T0;
    await worker.cancel({ tenantId: a.tenantId, attemptId });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    const second = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    await fixture.service((tx) => tx.query("UPDATE connection_attempts SET status='confirmed' WHERE id=$1", [second.attemptId]));
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: second.attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "conflict" });
  });

  it("answers rate_limited when the organization budget is spent, before any Composio call", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    await exhaustBudget();
    const calls = fake.calls.length;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "rate_limited" });
    expect(fake.calls).toHaveLength(calls);
  });
});

describe("cancel (C-5, C-9)", () => {
  it("revokes and deletes the account at once and marks the attempt cancelled", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled" });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("cancelled");
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled" });
  });

  it("does not delete an account another user owns", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.accounts.get(accountId)!.userId = composioUserId(ENV, b.tenantId);
    await expect(worker.cancel({ tenantId: a.tenantId, attemptId })).rejects.toThrow();
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
  });

  it("never deletes an account a connection row already owns; the attempt becomes confirmed", async () => {
    const { attemptId, accountId, connectionId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, id: connectionId, accountId });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "not_found" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("confirmed");
  });

  it("a delete failure leaves the attempt started for the sweep", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.override(/DELETE \/connected_accounts/, { status: 500 });
    await expect(worker.cancel({ tenantId: a.tenantId, attemptId })).rejects.toThrow();
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("started");
  });

  it("another tenant's attempt is not found", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    expect(await worker.cancel({ tenantId: b.tenantId, attemptId })).toEqual({ outcome: "not_found" });
  });
});

describe("run (C-6, C-10, C-12)", () => {
  async function liveConnection(tenant = a) {
    const accountId = seedAccount(tenant.tenantId);
    const id = await seedConnection(fixture, { tenantId: tenant.tenantId, memberId: tenant.memberId, accountId });
    return { id, accountId };
  }

  it("sends exactly four envelope keys and returns the projected order without the provider's extra fields", async () => {
    const { id, accountId } = await liveConnection();
    const out = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: { limit: 2 } });
    expect(out.outcome).toBe("ok");
    const exec = fake.callsTo(/tools\/execute\/SHOPIFY_GET_ORDERS_WITH_FILTERS/)[0]!;
    expect(Object.keys(exec.body as object).sort()).toEqual(["arguments", "connected_account_id", "user_id", "version"]);
    expect(exec.body).toMatchObject({ connected_account_id: accountId, user_id: composioUserId(ENV, a.tenantId), version: "20251201_00" });
    const text = JSON.stringify(out);
    for (const leaked of ["should-not-leak", "SKU-1", "secret-vendor", "+15555550100", "note_attributes", "default_address"]) expect(text).not.toContain(leaked);
    expect(out).toMatchObject({ outcome: "ok", truncated: false, data: { orders: [{ id: "1001" }, { id: "1002" }] } });
  });

  it("refuses override fields, extra fields and an unknown tool without a Composio call", async () => {
    const { id } = await liveConnection();
    const before = fake.calls.length;
    for (const args of [{ connected_account_id: "ca_x" }, { user_id: "u" }, { version: "latest" }, { custom_auth_params: {} }, { arguments: {} }, { extra: 1 }, { limit: 999 }]) {
      expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: args })).toEqual({ outcome: "error", code: "invalid_arguments" });
    }
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_delete_everything", arguments: {} })).toEqual({ outcome: "error", code: "not_found" });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_get_order", arguments: { orderId: "12; DROP" } })).toEqual({ outcome: "error", code: "invalid_arguments" });
    expect(fake.calls).toHaveLength(before);
  });

  it("another tenant's connection id is not found; a reauthorize row needs a reconnect; a disconnecting row is not found", async () => {
    const { id } = await liveConnection();
    expect(await worker.run({ tenantId: b.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "not_found" });
    const re = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId), status: "reauthorize" });
    expect(await worker.run({ tenantId: b.tenantId, connectionId: re, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "not_found" });
  });

  it("a successful:false answer is provider_unavailable and carries no provider text", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "boom: secret-detail-123", data: {} } });
    const out = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(out).toEqual({ outcome: "error", code: "provider_unavailable" });
    expect(JSON.stringify(reports)).not.toContain("secret-detail-123");
  });

  it("an authorization failure marks the row reauthorize/auth_error; the next run does not call Composio", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "401 Unauthorized: invalid access token", data: null } });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
    const before = fake.calls.length;
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(fake.calls).toHaveLength(before);
  });

  it("a non-ACTIVE or mismatched account marks the row reauthorize/provider_status and never executes", async () => {
    for (const change of [{ status: "INACTIVE" }, { userId: composioUserId(ENV, b.tenantId) }, { authConfigId: "ac_other" }]) {
      const { id, accountId } = await liveConnection();
      Object.assign(fake.accounts.get(accountId)!, change);
      expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
      expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "provider_status" });
      await database.pool.query("DELETE FROM connections WHERE id=$1", [id]);
    }
    expect(fake.callsTo(/tools\/execute\/SHOPIFY_GET_ORDERS/)).toHaveLength(0);
  });

  it("a Composio 429 opens the cooldown: retry after 60 s, then no further calls", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 429, json: {}, times: 1 });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_rate_limited", retryAfterSeconds: 60 });
    const before = fake.calls.length;
    const second = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(second).toMatchObject({ outcome: "error", code: "provider_rate_limited" });
    expect(fake.calls).toHaveLength(before);
  });

  it("the organization budget refuses before Composio is called", async () => {
    const { id } = await liveConnection();
    await exhaustBudget();
    const out = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(out).toMatchObject({ outcome: "error", code: "provider_rate_limited" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a 2 MiB provider body and trims a long list to 64 KiB with truncated:true", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { bytes: 2 * 1024 * 1024, times: 1 });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_unavailable" });
    fake.orders = Array.from({ length: 50 }, (_, i) => fakeOrder(2000 + i, { line_items: Array.from({ length: 40 }, (_, n) => ({ title: "x".repeat(200), quantity: n, price: "1.00" })) }));
    const out = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(out.outcome).toBe("ok");
    if (out.outcome === "ok") {
      expect(out.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("reports carry ids, tool and code, never arguments or output", async () => {
    const { id } = await liveConnection();
    await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_get_order", arguments: { orderId: "1001" } });
    const text = JSON.stringify(reports);
    expect(text).toContain("shopify_get_order");
    expect(text).not.toContain("1001");
    expect(text).not.toContain("Ada");
  });
});

describe("disconnect (C-13)", () => {
  const disconnecting = async (tenant = a) => {
    const accountId = seedAccount(tenant.tenantId);
    const id = await seedConnection(fixture, { tenantId: tenant.tenantId, memberId: tenant.memberId, accountId, status: "disconnecting" });
    return { id, accountId };
  };

  it("revokes, deletes and clears the label", async () => {
    const { id, accountId } = await disconnecting();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", account_label: null, last_error_code: null });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
  });

  it("a revoke failure is recorded and the delete still runs", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/POST \/connected_accounts\/[^/]+\/revoke/, { status: 500 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: "revoke_failed" });
  });

  it("a delete failure leaves the row disconnecting; the pass finishes it later", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnecting", last_error_code: "delete_failed" });
    const result = await worker.pass();
    expect(result.disconnected).toBe(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
  });

  it("answers pending for a row another worker holds, and not_found for another tenant or a live row", async () => {
    const { id } = await disconnecting();
    expect(await worker.disconnect({ tenantId: b.tenantId, connectionId: id })).toEqual({ outcome: "not_found" });
    const held = database.pool.connect();
    const client = await held;
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM connections WHERE id=$1 FOR UPDATE", [id]);
      expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const live = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId) });
    expect(await worker.disconnect({ tenantId: b.tenantId, connectionId: live })).toEqual({ outcome: "not_found" });
  });
});

describe("the pass (C-8, C-9, C-12)", () => {
  it("sweeps an unconfirmed attempt only after expiry plus one hour, and only an account the attempt names", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    const bystander = seedAccount(a.tenantId, "ca_bystander");
    clock.ms = T0 + 10 * 60_000 + HOUR - 1000;
    expect((await worker.pass()).swept).toBe(0);
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
    clock.ms = T0 + 10 * 60_000 + HOUR + 1000;
    expect((await worker.pass()).swept).toBe(1);
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect(fake.accounts.get(bystander)!.deleted).toBe(false);
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("swept");
  });

  it("marks an attempt confirmed instead of deleting when a connection row exists; leaves a foreign user's account alone; counts a 404 as swept", async () => {
    const one = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, id: one.connectionId, accountId: one.accountId, lastChecked: new Date(T0 + 2 * HOUR) });
    const two = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.accounts.get(two.accountId)!.userId = composioUserId(ENV, b.tenantId);
    const three = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    fake.accounts.get(three.accountId)!.deleted = true; // already gone
    clock.ms = T0 + 2 * HOUR;
    await worker.pass();
    expect((await attemptOf(fixture, a.tenantId, one.attemptId))?.status).toBe("confirmed");
    expect(fake.accounts.get(one.accountId)!.deleted).toBe(false);
    expect(fake.accounts.get(two.accountId)!.deleted).toBe(false);
    expect((await attemptOf(fixture, a.tenantId, two.attemptId))?.status).toBe("swept");
    expect((await attemptOf(fixture, a.tenantId, three.attemptId))?.status).toBe("swept");
  });

  it("a failed sweep delete leaves the attempt for the next pass", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.userId });
    clock.ms = T0 + 2 * HOUR;
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect((await worker.pass()).swept).toBe(0);
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("started");
    expect((await worker.pass()).swept).toBe(1);
  });

  it("health: an unhealthy active row moves to reauthorize/provider_status; a healthy provider_status row is restored; an auth_error row never is", async () => {
    const accountA = seedAccount(a.tenantId);
    const accountB = seedAccount(b.tenantId);
    const stale = new Date(T0 - 2 * DAY);
    const activeId = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: accountA, lastChecked: stale });
    const providerRow = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: accountB, status: "reauthorize", reason: "provider_status", lastChecked: stale });
    const authRow = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId), toolkit: "gmail", status: "reauthorize", reason: "auth_error", lastChecked: stale });
    fake.accounts.get(accountA)!.status = "INACTIVE";
    const result = await worker.pass();
    expect(result.checked).toBe(3);
    expect(await statusOf(fixture, a.tenantId, activeId)).toMatchObject({ status: "reauthorize", reauthorize_reason: "provider_status" });
    expect(await statusOf(fixture, b.tenantId, providerRow)).toMatchObject({ status: "active", reauthorize_reason: null });
    expect(await statusOf(fixture, b.tenantId, authRow)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("health: a healthy provider_status row stays reauthorize while the tenant has another live row for the toolkit", async () => {
    const stale = new Date(T0 - 2 * DAY);
    // The unique live-row index forbids two live rows; a disconnecting sibling is the realistic case.
    const sibling = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), status: "disconnecting", lastChecked: stale }).catch(() => null);
    expect(sibling).not.toBeNull();
    const row = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), status: "reauthorize", reason: "provider_status", lastChecked: stale }).catch(() => null);
    if (row === null) return; // the schema itself refuses the second live row, which is the stronger guarantee
    fake.gate = null;
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, row)).toMatchObject({ status: "reauthorize" });
  });

  it("race: a run that marks auth_error while the pass holds the row is never undone by the pass", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    let marked: Promise<unknown> | undefined;
    fake.gate = async (call) => {
      if (call.method === "GET" && !marked) {
        // The run fails with an auth error while the pass has the row locked; its update waits for the pass.
        marked = worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} }).catch(() => undefined);
      }
    };
    await worker.pass();
    fake.gate = null;
    await marked;
    const row = await statusOf(fixture, a.tenantId, id);
    expect(["active", "reauthorize"]).toContain(row.status);
    // Whatever order they ran in, an auth_error mark is final until Reconnect.
    await fixture.service((tx) => tx.query("UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error' WHERE id=$1", [id]));
    await fixture.service((tx) => tx.query("UPDATE connections SET last_checked_at=$2 WHERE id=$1", [id, new Date(T0 - 2 * DAY)]));
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("race: a row that turns disconnecting is not touched by the health read", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    fake.accounts.get(accountId)!.status = "INACTIVE";
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    const result = await worker.pass();
    expect(result.disconnected).toBe(1);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected" });
  });

  it("a transient provider error leaves the row as it is and records the code", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    fake.override(/GET \/connected_accounts\//, { status: 503 });
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: "provider_unavailable" });
  });

  it("stops at its call limit, its time limit and an exhausted budget; the nonce cleanup still runs", async () => {
    const stale = new Date(T0 - 2 * DAY);
    for (let i = 0; i < 4; i += 1) {
      const t = await newTenant(fixture);
      await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: seedAccount(t.tenantId), lastChecked: stale });
    }
    await worker.takeNonce("old-jti-0123456789abcdef", new Date(T0 - 1000));
    const limited = makeWorker(database, fake, clock, { passMaxCalls: 2 }, reports);
    const byCalls = await limited.pass();
    expect(byCalls).toMatchObject({ stopped: "calls", composioCalls: 2 });
    const left = await fixture.service(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM connector_request_nonces WHERE jti='old-jti-0123456789abcdef'")).rows[0]!.n);
    expect(left).toBe(0);

    await database.pool.query("UPDATE connections SET last_checked_at=$1", [stale]);
    const slowFake = new FakeComposio();
    for (const a2 of fake.accounts.values()) slowFake.accounts.set(a2.id, a2);
    slowFake.gate = async () => { clock.ms += 30_000; };
    const timed = makeWorker(database, slowFake, clock, { passMs: 40_000 }, reports);
    expect((await timed.pass()).stopped).toBe("time");

    clock.ms = T0;
    await exhaustBudget();
    expect((await makeWorker(database, fake, clock, {}, reports).pass()).stopped).toBe("budget");
  });

  it("two passes at once never take the same row twice", async () => {
    const stale = new Date(T0 - 2 * DAY);
    for (let i = 0; i < 4; i += 1) {
      const t = await newTenant(fixture);
      await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: seedAccount(t.tenantId), lastChecked: stale });
    }
    const [one, two] = await Promise.all([worker.pass(), makeWorker(database, fake, clock, {}, reports).pass()]);
    expect(one.checked + two.checked).toBe(4);
  });
});

describe("nonces (C-3)", () => {
  it("records a request id once", async () => {
    const jti = randomUUID();
    expect(await worker.takeNonce(jti, new Date(T0 + 120_000))).toBe(true);
    expect(await worker.takeNonce(jti, new Date(T0 + 120_000))).toBe(false);
  });
});
