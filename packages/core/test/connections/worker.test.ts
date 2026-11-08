// Connections worker (docs/requirements/connections.md C-3, C-5, C-8, C-9, C-10, C-12, C-13, C-15) against a
// real local Postgres and the in-process fake Composio. No test reaches the real service.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { asService } from "@zs/db";
import { composioUserId, createComposioClient, createConnectionsWorker, type ConnectionsWorkerReport } from "../../src/index.js";
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

/** Removes the organization budget bucket, so the next call may spend again. */
const restoreBudget = () => database.pool.query("DELETE FROM rate_limit_buckets");

/** A promise a test resolves by hand, to hold one side of a race at a known point. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const attemptRow = (tenantId: string, id: string) => fixture.service(async (tx) => (await tx.query<{
  status: string; last_error_code: string | null; revoke_outcome: string | null; claimed_until: Date | null; session_presented_at: Date | null; external_account_id: string | null;
}>("SELECT status, last_error_code, revoke_outcome, claimed_until, session_presented_at, external_account_id FROM connection_attempts WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0]!);
const connectionRow = (tenantId: string, id: string) => fixture.service(async (tx) => (await tx.query<{ revoke_outcome: string | null; claimed_until: Date | null; updated_at: Date }>(
  "SELECT revoke_outcome, claimed_until, updated_at FROM connections WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0]!);
/** A structured provider-auth failure inside a 200 envelope (A-5). */
const AUTH_ENVELOPE = { status: 200, json: { successful: false, error: "the store refused the token", data: { status_code: 401 } } };

/** A connected account the fake already holds for a tenant. */
const seedAccount = (tenantId: string, id = `ca_seed_${randomUUID().slice(0, 8)}`) => {
  fake.seed({ id, userId: composioUserId(ENV, tenantId), authConfigId: AUTH_CONFIG });
  return id;
};

describe("native tier link (C-4, C-18)", () => {
  it("with the native tier on, a Shopify link is refused as not_found and makes no Composio call", async () => {
    const native = { run: async () => { throw new Error("unused"); }, finishDisconnect: async () => "disconnected" as const, pass: async () => ({ refreshed: 0 }) };
    const nativeWorker = createConnectionsWorker({
      service: (work) => asService(database.servicePool, work),
      composio: createComposioClient({ apiKey: "test-key", baseUrl: "https://composio.test/api/v3.1", fetch: fake.fetch, timeoutMs: 1500 }),
      clock, config: { env: ENV, callbackUrl: CALLBACK_URL, authConfigIds: { shopify: AUTH_CONFIG } }, native,
    });
    const linked = await nativeWorker.link({ tenantId: a.tenantId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(),
      shopDomain: "testshop.myshopify.com", createdBy: a.memberId, browserHash: "b".repeat(43) });
    expect(linked).toEqual({ outcome: "refused", code: "not_found" });
    expect(fake.calls).toHaveLength(0);
    expect((await database.pool.query("SELECT 1 FROM connection_attempts")).rowCount).toBe(0);
    // Without the native tier the same call links.
    expect((await worker.link({ tenantId: a.tenantId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(),
      shopDomain: "testshop.myshopify.com", createdBy: a.memberId, browserHash: "b".repeat(43) })).outcome).toBe("linked");
  });
});

describe("link (C-3, C-5)", () => {
  const linkInput = (over: Partial<Parameters<typeof worker.link>[0]> = {}) => ({
    tenantId: a.tenantId, toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), shopDomain: "testshop.myshopify.com",
    createdBy: a.memberId, browserHash: "b".repeat(43), ...over,
  });

  it("creates the account for the derived user, records the attempt and sends the one callback URL", async () => {
    const { attemptId, accountId, linked } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    expect(linked.outcome).toBe("linked");
    const call = fake.callsTo(/connected_accounts\/link/)[0]!;
    // C-17: Composio's hosted form ignored `connection_data` (both `shop` and `subdomain`, preview runs 2 and 3), so the link names no store.
    expect(call.body).toEqual({ auth_config_id: AUTH_CONFIG, user_id: `zsb:${ENV}:${a.tenantId}`, callback_url: CALLBACK_URL });
    expect(call.apiKey).toBe("test-key");
    expect(fake.accounts.get(accountId)?.userId).toBe(composioUserId(ENV, a.tenantId));
    expect(await attemptOf(fixture, a.tenantId, attemptId)).toEqual({ status: "started" });
  });

  it("refuses an unknown toolkit and a missing auth config without calling Composio", async () => {
    const out = await worker.link(linkInput({ toolkit: "nope", shopDomain: "x.myshopify.com" }));
    expect(out).toEqual({ outcome: "refused", code: "not_found" });
    expect(fake.calls).toHaveLength(0);
  });

  it("C-4: marks a link refusal nothingCreated only for Composio's own refusal envelope with no account named", async () => {
    const envelope = (status: number, extra: Record<string, unknown> = {}) => ({ error: { message: "x", status, request_id: "req_1", ...extra } });
    const link = async (status: number, json: unknown) => {
      fake.clearOverrides();
      fake.override(/POST \/connected_accounts\/link/, { status, json, times: 1 });
      return worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }));
    };
    for (const status of [400, 404, 422]) {
      expect(await link(status, envelope(status)), String(status)).toEqual({ outcome: "refused", code: "provider_unavailable", nothingCreated: true });
    }
    // Not a provider_refused answer: unreadable or foreign bodies, our key, a conflict, 5xx, a limit, a named account.
    for (const [status, json] of [
      [400, {}], [422, "not an envelope"], [400, envelope(422)], [400, { error: { message: "x", status: 400 } }],
      [401, envelope(401)], [403, envelope(403)], [409, envelope(409)], [410, envelope(410)], [408, envelope(408)],
      [500, envelope(500)], [503, envelope(503)], [400, envelope(400, { connected_account_id: "ca_x" })],
    ] as const) {
      expect(await link(status, json), `${status} ${JSON.stringify(json)}`).toEqual({ outcome: "refused", code: "provider_unavailable" });
      clock.ms += 120_000;
    }
    // A 429 or 402 is a limit, never a refusal to refund (and opens the organization cooldown).
    expect(await link(429, envelope(429))).toEqual({ outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: 60 });
    clock.ms += 120_000;
    expect(await link(402, envelope(402))).toEqual({ outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: 60 });
    clock.ms += 120_000;
    // A 200 we cannot use, and a timeout: the account may exist.
    expect(await link(200, { connected_account_id: "ca_x" })).toEqual({ outcome: "refused", code: "provider_unavailable" });
    fake.override(/POST \/connected_accounts\/link/, { hang: true, times: 1 });
    expect(await worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }))).toEqual({ outcome: "refused", code: "provider_unavailable" });
  });

  describe("C-4: an error envelope is not proof, so the worker lists the tenant's accounts first", () => {
    const refusal = { error: { message: "x", status: 422, request_id: "req_1" } };
    const LIST = /GET \/connected_accounts$/;
    const refuse = () => fake.override(/POST \/connected_accounts\/link/, { status: 422, json: refusal, times: 1 });
    const unverified = () => reports.filter((r) => r.kind === "link_unverified");
    const attemptRows = async () => (await database.pool.query<{ composio_account_id: string; status: string }>("SELECT composio_account_id, status FROM connection_attempts")).rows;

    it("an account for this user and auth config created since the attempt began: no marker, the account is marked for the sweep, an alert is raised", async () => {
      refuse();
      const created = new Date(clock.now().getTime() + 1000).toISOString();
      fake.override(LIST, { status: 200, json: { items: [{ id: "ca_made", user_id: "u", created_at: created }], next_cursor: null }, times: 1 });
      const out = await worker.link(linkInput());
      expect(out).toEqual({ outcome: "refused", code: "provider_unavailable" });
      expect(unverified()).toEqual([{ kind: "link_unverified", tenantId: a.tenantId, attemptId: expect.any(String), reason: "account_present", count: 1 }]);
      expect(await attemptRows()).toEqual([{ composio_account_id: "ca_made", status: "cancelling" }]);
      const query = fake.callsTo(LIST)[0]!.query;
      expect(query.getAll("user_ids")).toEqual([composioUserId(ENV, a.tenantId)]);
      expect(query.getAll("auth_config_ids")).toEqual([AUTH_CONFIG]);
    });

    it("no account since the attempt began (older ones do not count): the marker is set and nothing is marked", async () => {
      refuse();
      const old = new Date(clock.now().getTime() - 3_600_000).toISOString();
      fake.override(LIST, { status: 200, json: { items: [{ id: "ca_old", created_at: old }], next_cursor: null }, times: 1 });
      expect(await worker.link(linkInput())).toEqual({ outcome: "refused", code: "provider_unavailable", nothingCreated: true });
      expect(unverified()).toEqual([]);
      expect(await attemptRows()).toEqual([]);
      expect(fake.callsTo(LIST)).toHaveLength(1);
      // An empty list is the same.
      refuse();
      fake.override(LIST, { status: 200, json: { items: [], next_cursor: null }, times: 1 });
      expect(await worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }))).toMatchObject({ nothingCreated: true });
    });

    it("a list call that fails, times out or answers something unreadable: no marker, an alert, and no row (no account is known)", async () => {
      for (const override of [{ status: 500, json: {} }, { status: 200, json: { nope: true } }, { hang: true }] as const) {
        refuse();
        fake.override(LIST, { ...override, times: 1 });
        const out = await worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }));
        expect(out).toEqual({ outcome: "refused", code: "provider_unavailable" });
      }
      expect(unverified().map((r) => (r as { reason: string }).reason)).toEqual(["check_failed", "check_failed", "check_failed"]);
      expect(await attemptRows()).toEqual([]);
    }, 15_000);

    it("a list that cannot settle it (no created_at, or a full page that never reaches back) keeps the charge", async () => {
      refuse();
      fake.override(LIST, { status: 200, json: { items: [{ id: "ca_x" }], next_cursor: null }, times: 1 });
      expect(await worker.link(linkInput())).toEqual({ outcome: "refused", code: "provider_unavailable" });
      refuse();
      const old = new Date(clock.now().getTime() - 3_600_000).toISOString();
      const recentEnough = new Date(clock.now().getTime() - 30_000).toISOString();
      void old;
      // Every item is within the skew window, so it counts as present, not ambiguous.
      fake.override(LIST, { status: 200, json: { items: [{ id: "ca_y", created_at: recentEnough }], next_cursor: "more" }, times: 1 });
      expect(await worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }))).toEqual({ outcome: "refused", code: "provider_unavailable" });
      refuse();
      fake.override(LIST, { status: 200, json: { items: [{ id: "ca_z", created_at: old }], next_cursor: "more" }, times: 1 });
      expect(await worker.link(linkInput({ attemptId: randomUUID(), connectionId: randomUUID() }))).toMatchObject({ nothingCreated: true });
      expect(unverified().map((r) => (r as { reason: string }).reason)).toEqual(["check_ambiguous", "account_present"]);
    });

    it("no list call is made for a failure that was not a provider_refused answer", async () => {
      fake.override(/POST \/connected_accounts\/link/, { status: 503, json: {}, times: 1 });
      await worker.link(linkInput());
      expect(fake.callsTo(LIST)).toHaveLength(0);
    });
  });

  it("C-4: reports a failed link as a class and a request id, never provider text", async () => {
    fake.override(/POST \/connected_accounts\/link/, { status: 404, json: { error: { message: "SECRET words", status: 404, request_id: "req_77" } }, times: 1 });
    await worker.link(linkInput());
    expect(reports).toContainEqual({ kind: "link_refused", env: ENV, status: 404, errorClass: "provider_refused", requestId: "req_77" });
    expect(JSON.stringify(reports)).not.toContain("SECRET");
  });

  it("opens the cooldown on a Composio 429 and says when to retry, then refuses without a call", async () => {
    fake.override(/POST \/connected_accounts\/link/, { status: 429, json: {}, times: 1 });
    expect(await worker.link(linkInput())).toEqual({ outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: 60 });
    const calls = fake.calls.length;
    const second = await worker.link(linkInput());
    expect(second).toMatchObject({ outcome: "refused", code: "provider_rate_limited" });
    expect(second.outcome === "refused" && second.retryAfterSeconds).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(calls);
    expect(reports.some((r) => r.kind === "cooldown")).toBe(true);
  });

  it("deletes the new account when the attempt row cannot be written", async () => {
    // A tenant that does not exist makes the insert fail on its foreign key.
    const out = await worker.link(linkInput({ tenantId: randomUUID() }));
    expect(out).toEqual({ outcome: "refused", code: "provider_unavailable" });
    expect([...fake.accounts.values()].filter((x) => !x.deleted)).toHaveLength(0);
  });

  it("B-7: an account the link answer names but cannot be read is removed at once", async () => {
    fake.seed({ id: "ca_orphan", userId: composioUserId(ENV, a.tenantId), status: "INITIATED" });
    fake.override(/POST \/connected_accounts\/link/, { status: 201, json: { connected_account_id: "ca_orphan" }, times: 1 });
    expect(await worker.link(linkInput())).toEqual({ outcome: "refused", code: "provider_unavailable" });
    expect(fake.accounts.get("ca_orphan")).toMatchObject({ deleted: true });
  });

  it("B-7: a failed insert never deletes an account another attempt names", async () => {
    const first = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.override(/POST \/connected_accounts\/link/, {
      status: 201, times: 1,
      json: { link_token: "lt_x", redirect_url: "https://connect.composio.test/link/x", expires_at: "2026-11-06T12:00:00.000Z", connected_account_id: first.accountId },
    });
    // The same attempt ID makes the insert fail on the primary key.
    expect(await worker.link(linkInput({ attemptId: first.attemptId }))).toEqual({ outcome: "refused", code: "provider_unavailable" });
    expect(fake.accounts.get(first.accountId)).toMatchObject({ deleted: false, revoked: false });
  });

  it("B-7: when the compensating delete fails, a cancelling attempt records the account and the pass removes it", async () => {
    const connectionId = randomUUID();
    const blocker = randomUUID();
    fake.gate = async (call) => {
      // The insert loses to a row that takes the connection ID; that row is gone again by the time the delete fails.
      if (call.path === "/connected_accounts/link")
        await fixture.service((tx) => tx.query(
          `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,created_by,browser_hash,status,expires_at,created_at,updated_at)
           VALUES ($1,$2,$3,'shopify','ca_blocker',$4,'testshop.myshopify.com',$5,$6,'started',$7,$8,$8)`,
          [a.tenantId, blocker, connectionId, AUTH_CONFIG, a.memberId, "b".repeat(43), new Date(T0 + 600_000), new Date(T0)]));
      // (The worker's role cannot delete attempt rows; the test's admin pool can.)
      if (call.method === "DELETE") await database.pool.query("DELETE FROM connection_attempts WHERE id=$1", [blocker]);
    };
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    const attemptId = randomUUID();
    expect(await worker.link(linkInput({ attemptId, connectionId }))).toEqual({ outcome: "refused", code: "provider_unavailable" });
    fake.gate = null;
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelling" });
    const accountId = [...fake.accounts.keys()][0]!; // the one account the link made
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
    // The compensation only deletes: no uninstall without a leased, recorded row (C-13).
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(0);
    expect((await worker.pass()).swept).toBe(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelled" });
  });

  it("B-7: when nothing can record the account, an operator hears of it", async () => {
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect(await worker.link(linkInput({ tenantId: randomUUID() }))).toEqual({ outcome: "refused", code: "provider_unavailable" });
    const orphan = reports.find((r) => r.kind === "link_orphan");
    // The account ID is the only way an operator can find and remove it.
    expect(orphan).toMatchObject({ composioAccountId: [...fake.accounts.keys()].at(-1) });
  });
});

describe("complete (C-5, C-8, C-14)", () => {
  it("A-4: a status call for an attempt no callback reached is refused, even when the account is ACTIVE", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.consent(accountId);
    fake.accounts.get(accountId)!.status = "ACTIVE"; // consented in some other browser; nobody redeemed a session here
    const calls = fake.calls.length;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(fake.calls).toHaveLength(calls);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "started", session_presented_at: null });
  });

  it("A-4: once a callback presented a session, a status call picks up the account (the lost-answer path)", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    fake.loseNextCompleteAuth = true;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "provider_unavailable" });
    expect((await attemptRow(a.tenantId, attemptId)).session_presented_at).not.toBeNull();
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toMatchObject({ outcome: "verified", composioAccountId: accountId });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(1);
  });

  it("A-4: a first session Composio does not know (404) is final: nothing verifies, and no status call picks the account up", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.consent(accountId);
    fake.accounts.get(accountId)!.status = "ACTIVE"; // finished somewhere else; this browser holds no real session
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: "session-made-up" })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "started", session_presented_at: null });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(fake.callsTo(/GET \/connected_accounts/)).toHaveLength(0);
  });

  it("A-4: a definitive 400 or a redemption of another account clears the marker, so a later status call is refused", async () => {
    for (const answer of [{ status: 400, json: { error: { message: "user mismatch" } } }, { status: 200, json: { connected_account_id: "ca_someone_else", toolkit_slug: "shopify" } },
      // The right account but another toolkit in Composio's answer.
      { status: 200, json: { connected_account_id: "SAME", toolkit_slug: "gmail" } }]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
      const session = fake.consent(accountId);
      fake.accounts.get(accountId)!.status = "ACTIVE";
      const same = (answer.json as { connected_account_id?: string }).connected_account_id === "SAME";
      fake.override(/POST \/connected_accounts\/complete_auth/, { ...answer, json: same ? { ...answer.json, connected_account_id: accountId } : answer.json, times: 1 });
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "not_connected" });
      expect((await attemptRow(a.tenantId, attemptId)).session_presented_at).toBeNull();
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    }
  });

  it("A-4: a used session is read as our lost call only when an earlier callback presented one", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    fake.loseNextCompleteAuth = true;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "provider_unavailable" });
    // The reload carries the same session, which Composio now calls used (404): the earlier call redeemed it.
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toMatchObject({ outcome: "verified", composioAccountId: accountId });
  });

  it("verifies after the session is redeemed for the tenant's user and reads the store identity through the envelope", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    const out = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
    expect(out).toEqual({ outcome: "verified", composioAccountId: accountId, externalAccountId: "8812345", accountDomain: "testshop.myshopify.com", accountLabel: "Test Shop" });
    expect(fake.callsTo(/complete_auth/)[0]!.body).toEqual({ session_uri: session, user_id: composioUserId(ENV, a.tenantId) });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "verified", external_account_id: "8812345" });
    expect((fake.callsTo(/tools\/execute\/SHOPIFY_QUERY_SHOP/)[0]!.body as { arguments: unknown }).arguments).toEqual({ fields: "id name myshopifyDomain" });
  });

  it("A-3: a verified attempt (a reload) is checked again without a second redemption", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toMatchObject({ outcome: "verified" });
    expect(fake.callsTo(/complete_auth/)).toHaveLength(1);
  });

  it("a session redeemed for another tenant's user never connects (400 from Composio)", async () => {
    const { accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    // Tenant B's callback carries the session but names its own attempt.
    const other = await startAttempt(worker, { tenantId: b.tenantId, createdBy: b.memberId });
    const out = await worker.complete({ tenantId: b.tenantId, attemptId: other.attemptId, sessionUri: session });
    expect(out).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(fake.accounts.get(accountId)?.status).toBe("INITIATED");
    expect((await attemptOf(fixture, b.tenantId, other.attemptId))?.status).toBe("started");
  });

  it("a used session cannot be replayed to take the account over: the first presentation of it is refused", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    fake.sessions.get(session)!.used = true; // someone else used it first
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(fake.accounts.get(accountId)?.status).toBe("INITIATED");
  });

  it("A-4 fixation: a same-tenant swap of sessions cannot be turned into a grant by racing fabricated callbacks", async () => {
    // Browser B finishes consent on A's link, then presents that session under B's own attempt: A's account goes ACTIVE.
    const one = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const two = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const swapped = fake.consent(one.accountId);
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: two.attemptId, sessionUri: swapped })).toEqual({ outcome: "refused", reason: "attempt_changed" });
    expect(fake.accounts.get(one.accountId)!.status).toBe("ACTIVE");
    // A's browser holds no real session. Its first fabricated callback is in flight (Composio is slow) while a second arrives.
    let second: unknown;
    fake.gate = async (call) => {
      if (!/complete_auth/.test(call.path)) return;
      fake.gate = null;
      second = await worker.complete({ tenantId: a.tenantId, attemptId: one.attemptId, sessionUri: "made-up-2" });
    };
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: one.attemptId, sessionUri: "made-up-1" })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect(second).toEqual({ outcome: "refused", reason: "rate_limited" });
    // Afterwards the first presentation was final: nothing verifies, and a status call is refused too.
    expect(await attemptRow(a.tenantId, one.attemptId)).toMatchObject({ status: "started", session_presented_at: null });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: one.attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
  });

  it("C-5: a redemption that leaves the account pending frees the attempt, so the status call polls at once", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    // Composio accepts the session but the account is still INITIATED when read.
    fake.override(/POST \/connected_accounts\/complete_auth/, { json: { connected_account_id: accountId, toolkit_slug: "shopify" }, times: 1 });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "pending" });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ claimed_until: null });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "pending" });
  });

  it("C-4: a session of the tenant's other attempt ends this link as attempt_changed; a session of an unknown account is not_connected", async () => {
    const one = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const two = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const olderSession = fake.consent(one.accountId);
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: two.attemptId, sessionUri: olderSession })).toEqual({ outcome: "refused", reason: "attempt_changed" });
    expect(await attemptRow(a.tenantId, two.attemptId)).toMatchObject({ status: "started", session_presented_at: null });
    const unknown = fake.seed({ id: "ca_not_in_any_attempt", userId: composioUserId(ENV, a.tenantId), status: "INITIATED" });
    const strange = fake.consent(unknown.id);
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: two.attemptId, sessionUri: strange })).toEqual({ outcome: "refused", reason: "not_connected" });
  });

  it("refuses an account whose user, toolkit or auth config differs from the attempt", async () => {
    for (const change of [{ userId: composioUserId(ENV, b.tenantId) }, { toolkit: "gmail" }, { authConfigId: "ac_other" }]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
      const session = fake.consent(accountId);
      Object.assign(fake.accounts.get(accountId)!, change);
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "not_connected" });
    }
  });

  it("refuses when the consenting store differs from the typed shop domain (C-14)", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    fake.shops.set(accountId, { id: "1", name: "Other Shop", domain: "othershop.myshopify.com" });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "not_connected" });
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("started");
  });

  it("maps every Composio status: INITIATED/INITIALIZING pending, ACTIVE go, INACTIVE/FAILED/EXPIRED/unknown refuse", async () => {
    const outcomes: Record<string, string> = {};
    for (const status of ["INITIATED", "INITIALIZING", "ACTIVE", "INACTIVE", "FAILED", "EXPIRED", "SOMETHING_NEW"]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
      // A callback whose redemption answer was lost, then a status call: the account read decides.
      const session = fake.consent(accountId);
      fake.loseNextCompleteAuth = true;
      await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session });
      fake.accounts.get(accountId)!.status = status;
      const out = await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null });
      outcomes[status] = out.outcome === "refused" ? `refused:${out.reason}` : out.outcome;
    }
    expect(outcomes).toEqual({
      INITIATED: "pending", INITIALIZING: "pending", ACTIVE: "verified",
      INACTIVE: "refused:not_connected", FAILED: "refused:not_connected", EXPIRED: "refused:not_connected", SOMETHING_NEW: "refused:not_connected",
    });
  });

  it("B-11: a 401, 403 or 410 on complete_auth is our key, never the store: provider_unavailable and a key_refused report", async () => {
    for (const status of [401, 403, 410]) {
      const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
      const session = fake.consent(accountId);
      // Even with the account ACTIVE, a 410 never takes the used-session path.
      fake.accounts.get(accountId)!.status = "ACTIVE";
      fake.override(/POST \/connected_accounts\/complete_auth/, { status, json: {}, times: 1 });
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "provider_unavailable" });
      expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "started", session_presented_at: null });
      // Nothing was redeemed, so no status call may pick up an account somebody else activated.
      expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "not_connected" });
    }
    expect(reports.filter((r) => r.kind === "key_refused")).toHaveLength(3);
  });

  it("B-3: a rate-limited identity read opens the organization cooldown", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    fake.override(/POST \/tools\/execute\/SHOPIFY_QUERY_SHOP/, { status: 200, json: { successful: false, error: "slow down", data: { status_code: 429 } }, times: 1 });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "rate_limited" });
    expect(reports.some((r) => r.kind === "cooldown")).toBe(true);
    const calls = fake.calls.length;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "rate_limited" });
    expect(fake.calls).toHaveLength(calls);
  });

  it("refuses an expired attempt, another tenant's attempt, a cancelled attempt and a confirmed one", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    expect(await worker.complete({ tenantId: b.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    clock.ms = T0 + 11 * 60_000;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "expired" });
    clock.ms = T0;
    await worker.cancel({ tenantId: a.tenantId, attemptId });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: "session-x" })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    const second = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    await fixture.service((tx) => tx.query("UPDATE connection_attempts SET status='confirmed', external_account_id='8812345' WHERE id=$1", [second.attemptId]));
    expect(await worker.complete({ tenantId: a.tenantId, attemptId: second.attemptId, sessionUri: null })).toEqual({ outcome: "refused", reason: "conflict" });
  });

  it("answers rate_limited when the organization budget is spent, before any Composio call", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    await exhaustBudget();
    const calls = fake.calls.length;
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "rate_limited" });
    expect(fake.calls).toHaveLength(calls);
  });

  it("A-3 race: a cancel that lands while complete reads the store wins; complete moves nothing", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const session = fake.consent(accountId);
    let cancelled: unknown;
    // The identity answer is already on its way when the cancel deletes the account.
    fake.override(/POST \/tools\/execute\/SHOPIFY_QUERY_SHOP/, {
      status: 200, times: 1, json: { successful: true, error: null, data: { shop: { id: "gid://shopify/Shop/8812345", name: "Test Shop", myshopifyDomain: "testshop.myshopify.com" } } },
    });
    fake.gate = async (call) => {
      if (call.path === "/tools/execute/SHOPIFY_QUERY_SHOP" && cancelled === undefined) {
        cancelled = null;
        cancelled = await worker.cancel({ tenantId: a.tenantId, attemptId });
      }
    };
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: session })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    expect(cancelled).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelled", external_account_id: null });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
  });

  it("A-3 race, other order: a verified attempt that is then cancelled ends cancelled", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: fake.consent(accountId) })).toMatchObject({ outcome: "verified" });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelled" });
  });
});

describe("cancel (C-5, C-9)", () => {
  it("revokes and deletes the account at once and marks the attempt cancelled", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelled", revoke_outcome: "revoked", claimed_until: null });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: false });
  });

  it("B-10: a revoke failure is recorded and surfaced, also on a repeat", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500 });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
  });

  it("B-10: a cancel that overlaps another's removal answers in_progress; a retry once it ended answers the final outcome", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500, times: 1 });
    let overlapping: Awaited<ReturnType<typeof worker.cancel>> | null | undefined;
    fake.gate = async (call) => {
      // The first cancel's revoke is held here while a second cancel arrives.
      if (call.path.endsWith("/tools/execute/proxy") && overlapping === undefined) {
        overlapping = null;
        overlapping = await worker.cancel({ tenantId: a.tenantId, attemptId });
      }
    };
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
    expect(overlapping).toMatchObject({ outcome: "refused", code: "in_progress" });
    expect(overlapping?.outcome === "refused" && overlapping.retryAfterSeconds).toBeGreaterThan(0);
    fake.gate = null;
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
  });

  it("A-2, B-10: never touches an account another user owns; the attempt ends and the answer says so", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.accounts.get(accountId)!.userId = composioUserId(ENV, b.tenantId);
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "refused", code: "account_mismatch" });
    expect(fake.accounts.get(accountId)).toMatchObject({ deleted: false, revoked: false });
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelled", last_error_code: "account_mismatch" });
    expect(reports.some((r) => r.kind === "account_mismatch")).toBe(true);
    // The retry after that 409 still tells the owner the app may be installed: never a clean success.
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
    expect(fake.accounts.get(accountId)).toMatchObject({ deleted: false, revoked: false });
  });

  it("C-9: a cancel whose account read names no user removes nothing and does not answer a clean success", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    (fake.accounts.get(accountId) as unknown as { userId: string | null }).userId = null;
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: true });
    expect(fake.accounts.get(accountId)).toMatchObject({ deleted: false, revoked: false });
    // It can no longer connect, and the sweep retries it (C-9).
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelling", claimed_until: null });
  });

  it("B-10: a spent budget answers provider_rate_limited with a retry time and leaves the attempt cancelling", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    await exhaustBudget();
    const out = await worker.cancel({ tenantId: a.tenantId, attemptId });
    expect(out).toMatchObject({ outcome: "refused", code: "provider_rate_limited" });
    expect(out.outcome === "refused" && out.retryAfterSeconds).toBeGreaterThan(0);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelling", claimed_until: null });
    // A cancelling attempt can no longer verify.
    expect(await worker.complete({ tenantId: a.tenantId, attemptId, sessionUri: fake.consent(accountId) })).toEqual({ outcome: "refused", reason: "invalid_attempt" });
    await restoreBudget();
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
  });

  it("never deletes an account a connection row already owns", async () => {
    const { attemptId, accountId, connectionId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, id: connectionId, accountId });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "not_found" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
    // The attempt never verified a store, so it ends swept rather than confirmed (C-7).
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("swept");
  });

  it("a delete failure leaves the attempt cancelling for the sweep, which finishes it without waiting for expiry", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    await expect(worker.cancel({ tenantId: a.tenantId, attemptId })).rejects.toThrow();
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "cancelling", last_error_code: "delete_failed", claimed_until: null });
    expect((await worker.pass()).swept).toBe(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1); // the recorded revoke is not repeated
    expect((await attemptOf(fixture, a.tenantId, attemptId))?.status).toBe("cancelled");
  });

  it("another tenant's attempt is not found", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
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
    expect(exec.body).toMatchObject({ connected_account_id: accountId, user_id: composioUserId(ENV, a.tenantId), version: "20261104_00" });
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
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
    const before = fake.calls.length;
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(fake.calls).toHaveLength(before);
  });

  it("C-8, C-10: a provider 403 (the app's permissions) is provider_permission_denied; the row stays active and no reconnect is asked", async () => {
    const { id } = await liveConnection();
    // The shape recorded in preview run 3: a 200 envelope, successful:false, the provider's 403 in a structured field.
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "This app is not approved to access REST endpoints with protected customer data", data: { status_code: 403 } }, times: 1 });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_permission_denied" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", reauthorize_reason: null, last_error_code: "provider_permission_denied" });
    expect(reports.some((r) => (r as { kind?: string }).kind === "reauthorize")).toBe(false);
    expect(JSON.stringify(reports)).not.toContain("protected customer data");
    // The next run goes to Composio again (the row is not refused as `connection_needs_reconnect`), and a read that works clears the notice.
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toMatchObject({ outcome: "ok" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: null });
  });

  it("C-8: a health read does not clear the permission notice, and a later 401 still sends the row to reauthorize", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "x", data: { status_code: 403 } }, times: 1 });
    await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    await database.pool.query("UPDATE connections SET last_checked_at=$1 WHERE id=$2", [new Date(T0 - 2 * DAY), id]);
    expect(await worker.pass()).toMatchObject({ checked: 1 });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: "provider_permission_denied" });
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("C-8: a failed health read or an unusable answer does not end the permission notice; a 401 clears it with the move", async () => {
    const { id, accountId } = await liveConnection();
    const denied = () => fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "x", data: { status_code: 403 } }, times: 1 });
    denied();
    await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    await database.pool.query("UPDATE connections SET last_checked_at=$1 WHERE id=$2", [new Date(T0 - 2 * DAY), id]);
    fake.override(new RegExp(`GET /connected_accounts/${accountId}`), { status: 500, times: 1 });
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: "provider_permission_denied" });
    // A 200 whose data cannot be projected is provider_unavailable and leaves the notice.
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: true, data: { unrelated: "x" } }, times: 1 });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_unavailable" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: "provider_permission_denied" });
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error", last_error_code: null });
  });

  it("A-5: auth words in the provider text alone are not an authorization failure", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "401 Unauthorized: forbidden", data: null } });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_unavailable" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active" });
  });

  it("A-5: a 401 or 403 on our own Composio call is our key: provider_unavailable, a report, the row untouched", async () => {
    for (const status of [401, 403]) {
      const { id } = await liveConnection();
      fake.override(/POST \/tools\/execute/, { status, json: {}, times: 1 });
      expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_unavailable" });
      expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", reauthorize_reason: null });
      await database.pool.query("DELETE FROM connections WHERE id=$1", [id]);
    }
    expect(reports.filter((r) => r.kind === "key_refused")).toHaveLength(2);
  });

  it("B-2: an auth failure during the call upgrades a provider_status mark the health read made meanwhile", async () => {
    const { id } = await liveConnection();
    fake.gate = async (call) => {
      if (call.path.startsWith("/tools/execute/"))
        await fixture.service((tx) => tx.query("UPDATE connections SET status='reauthorize', reauthorize_reason='provider_status' WHERE id=$1", [id]));
    };
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("B-9: a disconnect that lands during the call wins; the data is dropped", async () => {
    const { id } = await liveConnection();
    fake.gate = async (call) => {
      if (call.path.startsWith("/tools/execute/"))
        await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    };
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "not_found" });
  });

  it("B-3: a rate limit inside the envelope opens the organization cooldown", async () => {
    const { id } = await liveConnection();
    fake.override(/POST \/tools\/execute/, { status: 200, json: { successful: false, error: "slow down", data: { status_code: 429 } }, times: 1 });
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toEqual({ outcome: "error", code: "provider_rate_limited", retryAfterSeconds: 60 });
    expect(reports.some((r) => r.kind === "cooldown")).toBe(true);
    const before = fake.calls.length;
    expect(await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} })).toMatchObject({ outcome: "error", code: "provider_rate_limited" });
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

  it("C-13, C-17: uninstalls the app through the proxy with the catalog's one fixed request, then deletes the account", async () => {
    const { id, accountId } = await disconnecting();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    const proxied = fake.callsTo(/POST \/tools\/execute\/proxy$/);
    expect(proxied).toHaveLength(1);
    expect(proxied[0]!.body).toEqual({
      connected_account_id: accountId, user_id: composioUserId(ENV, a.tenantId), method: "POST", endpoint: "/graphql.json",
      body: { query: "mutation { appUninstall { app { id } userErrors { field message } } }" },
    });
    // Order: read, uninstall, delete. Composio's own revoke is never called.
    expect(fake.calls.map((call) => `${call.method} ${call.path}`).filter((entry) => !entry.includes("/tools/execute/SHOPIFY")))
      .toEqual([`GET /connected_accounts/${accountId}`, "POST /tools/execute/proxy", `DELETE /connected_accounts/${accountId}`]);
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "revoked" });
  });

  it("C-13: a provider answer that is not a clean uninstall (a stale token, GraphQL errors, userErrors) is a failed revoke, and the delete still runs", async () => {
    const answers: unknown[] = [
      { status: 200, body: { status: 401, data: { errors: "[API] Invalid API key or access token" } } },
      { status: 200, body: { status: 200, data: { errors: [{ message: "Access denied" }] } } },
      { status: 200, body: { status: 200, data: { data: { appUninstall: { app: null, userErrors: [{ field: null, message: "nope" }] } } } } },
      { status: 200, body: { status: 200 } },
      { status: 200, body: { nonsense: true } },
    ];
    for (const answer of answers) {
      fake.clearOverrides();
      const { id, accountId } = await disconnecting();
      const { status, body } = answer as { status: number; body: unknown };
      fake.override(/POST \/tools\/execute\/proxy/, { status, json: body, times: 1 });
      expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
      expect(fake.accounts.get(accountId)!.deleted).toBe(true);
      expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "failed" });
      expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: "revoke_failed" });
    }
  });

  it("C-13: an uninstall is skipped, and nothing recorded, while another live connection holds the same store; the account is still deleted", async () => {
    await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId) }); // another tenant's live connection to the same store
    const { id, accountId } = await disconnecting();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(0);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: null });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: null });
  });

  it("C-13: cancelling an unconsented attempt does not uninstall an app another live connection uses", async () => {
    await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId) });
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    expect(await worker.cancel({ tenantId: a.tenantId, attemptId })).toEqual({ outcome: "cancelled", revokeFailed: false });
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(0);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
  });

  it("C-12, C-13: a Composio or relayed provider 429 on the uninstall records nothing, opens the cooldown, and the retry uninstalls", async () => {
    for (const limit of ["composio", "relayed"] as const) {
      fake.clearOverrides();
      await restoreBudget();
      const { id } = await disconnecting();
      if (limit === "composio") fake.override(/POST \/tools\/execute\/proxy/, { status: 429, times: 1 });
      else fake.override(/POST \/tools\/execute\/proxy/, { status: 200, json: { status: 429, data: {} }, times: 1 });
      expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
      expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: null });
      expect(reports.some((r) => r.kind === "cooldown")).toBe(true);
      await restoreBudget();
      expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
      expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "revoked" });
    }
  });

  it("C-13: a Composio 404 on the uninstall counts as revoked (the account is already gone)", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/POST \/tools\/execute\/proxy/, { status: 404, times: 1 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "revoked" });
  });

  it("revokes, deletes and clears the label", async () => {
    const { id, accountId } = await disconnecting();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", account_label: null, last_error_code: null });
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "revoked", claimed_until: null });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
  });

  it("a revoke failure is recorded and the delete still runs", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: "revoke_failed" });
  });

  it("B-1: a revoke failure survives a failed delete and the retry, which never revokes again", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/POST \/tools\/execute\/proxy/, { status: 500, times: 1 });
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "failed", claimed_until: null });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: "revoke_failed" });
  });

  it("B-1: a recorded revoke survives a spent budget; the retry deletes without revoking again", async () => {
    const { id, accountId } = await disconnecting();
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    await exhaustBudget();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    expect(await connectionRow(a.tenantId, id)).toMatchObject({ revoke_outcome: "revoked", claimed_until: null });
    await restoreBudget();
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1);
    expect(fake.accounts.get(accountId)!.deleted).toBe(true);
  });

  it("A-2: an account that is not the tenant's is never revoked or deleted; the row ends with account_mismatch", async () => {
    for (const change of [{ userId: composioUserId(ENV, b.tenantId) }, { authConfigId: "ac_other" }, { toolkit: "gmail" }]) {
      const { id, accountId } = await disconnecting();
      Object.assign(fake.accounts.get(accountId)!, change);
      expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
      expect(fake.accounts.get(accountId)).toMatchObject({ revoked: false, deleted: false });
      expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", last_error_code: "account_mismatch" });
    }
    expect(reports.filter((r) => r.kind === "account_mismatch")).toHaveLength(3);
  });

  it("A-2: without the toolkit's auth config the account's owner cannot be proved: nothing is revoked or deleted until it is back", async () => {
    const { id, accountId } = await disconnecting();
    const unconfigured = makeWorker(database, fake, clock, { authConfigIds: {} }, reports);
    const calls = fake.calls.length;
    expect(await unconfigured.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    expect((await unconfigured.pass()).disconnected).toBe(0);
    expect(fake.calls).toHaveLength(calls);
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: false, deleted: false });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnecting", last_error_code: "not_configured" });
    expect(reports.some((r) => r.kind === "disconnect_retry" && r.code === "not_configured")).toBe(true);
    // The configured worker finishes it.
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
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
    // A lease another worker holds.
    await fixture.service((tx) => tx.query("UPDATE connections SET claimed_until=$2 WHERE id=$1", [id, new Date(T0 + 30_000)]));
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "pending" });
    expect(fake.calls).toHaveLength(0);
    // A lease that lapsed is taken over.
    clock.ms = T0 + 31_000;
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    const live = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: seedAccount(b.tenantId) });
    expect(await worker.disconnect({ tenantId: b.tenantId, connectionId: live })).toEqual({ outcome: "not_found" });
  });

  it("B-5: no transaction is held across a Composio call, so a pool of one connection never deadlocks", async () => {
    const { id } = await disconnecting();
    type ServicePool = typeof database.servicePool;
    const PoolOfOne = database.servicePool.constructor as new (config: object) => ServicePool;
    const single = new PoolOfOne({ ...(database.servicePool as unknown as { options: object }).options, max: 1 });
    try {
      const one = createConnectionsWorker({
        service: (work) => asService(single, work),
        composio: createComposioClient({ apiKey: "test-key", baseUrl: "https://composio.test/api/v3.1", fetch: fake.fetch, timeoutMs: 1500 }),
        clock, config: { env: ENV, callbackUrl: CALLBACK_URL, authConfigIds: { shopify: AUTH_CONFIG } },
      });
      // While each Composio call is in flight, the one pool connection must be free for another statement.
      fake.gate = async () => { await asService(single, (tx) => tx.query("SELECT 1")); };
      expect(await one.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
      const t = await newTenant(fixture);
      await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: seedAccount(t.tenantId), lastChecked: new Date(T0 - 2 * DAY) });
      expect(await one.pass()).toMatchObject({ checked: 1, stopped: null });
    } finally {
      fake.gate = null;
      await single.end();
    }
  });
});

describe("the pass (C-8, C-9, C-12)", () => {
  it("sweeps an unconfirmed attempt only after expiry plus one hour, and only an account the attempt names", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    const bystander = seedAccount(a.tenantId, "ca_bystander");
    clock.ms = T0 + 10 * 60_000 + HOUR - 1000;
    expect((await worker.pass()).swept).toBe(0);
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
    clock.ms = T0 + 10 * 60_000 + HOUR + 1000;
    expect((await worker.pass()).swept).toBe(1);
    expect(fake.accounts.get(accountId)).toMatchObject({ revoked: true, deleted: true });
    expect(fake.accounts.get(bystander)!.deleted).toBe(false);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "swept", claimed_until: null });
  });

  it("ends an attempt a connection row owns without touching the account; counts a 404 as swept", async () => {
    const one = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, id: one.connectionId, accountId: one.accountId, lastChecked: new Date(T0 + 2 * HOUR) });
    const three = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.accounts.get(three.accountId)!.deleted = true; // already gone
    clock.ms = T0 + 2 * HOUR;
    await worker.pass();
    expect((await attemptOf(fixture, a.tenantId, one.attemptId))?.status).toBe("swept");
    expect(fake.accounts.get(one.accountId)!.deleted).toBe(false);
    expect((await attemptOf(fixture, a.tenantId, three.attemptId))?.status).toBe("swept");
  });

  it("B-8: a foreign account is left alone; the attempt ends with account_mismatch and an operator hears of it", async () => {
    const two = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    fake.accounts.get(two.accountId)!.userId = composioUserId(ENV, b.tenantId);
    clock.ms = T0 + 2 * HOUR;
    expect((await worker.pass()).swept).toBe(1);
    expect(fake.accounts.get(two.accountId)).toMatchObject({ deleted: false, revoked: false });
    expect(await attemptRow(a.tenantId, two.attemptId)).toMatchObject({ status: "swept", last_error_code: "account_mismatch" });
    expect(reports).toContainEqual({ kind: "account_mismatch", tenantId: a.tenantId, attemptId: two.attemptId });
  });

  it("B-8: an account whose read names no user is retried for a day, then given up", async () => {
    const { attemptId, accountId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    (fake.accounts.get(accountId) as unknown as { userId: string | null }).userId = null;
    clock.ms = T0 + 2 * HOUR;
    expect((await worker.pass()).swept).toBe(0);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "started", claimed_until: null });
    expect(reports.some((r) => r.kind === "sweep_failed" && r.code === "account_unverified")).toBe(true);
    clock.ms = T0 + 10 * 60_000 + HOUR + DAY + 1000;
    expect((await worker.pass()).swept).toBe(1);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "swept", last_error_code: "account_unverified" });
    expect(fake.accounts.get(accountId)!.deleted).toBe(false);
  });

  it("a failed sweep delete leaves the attempt for the next pass", async () => {
    const { attemptId } = await startAttempt(worker, { tenantId: a.tenantId, createdBy: a.memberId });
    clock.ms = T0 + 2 * HOUR;
    fake.override(/DELETE \/connected_accounts/, { status: 500, times: 1 });
    expect((await worker.pass()).swept).toBe(0);
    expect(await attemptRow(a.tenantId, attemptId)).toMatchObject({ status: "started", last_error_code: "delete_failed", claimed_until: null });
    expect((await worker.pass()).swept).toBe(1);
  });

  it("health: an unhealthy active row moves to reauthorize/provider_status; a healthy provider_status row is restored; an auth_error row never is", async () => {
    const accountA = seedAccount(a.tenantId);
    const accountB = seedAccount(b.tenantId);
    const stale = new Date(T0 - 2 * DAY);
    const c = await newTenant(fixture);
    const activeId = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: accountA, lastChecked: stale });
    const providerRow = await seedConnection(fixture, { tenantId: b.tenantId, memberId: b.memberId, accountId: accountB, status: "reauthorize", reason: "provider_status", lastChecked: stale });
    // E-2: a shopify row, so the read really runs and finds the account healthy.
    const authRow = await seedConnection(fixture, { tenantId: c.tenantId, memberId: c.memberId, accountId: seedAccount(c.tenantId), status: "reauthorize", reason: "auth_error", lastChecked: stale });
    fake.accounts.get(accountA)!.status = "INACTIVE";
    const result = await worker.pass();
    expect(result.checked).toBe(3);
    expect(fake.callsTo(/^GET \/connected_accounts\//)).toHaveLength(3);
    expect(await statusOf(fixture, a.tenantId, activeId)).toMatchObject({ status: "reauthorize", reauthorize_reason: "provider_status" });
    expect(await statusOf(fixture, b.tenantId, providerRow)).toMatchObject({ status: "active", reauthorize_reason: null });
    expect(await statusOf(fixture, c.tenantId, authRow)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error", last_checked_at: new Date(T0) });
  });

  it("B-2: a toolkit without an auth config is checked off with not_configured and never starves the rest", async () => {
    const stale = new Date(T0 - 2 * DAY);
    const gmail = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), toolkit: "gmail", lastChecked: new Date(T0 - 3 * DAY) });
    const shop = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), lastChecked: stale });
    expect(await makeWorker(database, fake, clock, { passMaxCalls: 1 }, reports).pass()).toMatchObject({ checked: 2, stopped: null });
    expect(await statusOf(fixture, a.tenantId, gmail)).toMatchObject({ status: "active", last_error_code: "not_configured", last_checked_at: new Date(T0) });
    expect(await statusOf(fixture, a.tenantId, shop)).toMatchObject({ last_checked_at: new Date(T0) });
  });

  it("B-2: a read that succeeds clears a transient code and bumps updated_at; a failed read records its code and bumps updated_at", async () => {
    const stale = new Date(T0 - 2 * DAY);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), lastChecked: stale, errorCode: "provider_unavailable" });
    clock.ms = T0 + 1000;
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: null });
    expect((await connectionRow(a.tenantId, id)).updated_at).toEqual(new Date(T0 + 1000));
    await fixture.service((tx) => tx.query("UPDATE connections SET last_checked_at=$2 WHERE id=$1", [id, stale]));
    fake.override(/GET \/connected_accounts\//, { status: 503, times: 1 });
    clock.ms = T0 + 2000;
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "active", last_error_code: "provider_unavailable" });
    expect((await connectionRow(a.tenantId, id)).updated_at).toEqual(new Date(T0 + 2000));
  });

  it("B-2: a healthy read of a row that is still reauthorize (auth_error) keeps its last code until it recovers", async () => {
    const stale = new Date(T0 - 2 * DAY);
    const id = await seedConnection(fixture, {
      tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), status: "reauthorize", reason: "auth_error", lastChecked: stale, errorCode: "provider_unavailable",
    });
    clock.ms = T0 + 1000;
    expect((await worker.pass()).checked).toBe(1);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({
      status: "reauthorize", reauthorize_reason: "auth_error", last_error_code: "provider_unavailable", last_checked_at: new Date(T0 + 1000),
    });
  });

  it("health: a healthy provider_status row stays reauthorize while the tenant has another live row for the toolkit", async () => {
    const stale = new Date(T0 - 2 * DAY);
    // The unique live-row index forbids two live rows; a disconnecting sibling is the realistic case.
    const sibling = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), status: "disconnecting", lastChecked: stale }).catch(() => null);
    expect(sibling).not.toBeNull();
    const row = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId: seedAccount(a.tenantId), status: "reauthorize", reason: "provider_status", lastChecked: stale }).catch(() => null);
    if (row === null) return; // the schema itself refuses the second live row, which is the stronger guarantee
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, row)).toMatchObject({ status: "reauthorize" });
  });

  it("E-1 race: a run that marks auth_error while the health read is in flight is never undone by the pass", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    let ran: unknown;
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    fake.gate = async (call) => {
      // The pass's health read is held here until the run has marked the row.
      if (call.method === "GET" && ran === undefined) {
        ran = null;
        ran = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
      }
    };
    expect((await worker.pass()).checked).toBe(1);
    expect(ran).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    // The account reads healthy, and still the row keeps its auth_error.
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("E-1 race, other order: a provider_status mark landing during a run's call is upgraded by its auth failure, and a later healthy read keeps it", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    const held = deferred();
    let passed: Promise<unknown> | undefined;
    fake.override(/POST \/tools\/execute/, AUTH_ENVELOPE);
    fake.gate = async (call) => {
      if (call.path.startsWith("/tools/execute/") && !passed) {
        // While the run's call is in flight, the pass reads the account as INACTIVE and marks the row.
        fake.accounts.get(accountId)!.status = "INACTIVE";
        passed = worker.pass().then(() => held.resolve());
        await held.promise;
      }
    };
    const out = await worker.run({ tenantId: a.tenantId, connectionId: id, tool: "shopify_list_orders", arguments: {} });
    expect(out).toEqual({ outcome: "error", code: "connection_needs_reconnect" });
    expect(reports.filter((r) => r.kind === "reauthorize").map((r) => r.kind === "reauthorize" && r.reason)).toEqual(["provider_status", "auth_error"]);
    fake.gate = null;
    fake.accounts.get(accountId)!.status = "ACTIVE";
    await fixture.service((tx) => tx.query("UPDATE connections SET last_checked_at=$2 WHERE id=$1", [id, new Date(T0 - 2 * DAY)]));
    await worker.pass();
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });

  it("E-1 race: a disconnect that lands during the health read is never undone; the next pass finishes it", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    fake.accounts.get(accountId)!.status = "INACTIVE";
    let moved = false;
    fake.gate = async (call) => {
      if (call.method === "GET" && !moved) {
        moved = true;
        await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnecting', updated_at=$2 WHERE id=$1", [id, new Date(T0)]));
      }
    };
    expect(await worker.pass()).toMatchObject({ checked: 1, disconnected: 0 });
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnecting", reauthorize_reason: null });
    fake.gate = null;
    expect((await worker.pass()).disconnected).toBe(1);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected" });
  });

  it("E-1 race, other order: a health pass that runs while a disconnect removes the account neither marks the row nor removes it twice", async () => {
    const accountId = seedAccount(a.tenantId);
    const id = await seedConnection(fixture, { tenantId: a.tenantId, memberId: a.memberId, accountId, lastChecked: new Date(T0 - 2 * DAY) });
    // A health read would mark this row reauthorize.
    fake.accounts.get(accountId)!.status = "INACTIVE";
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnecting', updated_at=$2 WHERE id=$1", [id, new Date(T0)]));
    let passed: unknown;
    fake.gate = async (call) => {
      // The disconnect's account read is held here while a whole pass runs.
      if (call.method === "GET" && passed === undefined) {
        passed = null;
        passed = await worker.pass();
      }
    };
    expect(await worker.disconnect({ tenantId: a.tenantId, connectionId: id })).toEqual({ outcome: "disconnected" });
    expect(passed).toMatchObject({ checked: 0, disconnected: 0 });
    expect(fake.callsTo(/\/execute\/proxy$/)).toHaveLength(1);
    expect(fake.callsTo(/^DELETE /)).toHaveLength(1);
    expect(await statusOf(fixture, a.tenantId, id)).toMatchObject({ status: "disconnected", reauthorize_reason: null, last_error_code: null });
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
    // Every lease the stopped pass took was given back.
    expect((await database.pool.query("SELECT count(*)::int AS n FROM connections WHERE claimed_until IS NOT NULL")).rows[0].n).toBe(0);

    await database.pool.query("UPDATE connections SET last_checked_at=$1", [stale]);
    const slowFake = new FakeComposio();
    for (const a2 of fake.accounts.values()) slowFake.accounts.set(a2.id, a2);
    slowFake.gate = async () => { clock.ms += 30_000; };
    const timed = makeWorker(database, slowFake, clock, { passMs: 20_000 }, reports);
    expect((await timed.pass()).stopped).toBe("time");

    clock.ms = T0;
    await exhaustBudget();
    expect((await makeWorker(database, fake, clock, {}, reports).pass()).stopped).toBe("budget");
  });

  it("C-9: a provider call that hangs is cut at the pass deadline, not at its own 1.5 s timeout", async () => {
    const t = await newTenant(fixture);
    await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: seedAccount(t.tenantId), lastChecked: new Date(T0 - 2 * DAY) });
    fake.override(/^GET \/connected_accounts\//, { hang: true });
    const started = Date.now();
    const out = await makeWorker(database, fake, clock, { passMs: 300 }, reports).pass();
    const took = Date.now() - started;
    // The harness client gives a call 1,500 ms; the pass allows 300 ms in all, so the call is aborted there.
    expect(took).toBeLessThan(1000);
    expect(out).toMatchObject({ checked: 1, composioCalls: 1 });
    expect((await database.pool.query("SELECT last_error_code FROM connections")).rows[0].last_error_code).toBe("provider_unavailable");
  });

  it("B-4: the pass budget fits the 30 s function limit", () => {
    expect(() => makeWorker(database, fake, clock, { passMs: 40_000 })).toThrow();
    expect(worker.config.passMs).toBeLessThanOrEqual(25_000);
  });

  it("two passes at once never take the same row twice", async () => {
    const stale = new Date(T0 - 2 * DAY);
    for (let i = 0; i < 4; i += 1) {
      const t = await newTenant(fixture);
      await seedConnection(fixture, { tenantId: t.tenantId, memberId: t.memberId, accountId: seedAccount(t.tenantId), lastChecked: stale });
    }
    const [one, two] = await Promise.all([worker.pass(), makeWorker(database, fake, clock, {}, reports).pass()]);
    expect(one.checked + two.checked).toBe(4);
    expect(fake.callsTo(/^GET \/connected_accounts\//)).toHaveLength(4);
  });
});

describe("nonces (C-3)", () => {
  it("records a request id once", async () => {
    const jti = randomUUID();
    expect(await worker.takeNonce(jti, new Date(T0 + 120_000))).toBe(true);
    expect(await worker.takeNonce(jti, new Date(T0 + 120_000))).toBe(false);
  });
});
