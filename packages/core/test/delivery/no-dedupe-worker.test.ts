// delivery.md D-8, revision 4: a provider that drops no repeats (Twilio, twilio.md T-2) never gets a
// second send after an unknown outcome. Real Postgres, service role, fake provider without dedupe.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, type DeliveryProvider, type ProviderLookupOutcome } from "../../src/index.js";
import { createDeliveryHarness, PRICES, type DeliveryHarness } from "./helpers.js";

const HOUR = 60 * 60 * 1000;
let h: DeliveryHarness;
let tenant: string;
beforeAll(async () => { h = await createDeliveryHarness(); });
beforeEach(async () => { tenant = await h.tenant(); });
afterEach(async () => { await h.reset(); });
afterAll(async () => { await h?.close(); });

const noDedupe = (lookup = true) => createFakeProvider({ clock: h.clock, dedupeWindowMs: 0, outcomeWaitMs: 6 * HOUR, lookup });
const smsContact = () => h.contact(tenant, { phone: `+1555555${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`, consent: { sms: "granted" } });
const sends = (provider: { calls: readonly { deliveryId: string }[] }, deliveryId: string) =>
  provider.calls.filter((call) => call.deliveryId === deliveryId).length;
const reservations = async (deliveryId: string) =>
  (await h.rows<{ status: string }>("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2", [tenant, deliveryId]))
    .map((row) => row.status).sort();

describe("unknown outcome without provider dedupe (D-8 rev 4)", () => {
  it("never resends a lost reply; the lookup proves the send and it is charged once", async () => {
    const provider = noDedupe();
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms", body: "See you at 3." });
    const worker = h.worker({}, provider);
    provider.queue("lose-reply");
    await worker.runOnce();
    const uncertain = await h.delivery(tenant, messageId);
    expect(uncertain).toMatchObject({ status: "uncertain", outcome_unknown: true });
    h.clock.advance(1_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent", outcome_unknown: false, provider_message_id: "fake-1" });
    expect(sends(provider, uncertain.id)).toBe(1);
    expect(provider.delivered).toHaveLength(1);
    expect(provider.lookups).toEqual([uncertain.idempotency_key]);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.smsSegment, reserved: before.reserved });
    const attempts = await h.rows("SELECT kind, outcome FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt", [tenant, uncertain.id]);
    expect(attempts).toEqual([{ kind: "send", outcome: "uncertain" }, { kind: "lookup", outcome: "accepted" }]);
  });

  it("a lookup that proves nothing was taken releases the money and ends the delivery without a second send", async () => {
    const provider = noDedupe();
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms" });
    const worker = h.worker({}, provider);
    provider.queue("timeout");
    await worker.runOnce();
    h.clock.advance(1_000);
    await worker.runOnce();
    const dead = await h.delivery(tenant, messageId);
    expect(dead).toMatchObject({ status: "dead", final_reason: "dedupe_window_expired", outcome_unknown: false });
    expect(sends(provider, dead.id)).toBe(1);
    expect(await reservations(dead.id)).toEqual(["released"]);
    expect(await h.wallet(tenant)).toEqual(before);
  });

  it("a definite refusal is retried even a day later, because no window limits a send after a definite answer", async () => {
    const provider = noDedupe();
    await h.credit(tenant, 100);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms" });
    const worker = h.worker({}, provider);
    provider.queue("fail");
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "pending", outcome_unknown: false });
    h.clock.advance(25 * HOUR);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent" });
    expect(provider.delivered).toHaveLength(1);
  });

  it("without evidence it waits with growing backoff, never sends, and dead-letters with the money held when the wait ends", async () => {
    const provider = noDedupe(false);
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms" });
    const worker = h.worker({}, provider);
    provider.queue("lose-reply");
    await worker.runOnce();
    const first = await h.delivery(tenant, messageId);
    const waits: number[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const due = (await h.delivery(tenant, messageId)).next_attempt_at as Date;
      h.clock.set(due.getTime());
      await worker.runOnce();
      const row = await h.delivery(tenant, messageId);
      expect(row).toMatchObject({ status: "uncertain", outcome_unknown: true, last_error: "lookup_unsupported" });
      waits.push((row.next_attempt_at as Date).getTime() - h.clock.now().getTime());
    }
    // Backoff by lookup count: 1 s, 2 s, 4 s, 8 s.
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    h.clock.set((first.first_attempt_at as Date).getTime() + 6 * HOUR);
    await worker.runOnce();
    const dead = await h.delivery(tenant, messageId);
    expect(dead).toMatchObject({ status: "dead", final_reason: "outcome_unknown", outcome_unknown: true });
    expect(sends(provider, first.id)).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.smsSegment });
    await worker.settleUnknown({ tenantId: tenant, deliveryId: dead.id, outcome: "sent", providerMessageId: "fake-1" });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.smsSegment, reserved: before.reserved });
  });

  it("evidence that arrives late (a status callback) settles the held send once", async () => {
    const evidence = new Map<string, string>();
    const base = noDedupe(false);
    const provider: DeliveryProvider = {
      name: base.name, dedupeWindowMs: 0, outcomeWaitMs: 6 * HOUR, send: base.send,
      async lookup(_key, { deliveryId }): Promise<ProviderLookupOutcome> {
        const sid = evidence.get(deliveryId);
        return sid ? { status: "accepted", providerMessageId: sid } : { status: "unknown", code: "no_evidence" };
      },
    };
    await h.credit(tenant, 100);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms" });
    const worker = h.worker({}, provider);
    base.queue("lose-reply");
    await worker.runOnce();
    const row = await h.delivery(tenant, messageId);
    h.clock.advance(1_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "uncertain", last_error: "no_evidence" });
    evidence.set(row.id, "SM0123456789abcdef0123456789abcdef");
    h.clock.advance(HOUR);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent", provider_message_id: "SM0123456789abcdef0123456789abcdef" });
    expect(base.calls.filter((call) => call.deliveryId === row.id)).toHaveLength(1);
    expect(await reservations(row.id)).toEqual(["captured"]);
  });

  it("a STOP that lands after an unknown send still lets the evidence count the send, or blocks it when nothing was taken", async () => {
    const provider = noDedupe();
    await h.credit(tenant, 100);
    const taken = await smsContact();
    const lost = await smsContact();
    const worker = h.worker({}, provider);
    const a = await h.enqueue(tenant, { contactId: taken, channel: "sms" });
    provider.queue("lose-reply");
    await worker.runOnce();
    const b = await h.enqueue(tenant, { contactId: lost, channel: "sms" });
    provider.queue("timeout");
    await worker.runOnce();
    for (const messageId of [a.messageId, b.messageId]) {
      const row = await h.delivery(tenant, messageId);
      await h.service((tx) => tx.query(
        "INSERT INTO suppressions (tenant_id, channel, address, reason, source, created_at) VALUES ($1,'sms',$2,'stop','test',$3)",
        [tenant, row.recipient_address, h.clock.now()]));
    }
    h.clock.advance(1_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, a.messageId)).toMatchObject({ status: "sent" });
    const blocked = await h.delivery(tenant, b.messageId);
    expect(blocked).toMatchObject({ status: "blocked", final_reason: "suppressed", outcome_unknown: false });
    expect(await reservations(blocked.id)).toEqual(["released"]);
    expect(provider.delivered).toHaveLength(1);
  });

  it("a worker that crashed mid-send leaves an open attempt; the next lease holder waits for evidence instead of sending", async () => {
    // Evidence appears once the provider has really created the message, as a status callback would.
    const base = noDedupe(false);
    const provider: DeliveryProvider = {
      name: base.name, dedupeWindowMs: 0, outcomeWaitMs: 6 * HOUR, send: base.send,
      async lookup(_key, { deliveryId }): Promise<ProviderLookupOutcome> {
        const made = base.delivered.find((item) => item.request.deliveryId === deliveryId);
        return made ? { status: "accepted", providerMessageId: made.providerMessageId } : { status: "unknown", code: "no_evidence" };
      },
    };
    await h.credit(tenant, 100);
    const { messageId } = await h.enqueue(tenant, { contactId: await smsContact(), channel: "sms" });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    base.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), then: "accept", reached });
    const stalled = h.worker({ workerId: `stalled-${randomUUID().slice(0, 4)}` }, provider);
    const running = stalled.runOnce();
    await arrived;
    // The stalled worker's lease runs out while the provider holds its call.
    h.clock.advance(61_000);
    await h.worker({}, provider).runOnce();
    const row = await h.delivery(tenant, messageId);
    expect(row).toMatchObject({ status: "uncertain", outcome_unknown: true, last_error: "no_evidence" });
    release();
    await running;
    h.clock.advance(1_000);
    await h.worker({}, provider).runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent" });
    expect(sends(base, row.id)).toBe(1);
    expect(base.delivered).toHaveLength(1);
    expect(await reservations(row.id)).toEqual(["captured"]);
  });
});
