// M5 billing test harness (stripe.md S-1..S-7): the delivery harness (real local Postgres,
// manual clock, two tenants) plus owners, a stub Stripe client, Stripe-shaped event builders
// and wallet checks. All data is synthetic.
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { MemberRole } from "@zs/contracts";
import { createSession, type EdgeDependencies, type Session } from "../../src/edge/session.js";
import {
  createBillingWorker,
  recordStripeEvent,
  stripeConfigSchema,
  stripeEventSchema,
  type BillingWorkerConfig,
  type CheckoutSessionRequest,
  type StripeClient,
} from "../../src/index.js";
import { createDeliveryHarness, type DeliveryHarness } from "../delivery/helpers.js";

/** Stripe-looking IDs; random so tests never share one. */
export const stripeId = (prefix: string) => `${prefix}_test_${randomBytes(12).toString("hex")}`;

/** A Checkout stub: one session per top-up, every request kept for inspection. */
export function stubStripe(overrides: { minTopUp?: number; maxTopUp?: number } = {}) {
  const calls: CheckoutSessionRequest[] = [];
  const sessions = new Map<string, string>();
  const client: StripeClient = {
    // Synthetic key, assembled at runtime so no literal looks like a secret.
    config: stripeConfigSchema.parse({
      secretKey: ["sk", "test", "x".repeat(24)].join("_"),
      successUrl: "https://app.haldenrowe.example/wallet/paid",
      cancelUrl: "https://app.haldenrowe.example/wallet",
      minTopUp: overrides.minTopUp ?? 500,
      maxTopUp: overrides.maxTopUp ?? 50_000,
    }),
    async createCheckoutSession(request) {
      calls.push(request);
      let id = sessions.get(request.topupId);
      if (!id) {
        id = stripeId("cs");
        sessions.set(request.topupId, id);
      }
      return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
    },
  };
  return { client, calls, sessionFor: (topupId: string) => sessions.get(topupId)! };
}
export type StubStripe = ReturnType<typeof stubStripe>;

export interface PaidTopUp {
  tenantId: string;
  id: string;
  amount: number;
  sessionId: string;
  paymentIntent: string;
  chargeId: string;
}

export interface WalletState { balance: number; reserved: number; owed: number }

export async function createBillingHarness() {
  const h: DeliveryHarness = await createDeliveryHarness();
  const stripe = stubStripe();
  const owners = new Map<string, string>();
  const deps = (billing = true): EdgeDependencies => ({
    db: h.database.db, clock: h.clock, generateId: randomUUID, ...(billing ? { billing: { stripe: stripe.client } } : {}),
  });

  async function addMember(tenantId: string, role: MemberRole): Promise<string> {
    const userId = randomUUID();
    const memberId = randomUUID();
    await h.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [tenantId, memberId, `${role}-${memberId.slice(0, 8)}@haldenrowe.example`, userId, role, h.clock.now()]));
    return userId;
  }
  async function owner(tenantId: string): Promise<string> {
    let userId = owners.get(tenantId);
    if (!userId) {
      userId = await addMember(tenantId, "owner");
      owners.set(tenantId, userId);
    }
    return userId;
  }
  async function session(tenantId: string, options: { billing?: boolean; role?: MemberRole } = {}): Promise<Session> {
    const actorId = options.role === "staff" ? await addMember(tenantId, "staff") : await owner(tenantId);
    return createSession(deps(options.billing ?? true), { tenantId, actorId });
  }

  /** A fresh tenant with an owner, so wallet state starts empty. */
  async function tenant(): Promise<string> {
    const tenantId = await h.tenant();
    await owner(tenantId);
    return tenantId;
  }

  /** S-1: a pending top-up started by the tenant's owner through the session. */
  async function startTopUp(tenantId: string, amount: number) {
    const started = await (await session(tenantId)).createTopUp({ amount }, `topup-${randomUUID()}`);
    return { ...started, sessionId: stripe.sessionFor(started.topup.id) };
  }

  /** Stores one event exactly as the webhook would. */
  async function deliver(payload: Record<string, unknown>) {
    const event = stripeEventSchema.parse(payload);
    return recordStripeEvent(h.database.db, { event, payload, now: h.clock.now() });
  }

  function event(type: string, object: Record<string, unknown>, id = stripeId("evt")) {
    return {
      id, object: "event", api_version: "2026-09-30.acacia", type, livemode: false,
      created: Math.floor(h.clock.now().getTime() / 1000), pending_webhooks: 1,
      data: { object },
    };
  }
  function checkoutSession(input: {
    tenantId: string; topupId: string; sessionId: string; amount: number; paymentIntent: string | null;
    paymentStatus?: "paid" | "unpaid" | "no_payment_required"; currency?: string; status?: string;
  }) {
    return {
      id: input.sessionId, object: "checkout.session", mode: "payment", status: input.status ?? "complete",
      payment_status: input.paymentStatus ?? "paid", amount_total: input.amount, amount_subtotal: input.amount,
      currency: input.currency ?? "usd", payment_intent: input.paymentIntent, client_reference_id: input.topupId,
      livemode: false, metadata: { zs_tenant: input.tenantId, zs_topup: input.topupId },
    };
  }
  const charge = (topup: PaidTopUp, amountRefunded: number) => ({
    id: topup.chargeId, object: "charge", amount: topup.amount, amount_captured: topup.amount, amount_refunded: amountRefunded,
    currency: "usd", paid: true, refunded: amountRefunded >= topup.amount, payment_intent: topup.paymentIntent, livemode: false,
  });
  const dispute = (topup: PaidTopUp, disputeId: string, amount: number, status: string) => ({
    id: disputeId, object: "dispute", amount, currency: "usd", charge: topup.chargeId, payment_intent: topup.paymentIntent,
    reason: "fraudulent", status, livemode: false,
  });

  function worker(config: BillingWorkerConfig = {}) {
    return createBillingWorker({ service: h.service, clock: h.clock, generateId: randomUUID, config });
  }

  /** A top-up started, completed and processed: the wallet holds `amount` more. */
  async function paidTopUp(tenantId: string, amount: number): Promise<PaidTopUp> {
    const { topup, sessionId } = await startTopUp(tenantId, amount);
    const paymentIntent = stripeId("pi");
    await deliver(event("checkout.session.completed",
      checkoutSession({ tenantId, topupId: topup.id, sessionId, amount, paymentIntent })));
    await worker().runOnce();
    const row = await topupRow(tenantId, topup.id);
    expect(row.status).toBe("paid");
    return { tenantId, id: topup.id, amount, sessionId, paymentIntent, chargeId: stripeId("ch") };
  }

  async function wallet(tenantId: string): Promise<WalletState> {
    const row = (await h.rows<{ balance: string; reserved: string; owed: string }>(
      "SELECT balance, reserved, owed FROM wallets WHERE tenant_id=$1", [tenantId]))[0];
    return { balance: Number(row?.balance ?? 0), reserved: Number(row?.reserved ?? 0), owed: Number(row?.owed ?? 0) };
  }
  async function ledgerSum(tenantId: string): Promise<number> {
    return Number((await h.rows<{ sum: string | null }>(
      "SELECT sum(amount)::text AS sum FROM wallet_ledger WHERE tenant_id=$1", [tenantId]))[0]!.sum ?? 0);
  }
  /** The balance is the ledger's sum, never negative, and covers every reservation. */
  async function expectConsistent(tenantId: string): Promise<WalletState> {
    const state = await wallet(tenantId);
    expect(state.balance).toBe(await ledgerSum(tenantId));
    expect(state.balance).toBeGreaterThanOrEqual(0);
    expect(state.owed).toBeGreaterThanOrEqual(0);
    expect(state.reserved).toBeLessThanOrEqual(state.balance);
    const held = Number((await h.rows<{ sum: string | null }>(
      "SELECT sum(amount)::text AS sum FROM wallet_reservations WHERE tenant_id=$1 AND status='held'", [tenantId]))[0]!.sum ?? 0);
    expect(state.reserved).toBe(held);
    return state;
  }
  async function topupRow(tenantId: string, topupId: string) {
    return (await h.rows<Record<string, any>>("SELECT * FROM wallet_topups WHERE tenant_id=$1 AND id=$2", [tenantId, topupId]))[0]!;
  }
  async function eventRow(eventId: string) {
    return (await h.rows<Record<string, any>>("SELECT * FROM stripe_events WHERE id=$1", [eventId]))[0]!;
  }
  async function billingEvents(tenantId: string) {
    return h.rows<Record<string, any>>(
      "SELECT kind::text AS kind, reference, amount::int AS amount, applied::int AS applied FROM wallet_billing_events WHERE tenant_id=$1 ORDER BY created_at, kind",
      [tenantId]);
  }
  /** Delivery rows to hang reservations on (reservations reference a delivery). */
  async function deliveryIds(tenantId: string, n: number): Promise<string[]> {
    const contactId = await h.contact(tenantId);
    for (let i = 0; i < n; i += 1) await h.enqueue(tenantId, { contactId });
    await h.worker().ingest();
    return (await h.rows<{ id: string }>("SELECT id FROM message_deliveries WHERE tenant_id=$1 ORDER BY id", [tenantId])).map((row) => row.id);
  }
  /** Ends every event a test left unprocessed, so the next test's passes see only its own. */
  async function settle() {
    await h.service((tx) => tx.query(
      "UPDATE stripe_events SET processed_at=$1, outcome='test_reset' WHERE processed_at IS NULL", [h.clock.now()]));
    await h.reset();
  }

  return {
    h, stripe, deps, session, owner, tenant, startTopUp, deliver, event, checkoutSession, charge, dispute, worker, paidTopUp,
    wallet, ledgerSum, expectConsistent, topupRow, eventRow, billingEvents, deliveryIds, settle,
    close: () => h.close(),
  };
}
export type BillingHarness = Awaited<ReturnType<typeof createBillingHarness>>;
