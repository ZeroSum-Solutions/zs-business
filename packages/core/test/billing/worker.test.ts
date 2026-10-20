// M5 billing worker (stripe.md S-4..S-7) against the local Postgres: Stripe-shaped events go
// in through recordStripeEvent, the worker runs as the service role with a manual clock, and
// every scenario ends with the wallet balance equal to its ledger.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBillingWorker, releaseReservation, reserveFunds } from "../../src/index.js";
import { createBillingHarness, stripeId, type BillingHarness, type PaidTopUp } from "./helpers.js";

let b: BillingHarness;
const touched = new Set<string>();
beforeAll(async () => { b = await createBillingHarness(); });
afterEach(async () => {
  // Ledger consistency after every scenario, for every tenant it touched.
  for (const tenantId of touched) await b.expectConsistent(tenantId);
  touched.clear();
  await b.settle();
});
afterAll(async () => { await b?.close(); });

async function tenant(): Promise<string> {
  const tenantId = await b.tenant();
  touched.add(tenantId);
  return tenantId;
}

/** A started top-up with the IDs its Stripe events will carry. */
async function pending(tenantId: string, amount: number) {
  const { topup, sessionId } = await b.startTopUp(tenantId, amount);
  return { tenantId, id: topup.id, amount, sessionId, paymentIntent: stripeId("pi"), chargeId: stripeId("ch") } satisfies PaidTopUp;
}
type Pending = Awaited<ReturnType<typeof pending>>;

function sessionEvent(type: string, t: Pending, overrides: Partial<Parameters<BillingHarness["checkoutSession"]>[0]> = {}) {
  return b.event(type, b.checkoutSession({
    tenantId: t.tenantId, topupId: t.id, sessionId: t.sessionId, amount: t.amount, paymentIntent: t.paymentIntent, ...overrides,
  }));
}
async function send(payload: ReturnType<BillingHarness["event"]>) {
  expect(await b.deliver(payload)).toEqual({ stored: true });
  return payload.id;
}
const outcome = async (eventId: string) => (await b.eventRow(eventId)).outcome as string | null;
const creditKeys = async (tenantId: string) =>
  (await b.h.rows<{ idempotency_key: string; amount: string }>(
    "SELECT idempotency_key, amount FROM wallet_ledger WHERE tenant_id=$1 AND kind='credit' ORDER BY created_at, idempotency_key", [tenantId]));
async function reserve(tenantId: string, deliveryId: string, amount: number) {
  return b.h.service((tx) => reserveFunds(tx, { tenantId, deliveryId, reservationId: randomUUID(), amount, now: b.h.clock.now() }));
}

describe("paid top-ups credit once (S-5)", () => {
  it("checkout.session.completed paid credits the wallet once; replays and async_payment_succeeded do not", async () => {
    const tenantId = await tenant();
    const t = await pending(tenantId, 2_000);
    const completed = sessionEvent("checkout.session.completed", t);
    const first = await send(completed);
    const paidAt = b.h.clock.now();
    expect(await b.worker().runOnce()).toMatchObject({ outcomes: { credited: 1 } });
    expect(await outcome(first)).toBe("credited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_000, reserved: 0, owed: 0 });
    expect(await b.topupRow(tenantId, t.id)).toMatchObject({
      status: "paid", stripe_checkout_session_id: t.sessionId, stripe_payment_intent_id: t.paymentIntent, paid_at: paidAt,
    });

    // The same event ID again is not stored; a distinct event for the same session is processed but credits nothing.
    b.h.clock.advance(1_000);
    expect(await b.deliver(completed)).toEqual({ stored: false });
    const succeeded = await send(sessionEvent("checkout.session.async_payment_succeeded", t));
    const again = await send(sessionEvent("checkout.session.completed", t));
    await b.worker().runOnce();
    expect(await outcome(succeeded)).toBe("already_credited");
    expect(await outcome(again)).toBe("already_credited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_000, reserved: 0, owed: 0 });
    expect(await creditKeys(tenantId)).toEqual([{ idempotency_key: `stripe:topup:${t.id}`, amount: "2000" }]);
    await expect((await b.session(tenantId)).getWallet()).resolves.toMatchObject({ balance: 2_000, available: 2_000 });
    expect((await b.topupRow(tenantId, t.id)).paid_at).toEqual(paidAt);
  });

  it("an amount or currency that differs from the top-up marks it mismatch and credits nothing", async () => {
    const tenantId = await tenant();
    const short = await pending(tenantId, 1_000);
    const foreign = await pending(tenantId, 1_000);
    const lowEvent = await send(sessionEvent("checkout.session.completed", short, { amount: 999 }));
    const eurEvent = await send(sessionEvent("checkout.session.completed", foreign, { currency: "eur" }));
    await b.worker().runOnce();
    expect(await outcome(lowEvent)).toBe("mismatch");
    expect(await outcome(eurEvent)).toBe("mismatch");
    expect(await b.topupRow(tenantId, short.id)).toMatchObject({ status: "mismatch", paid_at: null, stripe_payment_intent_id: short.paymentIntent });
    expect((await b.topupRow(tenantId, foreign.id)).status).toBe("mismatch");
    // A corrected event later does not pay a mismatched top-up, and a refund of it takes nothing.
    const later = await send(sessionEvent("checkout.session.async_payment_succeeded", short));
    const refund = await send(b.event("charge.refunded", b.charge(short, 1_000)));
    await b.worker().runOnce();
    expect(await outcome(later)).toBe("ignored");
    expect(await outcome(refund)).toBe("ignored");
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    expect(await creditKeys(tenantId)).toEqual([]);
  });

  it("metadata naming another tenant's top-up, or a session other than the stored one, is not_ours", async () => {
    const tenantA = await tenant();
    const tenantB = await tenant();
    const a = await pending(tenantA, 1_200);
    const other = await pending(tenantB, 1_200);
    const crossed = [
      await send(sessionEvent("checkout.session.completed", { ...a, tenantId: tenantB })),
      await send(sessionEvent("checkout.session.completed", { ...other, tenantId: tenantA })),
      await send(b.event("checkout.session.completed", { ...b.checkoutSession({ ...a, topupId: a.id }), metadata: {} })),
      await send(b.event("checkout.session.completed", { ...b.checkoutSession({ ...a, topupId: a.id }), metadata: { zs_tenant: "not-a-uuid", zs_topup: a.id } })),
      await send(sessionEvent("checkout.session.completed", a, { tenantId: tenantA, topupId: randomUUID() })),
      await send(b.event("checkout.session.completed", { ...b.checkoutSession({ ...a, topupId: a.id }), mode: "subscription" })),
    ];
    await b.worker().runOnce();
    for (const id of crossed) expect(await outcome(id), id).toBe("not_ours");
    expect((await b.topupRow(tenantA, a.id)).status).toBe("pending");
    expect((await b.topupRow(tenantB, other.id)).status).toBe("pending");
    expect(await b.wallet(tenantA)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    expect(await b.wallet(tenantB)).toEqual({ balance: 0, reserved: 0, owed: 0 });

    // Paid through its own session; a completion for another session naming it is not ours.
    await send(sessionEvent("checkout.session.completed", a));
    await b.worker().runOnce();
    const forged = await send(sessionEvent("checkout.session.completed", { ...a, sessionId: stripeId("cs"), paymentIntent: stripeId("pi") }));
    // An expired top-up whose stored session differs from the event's is not ours either.
    const lapsed = await pending(tenantA, 800);
    await send(sessionEvent("checkout.session.expired", lapsed, { paymentStatus: "unpaid", paymentIntent: null, status: "expired" }));
    await b.worker().runOnce();
    const revived = await send(sessionEvent("checkout.session.completed", { ...lapsed, sessionId: stripeId("cs") }));
    await b.worker().runOnce();
    expect(await outcome(forged)).toBe("not_ours");
    expect(await outcome(revived)).toBe("not_ours");
    expect(await b.wallet(tenantA)).toEqual({ balance: 1_200, reserved: 0, owed: 0 });
    expect((await b.topupRow(tenantA, a.id)).stripe_checkout_session_id).toBe(a.sessionId);
    expect((await b.topupRow(tenantA, lapsed.id)).status).toBe("expired");
  });

  it("an unpaid completion is ignored; the later async_payment_succeeded credits", async () => {
    const tenantId = await tenant();
    const t = await pending(tenantId, 3_000);
    const unpaid = await send(sessionEvent("checkout.session.completed", t, { paymentStatus: "unpaid" }));
    await b.worker().runOnce();
    expect(await outcome(unpaid)).toBe("ignored");
    expect((await b.topupRow(tenantId, t.id)).status).toBe("pending");
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    b.h.clock.advance(3 * 60 * 60_000);
    const succeeded = await send(sessionEvent("checkout.session.async_payment_succeeded", t));
    await b.worker().runOnce();
    expect(await outcome(succeeded)).toBe("credited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 3_000, reserved: 0, owed: 0 });
  });

  it("async_payment_failed marks failed and expired marks expired; neither credits later", async () => {
    const tenantId = await tenant();
    const failing = await pending(tenantId, 1_000);
    const lapsing = await pending(tenantId, 1_000);
    await send(sessionEvent("checkout.session.completed", failing, { paymentStatus: "unpaid" }));
    const failed = await send(sessionEvent("checkout.session.async_payment_failed", failing, { paymentStatus: "unpaid" }));
    const expired = await send(sessionEvent("checkout.session.expired", lapsing, { paymentStatus: "unpaid", paymentIntent: null, status: "expired" }));
    await b.worker().runOnce();
    expect(await outcome(failed)).toBe("failed");
    expect(await outcome(expired)).toBe("expired");
    expect(await b.topupRow(tenantId, failing.id)).toMatchObject({ status: "failed", stripe_checkout_session_id: failing.sessionId, paid_at: null });
    expect(await b.topupRow(tenantId, lapsing.id)).toMatchObject({ status: "expired", stripe_checkout_session_id: lapsing.sessionId });
    const late = [
      await send(sessionEvent("checkout.session.async_payment_succeeded", failing)),
      await send(sessionEvent("checkout.session.completed", lapsing)),
      await send(sessionEvent("checkout.session.expired", failing)),
    ];
    await b.worker().runOnce();
    for (const id of late) expect(await outcome(id)).toBe("ignored");
    expect((await b.topupRow(tenantId, failing.id)).status).toBe("failed");
    expect((await b.topupRow(tenantId, lapsing.id)).status).toBe("expired");
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
  });

  it("a paid top-up never changes status afterwards", async () => {
    const tenantId = await tenant();
    const t = await pending(tenantId, 1_500);
    await send(sessionEvent("checkout.session.completed", t));
    await b.worker().runOnce();
    const paidRow = await b.topupRow(tenantId, t.id);
    b.h.clock.advance(60_000);
    const after = [
      await send(sessionEvent("checkout.session.async_payment_failed", t)),
      await send(sessionEvent("checkout.session.expired", t)),
      await send(sessionEvent("checkout.session.completed", t, { amount: 1 })),
      await send(sessionEvent("checkout.session.completed", t, { currency: "eur" })),
      await send(sessionEvent("checkout.session.completed", t, { paymentStatus: "unpaid" })),
    ];
    await b.worker().runOnce();
    expect(await Promise.all(after.map(outcome))).toEqual(["ignored", "ignored", "already_credited", "already_credited", "ignored"]);
    expect(await b.topupRow(tenantId, t.id)).toEqual(paidRow);
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_500, reserved: 0, owed: 0 });
  });

  it("unknown event types end ignored", async () => {
    const id = await send(b.event("customer.created", { id: stripeId("cus"), object: "customer" }));
    await b.worker().runOnce();
    expect(await b.eventRow(id)).toMatchObject({ outcome: "ignored", attempts: 1 });
  });
});

describe("out of order (S-4)", () => {
  it("a refund before its payment waits with backoff, then applies on a later pass once due", async () => {
    const tenantId = await tenant();
    const t = await pending(tenantId, 2_000);
    const config = { backoffBaseMs: 30_000, backoffMaxMs: 3_600_000, maxAttempts: 12 };
    const refund = await send(b.event("charge.refunded", b.charge(t, 500)));
    const pass1 = b.h.clock.now().getTime();
    await b.worker(config).runOnce();
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 1, processed_at: null, outcome: null });
    expect((await b.eventRow(refund)).next_attempt_at.getTime()).toBe(pass1 + 30_000);

    b.h.clock.advance(30_000);
    await b.worker(config).runOnce();
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 2, processed_at: null });
    expect((await b.eventRow(refund)).next_attempt_at.getTime()).toBe(pass1 + 30_000 + 60_000);

    // The payment arrives; the refund is not due yet, so this pass only credits.
    b.h.clock.advance(1_000);
    const paid = await send(sessionEvent("checkout.session.completed", t));
    await b.worker(config).runOnce();
    expect(await outcome(paid)).toBe("credited");
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 2, processed_at: null });
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_000, reserved: 0, owed: 0 });

    b.h.clock.advance(58_999);
    await b.worker(config).runOnce();
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 2, processed_at: null });
    b.h.clock.advance(1);
    await b.worker(config).runOnce();
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 3, outcome: "refund_debited" });
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_500, reserved: 0, owed: 0 });
    expect((await b.topupRow(tenantId, t.id)).refunded).toBe("500");
  });

  it("an event whose top-up never appears ends orphaned after maxAttempts, with capped backoff", async () => {
    const config = { maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 1_500 };
    const ghost = { tenantId: randomUUID(), id: randomUUID(), amount: 700, sessionId: stripeId("cs"), paymentIntent: stripeId("pi"), chargeId: stripeId("ch") };
    const refund = await send(b.event("charge.refunded", b.charge(ghost, 700)));
    const dispute = await send(b.event("charge.dispute.funds_withdrawn", b.dispute(ghost, stripeId("dp"), 700, "lost")));
    await b.worker(config).runOnce();
    const first = b.h.clock.now().getTime();
    for (const id of [refund, dispute]) {
      expect(await b.eventRow(id)).toMatchObject({ attempts: 1, processed_at: null });
      expect((await b.eventRow(id)).next_attempt_at.getTime()).toBe(first + 1_000);
    }
    b.h.clock.advance(1_000);
    await b.worker(config).runOnce();
    expect((await b.eventRow(refund)).next_attempt_at.getTime()).toBe(first + 1_000 + 1_500);
    b.h.clock.advance(1_499);
    await b.worker(config).runOnce();
    expect(await b.eventRow(refund)).toMatchObject({ attempts: 2, processed_at: null });
    b.h.clock.advance(1);
    await b.worker(config).runOnce();
    for (const id of [refund, dispute]) expect(await b.eventRow(id)).toMatchObject({ attempts: 3, outcome: "orphaned", processed_at: b.h.clock.now() });
    b.h.clock.advance(60 * 60_000);
    expect((await b.worker(config).runOnce()).claimed).toBe(0);
  });
});

describe("refunds (S-6)", () => {
  it("debits the growth of the running total, ignores older totals, caps at the top-up and is replay safe", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 2_000);
    const step = async (total: number) => {
      const id = await send(b.event("charge.refunded", b.charge(t, total)));
      await b.worker().runOnce();
      b.h.clock.advance(1_000);
      return outcome(id);
    };
    expect(await step(300)).toBe("refund_debited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_700, reserved: 0, owed: 0 });
    expect(await step(800)).toBe("refund_debited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_200, reserved: 0, owed: 0 });
    // An older, smaller total arriving late, and a repeat of the current one, change nothing.
    expect(await step(300)).toBe("refund_seen");
    expect(await step(800)).toBe("refund_seen");
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_200, reserved: 0, owed: 0 });
    // A total above the top-up is capped at its amount.
    expect(await step(5_000)).toBe("refund_debited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    expect(await step(5_000)).toBe("refund_seen");
    expect(await step(2_000)).toBe("refund_seen");
    expect((await b.topupRow(tenantId, t.id)).refunded).toBe("2000");
    expect(await b.billingEvents(tenantId)).toEqual([
      { kind: "refund", reference: `${t.chargeId}:300`, amount: 300, applied: 300 },
      { kind: "refund", reference: `${t.chargeId}:800`, amount: 500, applied: 500 },
      { kind: "refund", reference: `${t.chargeId}:2000`, amount: 1_200, applied: 1_200 },
    ]);
    expect((await b.topupRow(tenantId, t.id)).status).toBe("paid");
  });

  it("two refund events for the same total processed in one pass debit once", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 1_000);
    const ids = [
      await send(b.event("charge.refunded", b.charge(t, 400))),
      await send(b.event("charge.refunded", b.charge(t, 400))),
    ];
    await b.worker().runOnce();
    // Same receipt time: either may go first, exactly one debits.
    expect((await Promise.all(ids.map(outcome))).sort()).toEqual(["refund_debited", "refund_seen"]);
    expect(await b.wallet(tenantId)).toEqual({ balance: 600, reserved: 0, owed: 0 });
  });
});

describe("disputes (S-6)", () => {
  it("funds_withdrawn debits once and funds_reinstated credits back once", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 2_500);
    const disputeId = stripeId("dp");
    const withdrawn = [
      await send(b.event("charge.dispute.funds_withdrawn", b.dispute(t, disputeId, 2_500, "needs_response"))),
      await send(b.event("charge.dispute.funds_withdrawn", b.dispute(t, disputeId, 2_500, "under_review"))),
    ];
    await b.worker().runOnce();
    expect((await Promise.all(withdrawn.map(outcome))).sort()).toEqual(["dispute_debited", "dispute_seen"]);
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    b.h.clock.advance(7 * 24 * 60 * 60_000);
    const reinstated = [
      await send(b.event("charge.dispute.funds_reinstated", b.dispute(t, disputeId, 2_500, "won"))),
      await send(b.event("charge.dispute.funds_reinstated", b.dispute(t, disputeId, 2_500, "won"))),
    ];
    await b.worker().runOnce();
    expect((await Promise.all(reinstated.map(outcome))).sort()).toEqual(["dispute_reinstated", "dispute_seen"]);
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_500, reserved: 0, owed: 0 });
    expect(await b.billingEvents(tenantId)).toEqual([
      { kind: "dispute_withdrawn", reference: disputeId, amount: 2_500, applied: 2_500 },
      { kind: "dispute_reinstated", reference: disputeId, amount: 2_500, applied: 2_500 },
    ]);
  });

  it("a reinstatement that arrives before its withdrawal waits for it", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 1_000);
    const disputeId = stripeId("dp");
    const config = { backoffBaseMs: 10_000 };
    const reinstated = await send(b.event("charge.dispute.funds_reinstated", b.dispute(t, disputeId, 600, "won")));
    b.h.clock.advance(1);
    const withdrawn = await send(b.event("charge.dispute.funds_withdrawn", b.dispute(t, disputeId, 600, "under_review")));
    await b.worker(config).runOnce();
    expect(await b.eventRow(reinstated)).toMatchObject({ attempts: 1, processed_at: null });
    expect(await outcome(withdrawn)).toBe("dispute_debited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 400, reserved: 0, owed: 0 });
    b.h.clock.advance(10_000);
    await b.worker(config).runOnce();
    expect(await b.eventRow(reinstated)).toMatchObject({ attempts: 2, outcome: "dispute_reinstated" });
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_000, reserved: 0, owed: 0 });
  });
});

describe("never negative (S-6)", () => {
  it("a refund above what is available keeps reservations covered and records the rest as owed", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 1_000);
    const [held, spare] = await b.deliveryIds(tenantId, 2);
    const hold = await reserve(tenantId, held!, 700);
    expect(hold).not.toBeNull();
    const refund = await send(b.event("charge.refunded", b.charge(t, 1_000)));
    await b.worker().runOnce();
    expect(await outcome(refund)).toBe("refund_debited");
    expect(await b.wallet(tenantId)).toEqual({ balance: 700, reserved: 700, owed: 700 });
    expect(await b.billingEvents(tenantId)).toEqual([{ kind: "refund", reference: `${t.chargeId}:1000`, amount: 1_000, applied: 300 }]);
    await b.expectConsistent(tenantId);

    // Released money is available again, but a wallet that owes reserves nothing.
    await b.h.service((tx) => releaseReservation(tx, { tenantId, reservationId: hold!.id, now: b.h.clock.now() }));
    expect(await b.wallet(tenantId)).toEqual({ balance: 700, reserved: 0, owed: 700 });
    expect(await reserve(tenantId, spare!, 1)).toBeNull();
    expect(await b.wallet(tenantId)).toEqual({ balance: 700, reserved: 0, owed: 700 });

    // The next worker pass, with no events at all, repays the debt.
    b.h.clock.advance(1_000);
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    const repay = await b.h.rows<{ amount: string; note: string }>(
      "SELECT amount, note FROM wallet_ledger WHERE tenant_id=$1 AND note='repay owed'", [tenantId]);
    expect(repay).toEqual([{ amount: "-700", note: "repay owed" }]);
  });

  it("a later top-up repays what is owed first; reservations are allowed again once owed is zero", async () => {
    const tenantId = await tenant();
    const first = await b.paidTopUp(tenantId, 500);
    const [held, next] = await b.deliveryIds(tenantId, 2);
    expect(await reserve(tenantId, held!, 400)).not.toBeNull();
    const disputeId = stripeId("dp");
    await send(b.event("charge.dispute.funds_withdrawn", b.dispute(first, disputeId, 500, "needs_response")));
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 400, reserved: 400, owed: 400 });
    await b.expectConsistent(tenantId);

    b.h.clock.advance(60_000);
    await b.paidTopUp(tenantId, 600);
    expect(await b.wallet(tenantId)).toEqual({ balance: 600, reserved: 400, owed: 0 });
    expect(await reserve(tenantId, next!, 200)).not.toBeNull();
    expect(await b.wallet(tenantId)).toEqual({ balance: 600, reserved: 600, owed: 0 });
  });

  it("a reinstatement after a partly owed withdrawal clears the debt and restores the balance", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 1_000);
    const [held] = await b.deliveryIds(tenantId, 1);
    expect(await reserve(tenantId, held!, 800)).not.toBeNull();
    const disputeId = stripeId("dp");
    await send(b.event("charge.dispute.funds_withdrawn", b.dispute(t, disputeId, 1_000, "needs_response")));
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 800, reserved: 800, owed: 800 });
    await b.expectConsistent(tenantId);
    b.h.clock.advance(60_000);
    await send(b.event("charge.dispute.funds_reinstated", b.dispute(t, disputeId, 1_000, "won")));
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 1_000, reserved: 800, owed: 0 });
    expect(await b.billingEvents(tenantId)).toEqual([
      { kind: "dispute_withdrawn", reference: disputeId, amount: 1_000, applied: 200 },
      { kind: "dispute_reinstated", reference: disputeId, amount: 1_000, applied: 1_000 },
    ]);
  });

  it("a top-up smaller than the debt repays part of it and leaves the rest owed", async () => {
    const tenantId = await tenant();
    const first = await b.paidTopUp(tenantId, 2_000);
    const [held] = await b.deliveryIds(tenantId, 1);
    expect(await reserve(tenantId, held!, 2_000)).not.toBeNull();
    await send(b.event("charge.refunded", b.charge(first, 2_000)));
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_000, reserved: 2_000, owed: 2_000 });
    await b.paidTopUp(tenantId, 500);
    expect(await b.wallet(tenantId)).toEqual({ balance: 2_000, reserved: 2_000, owed: 1_500 });
    expect(await b.billingEvents(tenantId)).toEqual([{ kind: "refund", reference: `${first.chargeId}:2000`, amount: 2_000, applied: 0 }]);
  });
});

describe("tenancy and concurrency", () => {
  it("events for tenant A never touch tenant B's wallet", async () => {
    const tenantA = await tenant();
    const tenantB = await tenant();
    const paidB = await b.paidTopUp(tenantB, 900);
    const ledgerB = await b.ledgerSum(tenantB);
    const a = await pending(tenantA, 1_100);
    await send(sessionEvent("checkout.session.completed", a));
    await b.worker().runOnce();
    const paidA = { ...a };
    await send(b.event("charge.refunded", b.charge(paidA, 1_100)));
    await send(b.event("charge.dispute.funds_withdrawn", b.dispute(paidA, stripeId("dp"), 1_100, "lost")));
    await b.worker().runOnce();
    expect(await b.wallet(tenantA)).toEqual({ balance: 0, reserved: 0, owed: 1_100 });
    expect(await b.wallet(tenantB)).toEqual({ balance: 900, reserved: 0, owed: 0 });
    expect(await b.ledgerSum(tenantB)).toBe(ledgerB);
    expect(await b.billingEvents(tenantB)).toEqual([]);
    expect((await b.topupRow(tenantB, paidB.id)).refunded).toBe("0");
  });

  it("parallel worker passes over the same events claim each once and credit each top-up once", async () => {
    const tenantId = await tenant();
    const topups = [];
    const events: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t = await pending(tenantId, 1_000 + i * 100);
      topups.push(t);
      events.push(await send(sessionEvent("checkout.session.completed", t)));
      events.push(await send(sessionEvent("checkout.session.async_payment_succeeded", t)));
    }
    const passes = await Promise.all([b.worker().runOnce(), b.worker().runOnce(), b.worker().runOnce()]);
    expect(passes.reduce((sum, pass) => sum + pass.claimed, 0)).toBe(events.length);
    const rows = await b.h.rows<{ attempts: number; outcome: string }>(
      "SELECT attempts, outcome FROM stripe_events WHERE id = ANY($1)", [events]);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.filter((row) => row.outcome === "credited")).toHaveLength(6);
    expect(rows.filter((row) => row.outcome === "already_credited")).toHaveLength(6);
    const total = topups.reduce((sum, t) => sum + t.amount, 0);
    expect(await b.wallet(tenantId)).toEqual({ balance: total, reserved: 0, owed: 0 });
    expect(await creditKeys(tenantId)).toHaveLength(6);
  });

  it("a wallet another transaction holds does not stop the pass: the credits commit and the other wallets are repaid", async () => {
    /** A wallet that owes 700 while 700 stays reserved, as the refund test above leaves it. */
    const owing = async () => {
      const tenantId = await tenant();
      const t = await b.paidTopUp(tenantId, 1_000);
      const [held] = await b.deliveryIds(tenantId, 1);
      const hold = await reserve(tenantId, held!, 700);
      await send(b.event("charge.refunded", b.charge(t, 1_000)));
      await b.worker().runOnce();
      return { tenantId, reservationId: hold!.id };
    };
    const owingWallets = [await owing(), await owing()];
    // The reservations come back, so both wallets can repay on the next pass.
    for (const { tenantId, reservationId } of owingWallets) {
      await b.h.service((tx) => releaseReservation(tx, { tenantId, reservationId, now: b.h.clock.now() }));
      expect(await b.wallet(tenantId)).toEqual({ balance: 700, reserved: 0, owed: 700 });
    }
    const [locked, free] = owingWallets.map((wallet) => wallet.tenantId) as [string, string];
    const payer = await tenant();
    const { topup, sessionId } = await b.startTopUp(payer, 900);
    const credit = await send(b.event("checkout.session.completed",
      b.checkoutSession({ tenantId: payer, topupId: topup.id, sessionId, amount: 900, paymentIntent: stripeId("pi") })));
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const holder = b.h.service(async (tx) => {
      await tx.query("SELECT 1 FROM wallets WHERE tenant_id=$1 FOR UPDATE", [locked]);
      holding();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await held;
    b.h.clock.advance(1_000);
    await b.worker().runOnce();
    release();
    await holder;
    expect(await outcome(credit)).toBe("credited");
    expect(await b.wallet(payer)).toEqual({ balance: 900, reserved: 0, owed: 0 });
    expect(await b.wallet(free)).toEqual({ balance: 0, reserved: 0, owed: 0 });
    expect(await b.wallet(locked)).toEqual({ balance: 700, reserved: 0, owed: 700 });
    // Once free, the next pass repays it.
    await b.worker().runOnce();
    expect(await b.wallet(locked)).toEqual({ balance: 0, reserved: 0, owed: 0 });
  });

  it("the repay sweep stops at the deadline and keeps the repayments it made", async () => {
    /** A wallet that owes 700 with nothing reserved, so the next sweep can repay it. */
    const owing = async () => {
      const tenantId = await tenant();
      const t = await b.paidTopUp(tenantId, 1_000);
      const [held] = await b.deliveryIds(tenantId, 1);
      const hold = await reserve(tenantId, held!, 700);
      await send(b.event("charge.refunded", b.charge(t, 1_000)));
      await b.worker().runOnce();
      return { tenantId, reservationId: hold!.id };
    };
    const wallets = [await owing(), await owing(), await owing(), await owing()];
    for (const { tenantId, reservationId } of wallets)
      await b.h.service((tx) => releaseReservation(tx, { tenantId, reservationId, now: b.h.clock.now() }));
    const mine = new Set(wallets.map((wallet) => wallet.tenantId));
    // Each of these repays takes 4 seconds; the deadline falls during the third.
    const slow = createBillingWorker({
      service: b.h.service, clock: b.h.clock, generateId: randomUUID,
      report: (event) => { if (event.type === "wallet.repay" && mine.has(event.eventId.slice("repay:".length))) b.h.clock.advance(4_000); },
    });
    await slow.runOnce(50, { deadline: new Date(b.h.clock.now().getTime() + 10_000) });
    const states = await Promise.all(wallets.map(({ tenantId }) => b.wallet(tenantId)));
    expect(states.filter((state) => state.owed === 0)).toHaveLength(3);
    expect(states.filter((state) => state.owed === 700)).toEqual([{ balance: 700, reserved: 0, owed: 700 }]);
    // The next pass repays the last one.
    await b.worker().runOnce();
    expect(await Promise.all(wallets.map(({ tenantId }) => b.wallet(tenantId))))
      .toEqual(wallets.map(() => ({ balance: 0, reserved: 0, owed: 0 })));
  });

  it("a pass stops claiming at its deadline and keeps what it applied", async () => {
    const tenantId = await tenant();
    const events: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { topup, sessionId } = await b.startTopUp(tenantId, 1_000 + i * 100);
      events.push(await send(b.event("checkout.session.completed",
        b.checkoutSession({ tenantId, topupId: topup.id, sessionId, amount: 1_000 + i * 100, paymentIntent: stripeId("pi") }))));
    }
    // A deadline already passed claims nothing.
    expect(await b.worker().runOnce(50, { deadline: b.h.clock.now() })).toEqual({ claimed: 0, outcomes: {} });
    // Each event takes 4 seconds; the deadline falls during the third.
    const slow = createBillingWorker({
      service: b.h.service, clock: b.h.clock, generateId: randomUUID, report: () => b.h.clock.advance(4_000),
    });
    const pass = await slow.runOnce(50, { deadline: new Date(b.h.clock.now().getTime() + 10_000) });
    expect(pass).toEqual({ claimed: 3, outcomes: { credited: 3 } });
    expect((await Promise.all(events.map(outcome))).filter((value) => value === "credited")).toHaveLength(3);
    expect(await b.worker().runOnce()).toEqual({ claimed: 1, outcomes: { credited: 1 } });
  });

  it("parallel passes over refunds and disputes of one top-up debit each once", async () => {
    const tenantId = await tenant();
    const t = await b.paidTopUp(tenantId, 3_000);
    const disputeId = stripeId("dp");
    for (const total of [500, 500, 1_000, 1_000])
      await send(b.event("charge.refunded", b.charge(t, total)));
    for (let i = 0; i < 3; i += 1)
      await send(b.event("charge.dispute.funds_withdrawn", b.dispute(t, disputeId, 1_500, "needs_response")));
    await Promise.all([b.worker().runOnce(5), b.worker().runOnce(5), b.worker().runOnce(5)]);
    await b.worker().runOnce();
    expect(await b.wallet(tenantId)).toEqual({ balance: 500, reserved: 0, owed: 0 });
    // Refund events share a receipt time, so the running totals may apply as 500 then 1000, or 1000 alone.
    const recorded = await b.billingEvents(tenantId);
    expect(recorded.filter((row) => row.kind === "refund").reduce((sum, row) => sum + row.amount, 0)).toBe(1_000);
    expect(recorded.filter((row) => row.kind === "dispute_withdrawn")).toEqual([
      { kind: "dispute_withdrawn", reference: disputeId, amount: 1_500, applied: 1_500 }]);
    expect((await b.topupRow(tenantId, t.id)).refunded).toBe("1000");
  });
});
