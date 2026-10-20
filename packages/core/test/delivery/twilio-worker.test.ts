// M5: the real delivery worker (M3d) with the Twilio adapter as its SMS provider, against a real
// Postgres, the in-process fake Twilio server and the status-callback and inbound sessions under
// the runtime role. Twilio drops no repeats, so nothing here may ever reach it twice for one delivery.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assignSmsNumber,
  createDeliveryWorker,
  createSmsStatusSession,
  createTwilioInboundSession,
  createTwilioProvider,
  smsSenderNumber,
  smsStatusEvidence,
  type EdgeDependencies,
} from "../../src/index.js";
import { startFakeTwilio, type FakeTwilio } from "./fake-twilio.js";
import { createDeliveryHarness, PRICES, type DeliveryHarness } from "./helpers.js";

const ACCOUNT_SID = `AC${randomBytes(16).toString("hex")}`;
const AUTH_TOKEN = randomBytes(16).toString("hex");
const WEBHOOK_BASE = "https://api.example.test";
const HOUR = 60 * 60 * 1000;

let h: DeliveryHarness;
let tenant: string;
let number: string;
let server: FakeTwilio;
let edge: EdgeDependencies;
let numbers = 0;
beforeAll(async () => {
  h = await createDeliveryHarness();
  edge = { db: h.database.db, clock: h.clock, generateId: randomUUID };
});
beforeEach(async () => {
  tenant = await h.tenant();
  numbers += 1;
  number = `+1555555${String(1000 + numbers)}`;
  await h.service((tx) => assignSmsNumber(tx, { tenantId: tenant, phoneNumber: number, now: h.clock.now() }));
  server = await startFakeTwilio({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });
});
afterEach(async () => {
  await server.close();
  await h.reset();
});
afterAll(async () => { await h?.close(); });

/** A worker like the harness's, with Twilio for SMS wired as the runner wires it. */
function twilioWorker() {
  const config = h.worker().config;
  const twilio = createTwilioProvider({
    config: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, webhookBaseUrl: WEBHOOK_BASE, baseUrl: server.url, outcomeWaitMs: 6 * HOUR },
    senderFor: (tenantId) => h.service((tx) => smsSenderNumber(tx, tenantId)),
    findStatus: (input) => h.service((tx) => smsStatusEvidence(tx, input)),
  });
  return createDeliveryWorker({
    service: h.service, providers: { email: h.provider, sms: twilio }, approvals: h.approvals.port,
    clock: h.clock, generateId: randomUUID, config,
  });
}

let phones = 0;
async function smsSend(body = "Your table is ready at 7.") {
  phones += 1;
  const phone = `+1555556${String(1000 + phones)}`;
  const contactId = await h.contact(tenant, { phone, consent: { sms: "granted" } });
  const { messageId } = await h.enqueue(tenant, { contactId, channel: "sms", body });
  return { messageId, phone, contactId };
}
const status = (deliveryId: string, sid: string, to: string, messageStatus: string, errorCode?: string) =>
  createSmsStatusSession(edge).receive(tenant, deliveryId, {
    AccountSid: ACCOUNT_SID, MessageSid: sid, MessageStatus: messageStatus, ErrorCode: errorCode ?? null, To: to,
  });
const captures = async () => (await h.rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenant])).length;

describe("Twilio as the worker's SMS provider", () => {
  it("sends once from the tenant's number with the opt-out line and status callback, and captures once", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId, phone } = await smsSend();
    await twilioWorker().runOnce();
    expect(server.delivered).toHaveLength(1);
    const sent = server.delivered[0]!;
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery).toMatchObject({ status: "sent", provider: "twilio", provider_message_id: sent.sid, recipient_address: phone });
    expect(sent).toMatchObject({ to: phone, from: number, body: "Your table is ready at 7.\nReply STOP to opt out.",
      statusCallback: `${WEBHOOK_BASE}/webhooks/twilio/status/${tenant}/${delivery.id}` });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.smsSegment, reserved: before.reserved });
    // Carrier statuses afterwards are evidence only; nothing is sent or charged again.
    expect(await status(delivery.id, sent.sid, phone, "delivered")).toMatchObject({ handled: true, result: { recorded: true } });
    await twilioWorker().runOnce();
    expect(server.received).toHaveLength(1);
    expect(await captures()).toBe(1);
  });

  it("a lost reply is never resent; the status callback settles it once", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId, phone } = await smsSend();
    const worker = twilioWorker();
    server.queue("lose-reply");
    await worker.runOnce();
    const uncertain = await h.delivery(tenant, messageId);
    expect(uncertain).toMatchObject({ status: "uncertain", outcome_unknown: true });
    for (let turn = 0; turn < 3; turn += 1) {
      h.clock.set((await h.delivery(tenant, messageId)).next_attempt_at.getTime());
      await worker.runOnce();
    }
    expect(server.received).toHaveLength(1);
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "uncertain", last_error: "twilio_no_status_evidence" });
    const sid = server.delivered[0]!.sid;
    expect(await status(uncertain.id, sid, phone, "sent")).toMatchObject({ handled: true });
    // A callback for another message cannot claim this delivery.
    expect(await status(uncertain.id, `SM${randomBytes(16).toString("hex")}`, phone, "sent"))
      .toEqual({ handled: false, reason: "message_mismatch" });
    h.clock.set((await h.delivery(tenant, messageId)).next_attempt_at.getTime());
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent", provider_message_id: sid, outcome_unknown: false });
    expect(server.delivered).toHaveLength(1);
    expect(await captures()).toBe(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.smsSegment, reserved: before.reserved });
  });

  it("an answer that never comes holds the money and dead-letters outcome_unknown after the wait, still with one request", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId } = await smsSend();
    const worker = twilioWorker();
    server.queue({ respond: 503, body: { code: 20500, message: "unavailable" } });
    await worker.runOnce();
    const first = await h.delivery(tenant, messageId);
    expect(first).toMatchObject({ status: "uncertain", last_error: "twilio_503_20500" });
    h.clock.set(first.first_attempt_at.getTime() + 6 * HOUR);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "outcome_unknown", outcome_unknown: true });
    expect(server.received).toHaveLength(1);
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance, reserved: before.reserved + PRICES.smsSegment });
  });

  it("a rate limit is a definite refusal: the money goes back and the retry sends once", async () => {
    await h.credit(tenant, 100);
    const { messageId } = await smsSend();
    const worker = twilioWorker();
    server.queue({ respond: 429, body: { code: 20429, message: "Too many requests" } });
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "pending", outcome_unknown: false, last_error: "twilio_429_20429" });
    h.clock.advance(60_000);
    await worker.runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "sent" });
    expect(server.delivered).toHaveLength(1);
    expect(await captures()).toBe(1);
  });

  it("a recipient who opted out at Twilio is a permanent rejection and the money goes back", async () => {
    await h.credit(tenant, 100);
    const before = await h.wallet(tenant);
    const { messageId, phone } = await smsSend();
    server.optOut(phone);
    await twilioWorker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "provider_rejected" });
    expect(await h.wallet(tenant)).toEqual(before);
    const attempt = await h.rows("SELECT error_code FROM message_delivery_attempts WHERE tenant_id=$1", [tenant]);
    expect(attempt).toEqual([{ error_code: "twilio_400_21610" }]);
  });

  it("a tenant without a number sends nothing", async () => {
    await h.credit(tenant, 100);
    await h.service((tx) => assignSmsNumber(tx, { tenantId: tenant, phoneNumber: null, now: h.clock.now() }));
    const { messageId } = await smsSend();
    await twilioWorker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "dead", final_reason: "provider_rejected", last_error: null });
    expect(server.received).toHaveLength(0);
  });

  it("a STOP texted to the tenant's number blocks the next send; START lets the one after go out", async () => {
    await h.credit(tenant, 100);
    const { phone, contactId } = await smsSend();
    const worker = twilioWorker();
    await worker.runOnce();
    expect(server.delivered).toHaveLength(1);
    const inbound = createTwilioInboundSession(edge, { keywordReplies: "app" });
    const text = (body: string) => inbound.receive(tenant, {
      AccountSid: ACCOUNT_SID, MessageSid: `SM${randomBytes(16).toString("hex")}`, From: phone, To: number, Body: body,
    });
    expect(await text("Stop.")).toEqual({ handled: true, keyword: "stop",
      reply: "Halden & Rowe: You are unsubscribed and will get no more messages. Reply START to resubscribe." });
    const blocked = await h.enqueue(tenant, { contactId, channel: "sms", body: "One more thing." });
    await worker.runOnce();
    expect(await h.delivery(tenant, blocked.messageId)).toMatchObject({ status: "blocked", final_reason: "suppressed" });
    expect(await text("START")).toMatchObject({ handled: true, keyword: "start" });
    const after = await h.enqueue(tenant, { contactId, channel: "sms", body: "Welcome back." });
    await worker.runOnce();
    expect(await h.delivery(tenant, after.messageId)).toMatchObject({ status: "sent" });
    expect(server.delivered).toHaveLength(2);
  });

  it("re-checks consent at send: a recorded denial blocks and nothing reaches Twilio", async () => {
    await h.credit(tenant, 100);
    const contactId = await h.contact(tenant, { phone: "+15555569999", consent: { sms: "denied" } });
    const { messageId } = await h.enqueue(tenant, { contactId, channel: "sms" });
    await twilioWorker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "blocked", final_reason: "consent_denied" });
    expect(server.received).toHaveLength(0);
  });
});
