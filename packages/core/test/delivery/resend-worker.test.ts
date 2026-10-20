// M5: the real delivery worker (M3d) with the Resend adapter as its email provider, against a
// real Postgres and the in-process fake Resend server on the harness clock.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDeliveryWorker,
  createResendProvider,
  verifyUnsubscribeToken,
  type DeliveryWorkerConfig,
} from "../../src/index.js";
import { startFakeResend, type FakeResend } from "./fake-resend.js";
import { createDeliveryHarness, PRICES, UNSUBSCRIBE_SECRET, type DeliveryHarness } from "./helpers.js";

const API_KEY = `re_test_${randomBytes(16).toString("hex")}`;
const FROM = "Halden & Rowe <bookings@haldenrowe.example>";
const DAY_MS = 24 * 60 * 60 * 1000;

let h: DeliveryHarness;
let tenant: string;
let server: FakeResend;
beforeAll(async () => { h = await createDeliveryHarness(); });
beforeEach(async () => {
  tenant = await h.tenant();
  server = await startFakeResend({ apiKey: API_KEY, clock: h.clock });
});
afterEach(async () => {
  await server.close();
  await h.reset();
});
afterAll(async () => { await h?.close(); });

/** What the worker told the producer about each settled delivery, in order. */
let settled: { messageId: string; outcome: "sent" | "failed" }[] = [];
beforeEach(() => { settled = []; });

/** A worker like the harness's, with Resend for email and the harness fake for SMS. */
function resendWorker(overrides: Partial<DeliveryWorkerConfig> = {}) {
  const config = h.worker(overrides).config;
  const resend = createResendProvider({ config: { apiKey: API_KEY, from: FROM, baseUrl: server.url } });
  return createDeliveryWorker({
    service: h.service,
    providers: { email: resend, sms: h.provider },
    approvals: h.approvals.port,
    clock: h.clock,
    generateId: randomUUID,
    config,
    onSettled: async (_tx, _tenantId, messageId, outcome) => { settled.push({ messageId, outcome }); },
  });
}

const captures = async (tenantId: string) =>
  (await h.rows("SELECT amount FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantId])).length;
const attempts = (deliveryId: string) =>
  h.rows("SELECT attempt, kind, outcome, error_code FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt",
    [tenant, deliveryId]);

/** Every request reached the fake under the delivery's one key, with the same bytes. */
function expectOneKeyOneBody(key: string) {
  expect(new Set(server.received.map((item) => item.headers["idempotency-key"]))).toEqual(new Set([key]));
  expect(new Set(server.received.map((item) => item.raw)).size).toBe(1);
}

describe("Resend as the worker's email provider", () => {
  it("sends once with the worker's unsubscribe headers, records Resend's ID and captures the price once", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const run = await resendWorker().runOnce();
    expect(server.delivered).toHaveLength(1);
    const sent = server.delivered[0]!;
    expect(run.results).toEqual([{ outcome: "sent", providerMessageId: sent.id }]);
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({
      status: "sent", provider: "resend", provider_message_id: sent.id, attempts: 1, outcome_unknown: false, last_error: null,
    });
    expect(sent.idempotencyKey).toBe(delivery.idempotency_key);
    const body = sent.body as { from: string; to: string[]; subject: string; text: string; headers: Record<string, string>; tags: unknown };
    expect(body).toMatchObject({ from: FROM, to: [delivery.recipient_address], subject: delivery.subject });
    // Exactly the headers the worker built and stored for resends.
    expect(body.headers).toEqual(delivery.request.headers);
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const unsubscribe = body.headers["List-Unsubscribe"]!;
    expect(unsubscribe).toMatch(/^<https:\/\/api\.example\.test\/public\/v1\/unsubscribe\/zsu1_[^>]+>$/);
    const url = unsubscribe.slice(1, -1);
    expect(body.text).toBe(delivery.request.text);
    expect(body.text).toContain(url);
    expect(verifyUnsubscribeToken({ current: UNSUBSCRIBE_SECRET }, url.split("/").at(-1)!)).toEqual({ tenantId: tenant, deliveryId: delivery.id });
    expect(body.tags).toEqual([{ name: "zs_tenant", value: tenant }, { name: "zs_delivery", value: delivery.id }]);
    expect(await captures(tenant)).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    expect(await attempts(delivery.id)).toEqual([{ attempt: 1, kind: "send", outcome: "accepted", error_code: null }]);
  });

  it("a lost reply holds the reservation; the resend under the same key gets the original ID and charges once", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = resendWorker();
    server.queue("lose-reply");
    await worker.runOnce();
    const uncertain = await h.delivery(tenant, messageId);
    expect(uncertain).toMatchObject({ status: "uncertain", outcome_unknown: true, attempts: 1, provider: "resend", provider_message_id: null });
    expect(uncertain.last_error).toMatch(/^resend_network/);
    expect(server.delivered).toHaveLength(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    // Not due until the backoff passes.
    expect((await worker.runOnce()).claimed).toBe(0);
    h.clock.advance(1_000);
    await worker.runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", outcome_unknown: false, attempts: 2, provider_message_id: server.delivered[0]!.id });
    expect(server.received).toHaveLength(2);
    expect(server.delivered).toHaveLength(1);
    expectOneKeyOneBody(delivery.idempotency_key);
    expect(await captures(tenant)).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    expect((await attempts(delivery.id)).map((row) => row.outcome)).toEqual(["uncertain", "accepted"]);
  });

  it("a resend while the first request is still inside Resend is a 409 concurrent: uncertain, then sent once", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const first = resendWorker();
    await first.ingest();
    const [lease] = await first.claim(1);
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    server.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), reached });
    const stalled = first.step(lease!);
    await arrived;
    // The first worker's lease runs out while Resend is still working on its request.
    h.clock.advance(60_001);
    const second = resendWorker();
    const [taken] = await second.claim(10);
    expect(taken!.deliveryId).toBe((await h.delivery(tenant, messageId)).id);
    expect(await second.step(taken!)).toEqual({ outcome: "retry", status: "uncertain", reason: "resend_409_concurrent_idempotent_requests" });
    release();
    expect(await stalled).toEqual({ outcome: "lost_lease" });
    expect(server.delivered).toHaveLength(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    h.clock.advance(2_000);
    await second.runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", attempts: 3, provider_message_id: server.delivered[0]!.id });
    expect(server.received).toHaveLength(3);
    expect(server.delivered).toHaveLength(1);
    expectOneKeyOneBody(delivery.idempotency_key);
    expect(await captures(tenant)).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    expect(await attempts(delivery.id)).toEqual([
      { attempt: 1, kind: "send", outcome: "uncertain", error_code: "lease_lost" },
      { attempt: 2, kind: "send", outcome: "uncertain", error_code: "resend_409_concurrent_idempotent_requests" },
      { attempt: 3, kind: "send", outcome: "accepted", error_code: null },
    ]);
  });

  it("a 429 releases the reservation, backs off and retries, then sends with one capture", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = resendWorker();
    server.queue({ respond: 429, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." } });
    await worker.runOnce();
    const pending = await h.delivery(tenant, messageId);
    expect(pending).toMatchObject({ status: "pending", outcome_unknown: false, attempts: 1, last_error: "resend_429_rate_limit_exceeded" });
    expect(pending.next_attempt_at).toEqual(new Date(h.clock.now().getTime() + 1_000));
    expect(await h.wallet(tenant)).toEqual(before);
    expect(server.delivered).toHaveLength(0);
    h.clock.advance(1_000);
    await worker.runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", attempts: 2, provider_message_id: server.delivered[0]!.id });
    expect(server.delivered).toHaveLength(1);
    expect(await captures(tenant)).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved });
    const reservations = await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2", [tenant, delivery.id]);
    expect(reservations.map((row) => row.status).sort()).toEqual(["captured", "released"]);
  });

  it("a 429 after a lost reply proves nothing about the first send: at the cap it is outcome_unknown with the money held", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    const worker = resendWorker({ maxAttempts: 2 });
    // Attempt 1 reaches Resend, which sends the email, but the reply is lost.
    server.queue("lose-reply");
    await worker.runOnce();
    expect(server.delivered).toHaveLength(1);
    // Attempt 2, the last one allowed, is refused under the same key.
    server.queue({ respond: 429, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." } });
    h.clock.advance(1_000);
    await worker.runOnce();
    let delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "uncertain", outcome_unknown: true, attempts: 2, last_error: "resend_429_rate_limit_exceeded" });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    // The cap is reached with the outcome unknown: Resend cannot be asked, so an operator decides (D-8).
    h.clock.set((delivery.next_attempt_at as Date).getTime());
    await worker.runOnce();
    delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "dead", final_reason: "outcome_unknown", outcome_unknown: true, last_error: "lookup_unsupported" });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    expect(await captures(tenant)).toBe(0);
    const reservations = await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2", [tenant, delivery.id]);
    expect(reservations.map((row) => row.status)).toEqual(["held"]);
    // The reply is not reported as failed, so nobody is invited to send it again.
    expect(settled).toEqual([]);
    expect(server.received).toHaveLength(2);
    expect(server.delivered).toHaveLength(1);
    expectOneKeyOneBody(delivery.idempotency_key);
    expect((await attempts(delivery.id)).map((row) => [row.kind, row.outcome])).toEqual([
      ["send", "uncertain"], ["send", "failed"], ["lookup", "unknown"],
    ]);
  });

  it("a 422 is a dead letter provider_rejected with the money back and nothing captured", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    server.queue({ respond: 422, body: { statusCode: 422, name: "validation_error", message: "Invalid `to` field." } });
    await resendWorker().runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "dead", final_reason: "provider_rejected", outcome_unknown: false, provider_message_id: null });
    expect(await h.wallet(tenant)).toEqual(before);
    expect(await captures(tenant)).toBe(0);
    expect(server.delivered).toHaveLength(0);
    expect(await attempts(delivery.id)).toEqual([{ attempt: 1, kind: "send", outcome: "rejected", error_code: "resend_422_validation_error" }]);
    // Nothing more to do for it.
    h.clock.advance(60_000);
    expect((await resendWorker().runOnce()).claimed).toBe(0);
    expect(server.received).toHaveLength(1);
  });

  it("500 on every try: resends stop at the window end minus margin, then a dead letter outcome_unknown with the money held", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const contactId = await h.contact(tenant);
    const { messageId } = await h.enqueue(tenant, { contactId });
    // Enough attempts and a long enough backoff cap that the window, not the cap, ends it.
    const overrides = { maxAttempts: 50, backoffMaxMs: 4 * 60 * 60 * 1000 };
    const worker = resendWorker(overrides);
    const { providerTimeoutMs, dedupeMarginMs } = worker.config;
    server.setFallback({ respond: 500, body: { statusCode: 500, name: "internal_server_error", message: "Unexpected error." } });
    await worker.runOnce();
    let row = await h.delivery(tenant, messageId);
    const windowEnd = (row.first_attempt_at as Date).getTime() + DAY_MS - dedupeMarginMs;
    let lastStep = { at: 0, calls: 0 };
    for (let i = 0; i < 60 && row.status !== "dead"; i += 1) {
      expect(row).toMatchObject({ status: "uncertain", outcome_unknown: true, last_error: "resend_500_internal_server_error" });
      h.clock.set((row.next_attempt_at as Date).getTime());
      const calls = server.received.length;
      await worker.runOnce();
      lastStep = { at: h.clock.now().getTime(), calls: server.received.length - calls };
      row = await h.delivery(tenant, messageId);
    }
    expect(row).toMatchObject({ status: "dead", final_reason: "outcome_unknown", outcome_unknown: true, last_error: "lookup_unsupported" });
    // The step that ended it ran too late for a whole call inside the window and made none.
    expect(lastStep.calls).toBe(0);
    expect(lastStep.at + providerTimeoutMs).toBeGreaterThan(windowEnd);
    // Every call that was made fit, deadline included, inside the window.
    for (const request of server.received) expect(request.at + providerTimeoutMs).toBeLessThanOrEqual(windowEnd);
    // More sends than the harness default cap of 4: the window ended it.
    expect(server.received.length).toBeGreaterThan(4);
    expect(server.received.length).toBe(row.attempts);
    expect(row.attempts).toBeLessThan(overrides.maxAttempts);
    expectOneKeyOneBody(row.idempotency_key);
    expect(server.delivered).toHaveLength(0);
    // Resend has no lookup by key: the money stays held for an operator.
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.email });
    expect(await captures(tenant)).toBe(0);
    const log = await attempts(row.id);
    expect(log.at(-1)).toMatchObject({ kind: "lookup", outcome: "unknown", error_code: "lookup_unsupported" });
    expect(log.filter((entry) => entry.kind === "send")).toHaveLength(server.received.length);
    // Nothing is claimed again.
    h.clock.advance(DAY_MS);
    expect((await worker.runOnce()).claimed).toBe(0);
  });
});
