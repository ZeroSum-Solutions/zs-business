// M3d delivery worker (delivery.md D-1..D-8) against a real Postgres, as the service role.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MESSAGE_SEND_REQUESTED } from "@zs/contracts";
import { createFakeProvider, verifyUnsubscribeToken, type DeliveryReport } from "../../src/index.js";
import { createDeliveryHarness, PRICES, UNSUBSCRIBE_SECRET, type DeliveryHarness } from "./helpers.js";

let h: DeliveryHarness;
let tenant: string;
beforeAll(async () => { h = await createDeliveryHarness(); });
beforeEach(async () => { tenant = await h.tenant(); });
afterEach(async () => { await h.reset(); });
afterAll(async () => { await h?.close(); });

const captures = async (tenantId: string) =>
  (await h.rows("SELECT amount FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantId])).length;

describe("ingest (D-1, D-2)", () => {
  it("turns one send event into one delivery and marks the outbox row processed", async () => {
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const result = await h.worker().ingest();
    expect(result).toMatchObject({ ingested: 1, duplicates: 0, invalid: 0 });
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "pending", channel: "email", attempts: 0, outcome_unknown: false });
    expect(delivery.idempotency_key).toBe(`zsd-${delivery.id}`);
    const outbox = await h.rows("SELECT processed_at FROM outbox WHERE tenant_id=$1 AND id=$2", [tenant, delivery.outbox_id]);
    expect(outbox[0]!.processed_at).toEqual(h.clock.now());
    // Nothing left to ingest.
    expect(await h.worker().ingest()).toMatchObject({ ingested: 0 });
  });

  it("keeps one delivery when a producer asks twice for the same message", async () => {
    const contactId = await h.contact(tenant);
    const messageId = randomUUID();
    await h.enqueue(tenant, { contactId, messageId });
    await h.enqueue(tenant, { contactId, messageId, body: "A second request for the same message." });
    expect(await h.worker().ingest()).toMatchObject({ ingested: 1, duplicates: 1 });
    expect(await h.rows("SELECT id FROM message_deliveries WHERE tenant_id=$1 AND message_id=$2", [tenant, messageId])).toHaveLength(1);
  });

  it("reports a malformed event, marks it processed and keeps the outbox row as the record", async () => {
    const contactId = await h.contact(tenant);
    await h.enqueue(tenant, { contactId, raw: { messageId: randomUUID(), channel: "fax" } });
    const reports: DeliveryReport[] = [];
    const worker = h.worker();
    const withReport = (await import("../../src/index.js")).createDeliveryWorker({
      service: h.service, providers: { email: h.provider, sms: h.provider }, approvals: h.approvals.port,
      clock: h.clock, generateId: randomUUID, config: worker.config, report: (event) => reports.push(event),
    });
    expect(await withReport.ingest()).toMatchObject({ invalid: 1, ingested: 0 });
    expect(reports).toEqual([expect.objectContaining({ kind: "invalid_event", tenantId: tenant })]);
    const left = await h.rows("SELECT count(*)::int AS n FROM outbox WHERE event_type=$1 AND processed_at IS NULL", [MESSAGE_SEND_REQUESTED]);
    expect(left[0]!.n).toBe(0);
  });
});

describe("send, settle and retry (D-5, D-7)", () => {
  it("sends an approved email once, with the one-click unsubscribe headers, and captures its price", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const sentBefore = h.provider.delivered.length;
    const run = await h.worker().runOnce();
    expect(run.results).toContainEqual({ outcome: "sent", providerMessageId: expect.stringMatching(/^fake-/) });
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", outcome_unknown: false, attempts: 1, lease_token: null });
    const sent = h.provider.delivered.slice(sentBefore).find((item) => item.request.deliveryId === delivery.id)!;
    expect(sent.request.to).toBe(delivery.recipient_address);
    expect(sent.request.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = sent.request.headers["List-Unsubscribe"]!.slice(1, -1);
    expect(sent.request.text).toContain(url);
    expect(verifyUnsubscribeToken({ current: UNSUBSCRIBE_SECRET }, url.split("/").at(-1)!))
      .toEqual({ tenantId: tenant, deliveryId: delivery.id });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    const reservations = await h.rows("SELECT status, amount FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2", [tenant, delivery.id]);
    expect(reservations).toEqual([{ status: "captured", amount: String(PRICES.email) }]);
    const attempts = await h.rows("SELECT attempt, kind, outcome FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2", [tenant, delivery.id]);
    expect(attempts).toEqual([{ attempt: 1, kind: "send", outcome: "accepted" }]);
  });

  it("prices an SMS by segment and appends the opt-out line", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant, { phone: "+15555550101", consent: { sms: "granted" } });
    const { messageId } = await h.enqueue(tenant, { contactId, channel: "sms", body: "x".repeat(150) });
    await h.worker().runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery.status).toBe("sent");
    const sent = h.provider.delivered.find((item) => item.request.deliveryId === delivery.id)!;
    expect(sent.request).toMatchObject({ to: "+15555550101", subject: null, headers: {} });
    expect(sent.request.text.endsWith("\nReply STOP to opt out.")).toBe(true);
    // 150 + 23 GSM characters: two segments.
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - 2 * PRICES.smsSegment, reserved: before.reserved });
  });

  it("releases the money on a definite failure, backs off, and charges once when a retry succeeds", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = h.worker();
    h.provider.queue("fail");
    await worker.runOnce();
    let delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, outcome_unknown: false, last_error: "fake_rate_limited" });
    expect(delivery.next_attempt_at).toEqual(new Date(h.clock.now().getTime() + 1_000));
    expect(await h.wallet(tenant)).toEqual(before);
    // Not due yet.
    expect((await worker.runOnce()).claimed).toBe(0);
    h.clock.advance(1_000);
    await worker.runOnce();
    delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", attempts: 2 });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    const reservations = await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY created_at, status", [tenant, delivery.id]);
    expect(reservations.map((row) => row.status).sort()).toEqual(["captured", "released"]);
  });

  it("dead-letters a permanent rejection and returns the money", async () => {
    await h.credit(tenant, 10);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    h.provider.queue("reject");
    await h.worker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "provider_rejected", outcome_unknown: false });
    expect(await h.wallet(tenant)).toEqual(before);
  });

  it("dead-letters after the attempt cap", async () => {
    await h.credit(tenant, 10);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = h.worker({ maxAttempts: 2 });
    h.provider.queue("fail", "fail");
    await worker.runOnce();
    h.clock.advance(60_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "max_attempts", attempts: 2 });
  });

  it("waits for funds without sending, then dead-letters insufficient_funds", async () => {
    const poor = tenant;
    const contactId = await h.contact(poor);
    const { messageId } = await h.enqueue(poor, { contactId });
    const worker = h.worker({ maxAttempts: 2 });
    const calls = h.provider.calls.length;
    await worker.runOnce();
    expect(await h.delivery(poor, messageId)).toMatchObject({ status: "pending", last_error: "insufficient_funds", attempts: 1 });
    h.clock.advance(60_000);
    await worker.runOnce();
    expect(await h.delivery(poor, messageId)).toMatchObject({ status: "dead", final_reason: "insufficient_funds" });
    expect(h.provider.calls.length).toBe(calls);
  });
});

describe("producer settlement hook", () => {
  it("tells the producer sent or failed inside the settling transaction, and a failing hook rolls the settlement back", async () => {
    await h.credit(tenant, 50);
    const settled: [string, string][] = [];
    let fail = true;
    const base = h.worker();
    const worker = (await import("../../src/index.js")).createDeliveryWorker({
      service: h.service, providers: { email: h.provider, sms: h.provider }, approvals: h.approvals.port,
      clock: h.clock, generateId: randomUUID, config: { ...base.config, leaseMs: 60_000 },
      onSettled: async (tx, tenantId, messageId, outcome) => {
        // Runs in the same transaction: the delivery's new state is already visible here.
        const row = (await tx.query("SELECT status FROM message_deliveries WHERE tenant_id=$1 AND message_id=$2", [tenantId, messageId])).rows[0];
        if (fail) { fail = false; throw new Error("producer refused"); }
        settled.push([outcome, row.status]);
      },
    });
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    await expect(worker.runOnce()).rejects.toThrow("producer refused");
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "leased", outcome_unknown: true });
    h.clock.advance(60_001);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent" });
    expect(h.provider.delivered.filter((item) => item.request.tenantId === tenant)).toHaveLength(1);
    expect(await captures(tenant)).toBe(1);
    const blocked = await h.enqueue(tenant, { contactId, approve: false });
    await worker.runOnce();
    expect((await h.delivery(tenant, blocked.messageId)).status).toBe("blocked");
    expect(settled).toEqual([["sent", "sent"], ["failed", "blocked"]]);
  });
});

describe("crash and dedupe (D-3, D-7, D-8)", () => {
  it("a worker that stalls after the provider accepted loses its lease; the next holder's resend is dropped as a repeat and the price is captured once", async () => {
    await h.credit(tenant, 50);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const first = h.worker();
    await first.ingest();
    const [lease] = await first.claim(1);
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    // The provider accepts the message, then the reply never reaches the first worker in time.
    h.provider.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), then: "lose-reply", reached });
    const stalled = first.step(lease!);
    await arrived;
    const mid = await h.delivery(tenant, messageId);
    expect(mid).toMatchObject({ status: "leased", outcome_unknown: true, attempts: 1 });
    expect((await h.wallet(tenant)).reserved).toBe(before.reserved + PRICES.email);
    // The first worker's process is gone as far as the database knows: its lease runs out.
    h.clock.advance(60_001);
    const second = h.worker();
    const [taken] = await second.claim(10);
    expect(taken!.deliveryId).toBe(mid.id);
    // The second holder resends under the same key while the first is still inside the provider.
    const resend = second.step(taken!);
    release();
    expect(await resend).toMatchObject({ outcome: "sent" });
    expect(await stalled).toEqual({ outcome: "lost_lease" });
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", attempts: 2 });
    expect(h.provider.delivered.filter((item) => item.request.deliveryId === delivery.id)).toHaveLength(1);
    const keys = new Set(h.provider.calls.filter((call) => call.deliveryId === delivery.id).map((call) => call.idempotencyKey));
    expect(keys).toEqual(new Set([delivery.idempotency_key]));
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    expect(await h.rows("SELECT outcome, error_code FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt", [tenant, delivery.id]))
      .toEqual([{ outcome: "uncertain", error_code: "lease_lost" }, { outcome: "accepted", error_code: null }]);
  });

  it("holds the reservation through an uncertain reply and settles it once on the deduped resend", async () => {
    await h.credit(tenant, 50);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = h.worker();
    h.provider.queue("lose-reply");
    await worker.runOnce();
    const uncertain = await h.delivery(tenant, messageId);
    expect(uncertain).toMatchObject({ status: "uncertain", outcome_unknown: true });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    h.clock.advance(1_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent", outcome_unknown: false });
    expect(h.provider.delivered.filter((item) => item.request.deliveryId === uncertain.id)).toHaveLength(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
  });

  it("a thrown provider error counts as uncertain, not as a failure", async () => {
    await h.credit(tenant, 50);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    h.provider.queue("throw");
    await h.worker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "uncertain", outcome_unknown: true,
      last_error: "provider_error: fake provider connection reset" });
  });

  it("never resends after the dedupe window; it asks the provider instead", async () => {
    await h.credit(tenant, 50);
    const before = await h.wallet(tenant);
    const accepted = await h.contact(tenant);
    const missing = await h.contact(tenant);
    const worker = h.worker();
    const a = await h.enqueue(tenant, { contactId: accepted });
    h.provider.queue("lose-reply");
    await worker.runOnce();
    const b = await h.enqueue(tenant, { contactId: missing });
    h.provider.queue("timeout");
    await worker.runOnce();
    expect((await h.delivery(tenant, a.messageId)).status).toBe("uncertain");
    expect((await h.delivery(tenant, b.messageId)).status).toBe("uncertain");
    const calls = h.provider.calls.length;
    // Past first attempt + 24 h window - margin.
    h.clock.advance(24 * 60 * 60 * 1000);
    await worker.runOnce();
    expect(h.provider.calls.length).toBe(calls);
    expect(await h.delivery(tenant, a.messageId)).toMatchObject({ status: "sent", outcome_unknown: false });
    expect(await h.delivery(tenant, b.messageId)).toMatchObject({ status: "dead", final_reason: "dedupe_window_expired", outcome_unknown: false });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
  });

  it("without a provider answer, dead-letters outcome_unknown, keeps the money held, and lets an operator settle once", async () => {
    const clock = h.clock;
    const blind = createFakeProvider({ clock, lookup: false });
    await h.credit(tenant, 50);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = h.worker({}, blind);
    blind.queue("timeout");
    await worker.runOnce();
    clock.advance(24 * 60 * 60 * 1000);
    await worker.runOnce();
    const dead = await h.delivery(tenant, messageId);
    expect(dead).toMatchObject({ status: "dead", final_reason: "outcome_unknown", outcome_unknown: true });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    await worker.settleUnknown({ tenantId: tenant, deliveryId: dead.id, outcome: "not_sent" });
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "settled_not_sent", outcome_unknown: false });
    expect(await h.wallet(tenant)).toEqual(before);
    await expect(worker.settleUnknown({ tenantId: tenant, deliveryId: dead.id, outcome: "sent", providerMessageId: "x" }))
      .rejects.toMatchObject({ code: "Conflict" });
    expect(await h.wallet(tenant)).toEqual(before);
  });

  it("two workers claiming at once take disjoint deliveries and every message goes out once", async () => {
    const other = tenant;
    await h.credit(other, 1_000);
    const messages: string[] = [];
    for (let i = 0; i < 12; i += 1) messages.push((await h.enqueue(other, { contactId: await h.contact(other) })).messageId);
    const [w1, w2] = [h.worker(), h.worker()];
    await w1.ingest();
    const [c1, c2] = await Promise.all([w1.claim(8), w2.claim(8)]);
    const ids1 = c1.filter((c) => c.tenantId === other).map((c) => c.deliveryId);
    const ids2 = c2.filter((c) => c.tenantId === other).map((c) => c.deliveryId);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    await Promise.all([...c1.map((c) => w1.step(c)), ...c2.map((c) => w2.step(c))]);
    while ((await w1.runOnce()).claimed > 0) { /* drain the rest */ }
    for (const messageId of messages) expect((await h.delivery(other, messageId)).status).toBe("sent");
    const sentTo = h.provider.delivered.filter((item) => item.request.tenantId === other).map((item) => item.request.deliveryId);
    expect(new Set(sentTo).size).toBe(sentTo.length);
    expect(await captures(other)).toBe(12);
  });
});
