// M5 top-ups through the session (stripe.md S-1, S-2), webhook intake (S-3) and tenancy of the
// billing tables (S-7), against the local Postgres with a manual clock and a stub Stripe client.
import { randomUUID } from "node:crypto";
import type { Transaction } from "@zs/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WALLET_TOPUP_CREATE_ACTION } from "@zs/contracts";
import { CHECKOUT_LIFETIME_MS, CHECKOUT_RETRY_LIMIT_MS, createSession, directDispatch, memberAuthorize } from "../../src/index.js";
import { createBillingHarness, stripeId, type BillingHarness } from "./helpers.js";

let b: BillingHarness;
beforeAll(async () => { b = await createBillingHarness(); });
afterEach(async () => {
  await b.settle();
  b.stripe.calls.length = 0;
});
afterAll(async () => { await b?.close(); });

const topupCount = async (tenantId: string) =>
  (await b.h.rows("SELECT 1 FROM wallet_topups WHERE tenant_id=$1", [tenantId])).length;

describe("starting a top-up (S-1, S-2)", () => {
  it("records a pending top-up and asks Stripe for a session derived from the stored row", async () => {
    const tenantId = await b.tenant();
    const createdAt = b.h.clock.now();
    const session = await b.session(tenantId);
    const result = await session.createTopUp({ amount: 2_500 }, "owner-topup-1");
    expect(result).toEqual({
      topup: { id: expect.any(String), amount: 2_500, currency: "usd", status: "pending", refunded: 0, createdAt: createdAt.toISOString(), paidAt: null },
      checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//),
    });
    expect(b.stripe.calls).toEqual([{
      tenantId, topupId: result.topup.id, amount: 2_500, currency: "usd",
      expiresAt: Math.floor((createdAt.getTime() + CHECKOUT_LIFETIME_MS) / 1000),
    }]);
    const row = await b.topupRow(tenantId, result.topup.id);
    expect(row).toMatchObject({ status: "pending", amount: "2500", refunded: "0", paid_at: null, stripe_checkout_session_id: null });
    expect(await session.listTopUps()).toEqual({ items: [result.topup] });
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
  });

  it("replays under the same key: same top-up, same Stripe request, one row", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const first = await session.createTopUp({ amount: 1_000 }, "owner-topup-replay");
    b.h.clock.advance(60_000);
    const again = await session.createTopUp({ amount: 1_000 }, "owner-topup-replay");
    expect(again).toEqual(first);
    expect(b.stripe.calls).toHaveLength(2);
    expect(b.stripe.calls[1]).toEqual(b.stripe.calls[0]);
    expect(await topupCount(tenantId)).toBe(1);
    // A new key is a new top-up.
    const other = await session.createTopUp({ amount: 1_000 }, "owner-topup-other");
    expect(other.topup.id).not.toBe(first.topup.id);
    expect(await topupCount(tenantId)).toBe(2);
  });

  it("refuses amounts outside the configured range without a row or a Stripe call", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const { minTopUp, maxTopUp } = b.stripe.client.config;
    for (const amount of [minTopUp - 1, maxTopUp + 1, 0, -5, 12.5]) {
      await expect(session.createTopUp({ amount }, `bad-amount-${randomUUID()}`), String(amount))
        .rejects.toMatchObject({ code: "ValidationFailed" });
    }
    await expect(session.createTopUp({ amount: 1_000, extra: true }, randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(b.stripe.calls).toEqual([]);
    expect(await topupCount(tenantId)).toBe(0);
    // The bounds themselves are allowed.
    await session.createTopUp({ amount: minTopUp }, randomUUID());
    await session.createTopUp({ amount: maxTopUp }, randomUUID());
    expect(await topupCount(tenantId)).toBe(2);
  });

  it("a retry up to the retry limit still asks Stripe; one later is topup_closed and Stripe is not called", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const first = await session.createTopUp({ amount: 1_500 }, "late-retry");
    b.h.clock.advance(CHECKOUT_RETRY_LIMIT_MS);
    expect(await session.createTopUp({ amount: 1_500 }, "late-retry")).toEqual(first);
    expect(b.stripe.calls).toHaveLength(2);
    b.h.clock.advance(1);
    await expect(session.createTopUp({ amount: 1_500 }, "late-retry"))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "topup_closed" } });
    expect(b.stripe.calls).toHaveLength(2);
    expect(await topupCount(tenantId)).toBe(1);
  });

  it("a retry for a top-up that is no longer pending is topup_closed and Stripe is not called", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const { topup } = await session.createTopUp({ amount: 900 }, "closed-retry");
    const sessionId = b.stripe.sessionFor(topup.id);
    await b.deliver(b.event("checkout.session.expired",
      b.checkoutSession({ tenantId, topupId: topup.id, sessionId, amount: 900, paymentIntent: null, paymentStatus: "unpaid", status: "expired" })));
    await b.worker().runOnce();
    expect((await b.topupRow(tenantId, topup.id)).status).toBe("expired");
    b.stripe.calls.length = 0;
    await expect(session.createTopUp({ amount: 900 }, "closed-retry"))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "topup_closed" } });
    expect(b.stripe.calls).toEqual([]);
  });

  it("is NotFound without Stripe config and TenantDenied for staff", async () => {
    const tenantId = await b.tenant();
    await expect((await b.session(tenantId, { billing: false })).createTopUp({ amount: 1_000 }, randomUUID()))
      .rejects.toMatchObject({ code: "NotFound" });
    const staff = await b.session(tenantId, { role: "staff" });
    await expect(staff.createTopUp({ amount: 1_000 }, randomUUID())).rejects.toMatchObject({ code: "TenantDenied" });
    await expect(staff.listTopUps()).rejects.toMatchObject({ code: "TenantDenied" });
    expect(b.stripe.calls).toEqual([]);
    expect(await topupCount(tenantId)).toBe(0);
  });
});

describe("webhook intake (S-3)", () => {
  it("stores an event once; a redelivery changes nothing", async () => {
    const payload = b.event("checkout.session.completed", { id: stripeId("cs"), object: "checkout.session", mode: "payment" });
    expect(await b.deliver(payload)).toEqual({ stored: true });
    b.h.clock.advance(5_000);
    expect(await b.deliver({ ...payload, pending_webhooks: 2 })).toEqual({ stored: false });
    const rows = await b.h.rows("SELECT id, type, payload, attempts, processed_at, outcome, received_at FROM stripe_events WHERE id=$1", [payload.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: payload.id, type: "checkout.session.completed", attempts: 0, processed_at: null, outcome: null });
    expect(rows[0]!.payload).toEqual(payload);
    expect(rows[0]!.received_at.getTime()).toBe(b.h.clock.now().getTime() - 5_000);
  });

  it("the runtime role may only insert a fresh event: no read, update, delete or worker columns", async () => {
    const payload = b.event("charge.refunded", { id: stripeId("ch"), object: "charge" });
    await b.deliver(payload);
    const db = b.h.database.db;
    const tenantId = b.h.fixture.a.tenantId;
    const runners: Array<(work: (tx: Transaction) => Promise<unknown>) => Promise<unknown>> = [
      (work) => db.platform!(work),
      (work) => db.tenant(tenantId, work),
    ];
    for (const run of runners) {
      for (const [sql, params] of [
        ["SELECT id FROM stripe_events", []],
        ["UPDATE stripe_events SET outcome='ignored', processed_at=now() WHERE id=$1", [payload.id]],
        ["UPDATE stripe_events SET next_attempt_at=now()", []],
        ["DELETE FROM stripe_events WHERE id=$1", [payload.id]],
        ["INSERT INTO stripe_events (id,type,payload,received_at,next_attempt_at,processed_at,outcome) VALUES ($1,'x','{}',now(),now(),now(),'credited')", [stripeId("evt")]],
        ["INSERT INTO stripe_events (id,type,payload,received_at,next_attempt_at,attempts) VALUES ($1,'x','{}',now(),now(),5)", [stripeId("evt")]],
      ] as const) {
        await expect(run((tx) => tx.query(sql, [...params])), sql).rejects.toMatchObject({ code: "42501" });
      }
    }
    // The service role reads it, untouched.
    expect(await b.eventRow(payload.id)).toMatchObject({ attempts: 0, processed_at: null, outcome: null });
  });

  it("a fresh, well-formed insert from a tenant-scoped runtime transaction is refused: only the webhook's platform intake may write", async () => {
    // What a signed-in user's JWT would be through the Data API: the runtime role without app.platform.
    const forged = b.event("checkout.session.completed", { id: stripeId("cs"), object: "checkout.session", mode: "payment" });
    const insert = (tx: Transaction) => tx.query(
      "INSERT INTO stripe_events (id,type,payload,received_at,next_attempt_at) VALUES ($1,$2,$3::jsonb,now(),now())",
      [forged.id, forged.type, JSON.stringify(forged)]);
    await expect(b.h.database.db.tenant(b.h.fixture.a.tenantId, insert)).rejects.toMatchObject({ code: "42501" });
    expect(await b.h.rows("SELECT id FROM stripe_events WHERE id=$1", [forged.id])).toEqual([]);
    // The same insert through the platform intake is stored.
    await b.h.database.db.platform!(insert);
    expect(await b.h.rows("SELECT id FROM stripe_events WHERE id=$1", [forged.id])).toHaveLength(1);
  });
});

describe("the server's top-up terms (S-1)", () => {
  /** A session whose Stripe config differs from the harness's in the given fields. */
  const sessionWith = async (tenantId: string, change: { currency?: string; minTopUp?: number; maxTopUp?: number }) =>
    createSession({ ...b.deps(), billing: { stripe: { ...b.stripe.client, config: { ...b.stripe.client.config, ...change } } } },
      { tenantId, actorId: await b.owner(tenantId) });

  it("a retry after the limits change replays the first request instead of conflicting", async () => {
    const tenantId = await b.tenant();
    const key = `topup-${randomUUID()}`;
    const first = await (await b.session(tenantId)).createTopUp({ amount: 1_000 }, key);
    // The amount is now outside the range, but the retry is the same request (S-2).
    const again = await (await sessionWith(tenantId, { minTopUp: 2_000, maxTopUp: 9_000 })).createTopUp({ amount: 1_000 }, key);
    expect(again).toEqual(first);
    expect(await topupCount(tenantId)).toBe(1);
    // A new request is judged by the new limits.
    await expect((await sessionWith(tenantId, { minTopUp: 2_000 })).createTopUp({ amount: 1_000 }, `topup-${randomUUID()}`))
      .rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("refuses with 409 wallet_currency, before Stripe, when the wallet holds another currency", async () => {
    const tenantId = await b.tenant();
    await b.paidTopUp(tenantId, 1_000);
    b.stripe.calls.length = 0;
    await expect((await sessionWith(tenantId, { currency: "eur" })).createTopUp({ amount: 1_000 }, `topup-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "wallet_currency" } });
    expect(b.stripe.calls).toEqual([]);
    expect(await topupCount(tenantId)).toBe(1);
    // A tenant with no wallet yet may start in the configured currency.
    const fresh = await b.tenant();
    expect((await (await sessionWith(fresh, { currency: "eur" })).createTopUp({ amount: 1_000 }, `topup-${randomUUID()}`)).topup.currency).toBe("eur");
  });

  it("cannot be run without the session's top-up route: no terms, no row", async () => {
    const tenantId = await b.tenant();
    const actorId = await b.owner(tenantId);
    const topupId = randomUUID();
    const run = directDispatch(b.deps(), tenantId, actorId, memberAuthorize(tenantId, actorId));
    await expect(run({
      actionType: WALLET_TOPUP_CREATE_ACTION, target: { tenantId, type: "wallet_topup", id: topupId },
      payload: { topupId, amount: 1_000 }, approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: `topup-${randomUUID()}`,
    })).rejects.toMatchObject({ code: "NotFound" });
    // Old payloads that named their own terms are refused outright.
    await expect(run({
      actionType: WALLET_TOPUP_CREATE_ACTION, target: { tenantId, type: "wallet_topup", id: topupId },
      payload: { topupId, amount: 1_000, currency: "usd", minAmount: 1, maxAmount: 100_000_000 },
      approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: `topup-${randomUUID()}`,
    })).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await topupCount(tenantId)).toBe(0);
  });
});

describe("tenancy of the billing tables (S-7)", () => {
  it("tenant B sees none of tenant A's top-ups or billing events, and A cannot write money columns", async () => {
    const { a, b: other } = b.h.fixture;
    await b.owner(a.tenantId);
    const paid = await b.paidTopUp(a.tenantId, 3_000);
    await b.deliver(b.event("charge.refunded", b.charge(paid, 1_000)));
    await b.worker().runOnce();
    const pending = (await b.startTopUp(a.tenantId, 700)).topup;

    const read = (tenantId: string, sql: string) => b.h.database.db.tenant(tenantId, async (tx) => (await tx.query(sql)).rows);
    expect(await read(a.tenantId, "SELECT id FROM wallet_topups ORDER BY created_at")).toHaveLength(2);
    expect(await read(a.tenantId, "SELECT id FROM wallet_billing_events")).toHaveLength(1);
    expect(await read(other.tenantId, "SELECT id FROM wallet_topups")).toEqual([]);
    expect(await read(other.tenantId, "SELECT id FROM wallet_billing_events")).toEqual([]);
    expect(await read(other.tenantId, "SELECT tenant_id FROM wallets")).toEqual([]);
    // Naming A's rows from B's transaction still finds nothing.
    expect(await b.h.database.db.tenant(other.tenantId, async (tx) =>
      (await tx.query("SELECT id FROM wallet_topups WHERE tenant_id=$1", [a.tenantId])).rows)).toEqual([]);
    // B's owner session cannot list A's top-ups either.
    expect(await (await b.session(other.tenantId)).listTopUps()).toEqual({ items: [] });

    const asA = (sql: string, params: unknown[]) => b.h.database.db.tenant(a.tenantId, (tx) => tx.query(sql, params));
    for (const [sql, params] of [
      ["UPDATE wallet_topups SET status='paid', paid_at=now() WHERE id=$1", [pending.id]],
      ["UPDATE wallet_topups SET refunded=0 WHERE id=$1", [paid.id]],
      ["UPDATE wallet_topups SET paid_at=NULL WHERE id=$1", [paid.id]],
      ["UPDATE wallet_topups SET stripe_payment_intent_id='pi_test_mine' WHERE id=$1", [pending.id]],
      ["DELETE FROM wallet_topups WHERE id=$1", [pending.id]],
      [`INSERT INTO wallet_topups (tenant_id,id,amount,currency,created_by,created_at,updated_at,status,paid_at)
        VALUES ($1,$2,100,'usd',$2,now(),now(),'paid',now())`, [a.tenantId, randomUUID()]],
      [`INSERT INTO wallet_billing_events (tenant_id,id,topup_id,kind,reference,amount,applied,created_at)
        VALUES ($1,$2,$3,'dispute_reinstated','dp_x',100,100,now())`, [a.tenantId, randomUUID(), paid.id]],
      ["DELETE FROM wallet_billing_events", []],
    ] as const) {
      await expect(asA(sql, [...params]), sql).rejects.toMatchObject({ code: "42501" });
    }
    // A runtime insert naming another tenant is refused by the policy.
    await expect(asA(
      "INSERT INTO wallet_topups (tenant_id,id,amount,currency,created_by,created_at,updated_at) VALUES ($1,$2,100,'usd',$2,now(),now())",
      [other.tenantId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    expect(await b.topupRow(a.tenantId, pending.id)).toMatchObject({ status: "pending", paid_at: null });
    expect(await b.topupRow(a.tenantId, paid.id)).toMatchObject({ status: "paid", refunded: "1000" });
    await b.expectConsistent(a.tenantId);
  });
});
