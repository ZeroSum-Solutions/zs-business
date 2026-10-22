// M3d re-check at delivery and the stop paths (delivery.md D-6, D-9).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SUPPRESSION_RECORD_ACTION } from "@zs/contracts";
import { ACTION_PERMISSIONS, directDispatch } from "../../src/edge/session.js";
import {
  createInboundSmsSession,
  createUnsubscribeSession,
  DEFAULT_SMS_REPLIES,
  recordSuppression,
  signUnsubscribeToken,
  suppressionTargetId,
  type EdgeDependencies,
} from "../../src/index.js";
import { createDeliveryHarness, PRICES, UNSUBSCRIBE_SECRET, type DeliveryHarness } from "./helpers.js";

let h: DeliveryHarness;
let tenant: string;
let edge: EdgeDependencies;
beforeAll(async () => {
  h = await createDeliveryHarness();
  edge = { db: h.database.db, clock: h.clock, generateId: randomUUID };
});
beforeEach(async () => {
  tenant = await h.tenant();
  await h.credit(tenant, 1_000);
});
afterEach(async () => { await h.reset(); });
afterAll(async () => { await h?.close(); });

const setConsent = (tenantId: string, contactId: string, channel: "email" | "sms", status: "granted" | "denied") =>
  h.service((tx) => tx.query(
    `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
     VALUES ($1,$2,$3::crm_consent_channel,$4,'test',$5)
     ON CONFLICT (tenant_id,contact_id,channel) DO UPDATE SET status=excluded.status`,
    [tenantId, contactId, channel, status, h.clock.now()]));

describe("consent and approval re-checked at delivery (D-6)", () => {
  it("blocks a send whose consent was withdrawn after it was approved, and charges nothing", async () => {
    const contactId = await h.contact(tenant, { consent: { email: "granted" } });
    const { messageId } = await h.enqueue(tenant, { contactId, purpose: "marketing" });
    await setConsent(tenant, contactId, "email", "denied");
    const before = await h.wallet(tenant);
    await h.worker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status: "blocked", final_reason: "consent_denied", attempts: 0 });
    expect(h.provider.calls).toHaveLength(0);
    expect(await h.wallet(tenant)).toEqual(before);
  });

  it.each([
    ["marketing email with no grant", { channel: "email", purpose: "marketing" }, {}, "blocked", "consent_missing"],
    ["transactional SMS with no grant", { channel: "sms", purpose: "transactional" }, {}, "blocked", "consent_missing"],
    ["transactional email denied", { channel: "email", purpose: "transactional" }, { email: "denied" }, "blocked", "consent_denied"],
    ["transactional email with no record", { channel: "email", purpose: "transactional" }, {}, "sent", null],
    ["marketing SMS granted", { channel: "sms", purpose: "marketing" }, { sms: "granted" }, "sent", null],
  ] as const)("%s", async (_, message, consent, status, reason) => {
    const contactId = await h.contact(tenant, { phone: "+15555550100", consent });
    const { messageId } = await h.enqueue(tenant, { contactId, ...message });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, messageId)).toMatchObject({ status, final_reason: reason });
  });

  it("blocks a revoked approval and an approval for other content", async () => {
    const contactId = await h.contact(tenant);
    const revoked = await h.enqueue(tenant, { contactId });
    h.approvals.revoke(tenant, revoked.approvalId);
    const unapproved = await h.enqueue(tenant, { contactId: await h.contact(tenant), approve: false });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, revoked.messageId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
    expect(await h.delivery(tenant, unapproved.messageId)).toMatchObject({ status: "blocked", final_reason: "approval_missing" });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("blocks a contact with no usable address", async () => {
    const placeholder = await h.contact(tenant, { email: `unset-${randomUUID()}@placeholder.invalid` });
    const noPhone = await h.contact(tenant, { consent: { sms: "granted" } });
    // Any address under the reserved .invalid name is a placeholder, not only the column default's.
    const reserved = await h.contact(tenant, { email: `someone-${randomUUID().slice(0, 8)}@example.invalid` });
    const email = await h.enqueue(tenant, { contactId: placeholder });
    const reservedEmail = await h.enqueue(tenant, { contactId: reserved });
    const sms = await h.enqueue(tenant, { contactId: noPhone, channel: "sms" });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, email.messageId)).toMatchObject({ status: "blocked", final_reason: "no_address" });
    expect(await h.delivery(tenant, reservedEmail.messageId)).toMatchObject({ status: "blocked", final_reason: "no_address" });
    expect(await h.delivery(tenant, sms.messageId)).toMatchObject({ status: "blocked", final_reason: "no_address" });
  });

  it("re-checks before a retry: consent withdrawn after an uncertain attempt means ask the provider, never resend", async () => {
    const contactId = await h.contact(tenant, { consent: { email: "granted" } });
    const sent = await h.enqueue(tenant, { contactId, purpose: "marketing" });
    const worker = h.worker();
    h.provider.queue("lose-reply");
    await worker.runOnce();
    const other = await h.contact(tenant, { consent: { email: "granted" } });
    const notSent = await h.enqueue(tenant, { contactId: other, purpose: "marketing" });
    h.provider.queue("timeout");
    await worker.runOnce();
    await setConsent(tenant, contactId, "email", "denied");
    await setConsent(tenant, other, "email", "denied");
    const before = await h.wallet(tenant);
    const calls = h.provider.calls.length;
    h.clock.advance(5_000);
    await worker.runOnce();
    expect(h.provider.calls.length).toBe(calls);
    expect(h.provider.lookups).toHaveLength(2);
    // It was delivered before the withdrawal: it is paid for. The other never left: released, blocked.
    expect(await h.delivery(tenant, sent.messageId)).toMatchObject({ status: "sent" });
    expect(await h.delivery(tenant, notSent.messageId)).toMatchObject({ status: "blocked", final_reason: "consent_denied" });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved - 2 * PRICES.email });
  });
  it("re-checks before a retry: a suppression or a revoked approval after an uncertain attempt means ask the provider, never resend", async () => {
    const worker = h.worker();
    const suppressedContact = await h.contact(tenant);
    const delivered = await h.enqueue(tenant, { contactId: suppressedContact });
    h.provider.queue("lose-reply");
    await worker.runOnce();
    const revoked = await h.enqueue(tenant, { contactId: await h.contact(tenant) });
    h.provider.queue("timeout");
    await worker.runOnce();
    const address = (await h.delivery(tenant, delivered.messageId)).recipient_address;
    await h.service((tx) => tx.query(
      "INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'complaint','test',$3)",
      [tenant, address, h.clock.now()]));
    h.approvals.revoke(tenant, revoked.approvalId);
    const before = await h.wallet(tenant);
    const calls = h.provider.calls.length;
    h.clock.advance(5_000);
    await worker.runOnce();
    expect(h.provider.calls.length).toBe(calls);
    expect(h.provider.lookups).toHaveLength(2);
    expect(await h.delivery(tenant, delivered.messageId)).toMatchObject({ status: "sent" });
    expect(await h.delivery(tenant, revoked.messageId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
    expect(await h.wallet(tenant)).toEqual({ balance: before.balance - PRICES.email, reserved: before.reserved - 2 * PRICES.email });
  });
});

describe("suppression and unsubscribe (D-9)", () => {
  async function sentEmail(contactId: string) {
    const { messageId } = await h.enqueue(tenant, { contactId });
    await h.worker().runOnce();
    const delivery = await h.delivery(tenant, messageId);
    expect(delivery.status).toBe("sent");
    return delivery;
  }

  it("one-click unsubscribe suppresses the address; the next email to it is blocked", async () => {
    const contactId = await h.contact(tenant);
    const delivery = await sentEmail(contactId);
    const session = createUnsubscribeSession(edge, { current: UNSUBSCRIBE_SECRET });
    const token = signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: tenant, deliveryId: delivery.id });
    expect(await session.check(token)).toEqual({ valid: true });
    expect(await h.rows("SELECT 1 FROM suppressions WHERE tenant_id=$1", [tenant])).toHaveLength(0);
    expect(await session.unsubscribe(token)).toEqual({ channel: "email", suppressed: true, changed: true });
    // A repeat (a second click, a retried POST) replays the stored action.
    expect(await session.unsubscribe(token)).toEqual({ channel: "email", suppressed: true, changed: true });
    expect(await h.rows("SELECT channel, address, reason FROM suppressions WHERE tenant_id=$1", [tenant]))
      .toEqual([{ channel: "email", address: delivery.recipient_address, reason: "unsubscribe" }]);
    expect(await h.rows("SELECT action_type FROM actions WHERE tenant_id=$1 AND action_type='suppression.record'", [tenant])).toHaveLength(1);
    const next = await h.enqueue(tenant, { contactId });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, next.messageId)).toMatchObject({ status: "blocked", final_reason: "suppressed" });
  });

  it("refuses forged tokens, tokens signed with another secret, and tokens for another tenant's delivery", async () => {
    const session = createUnsubscribeSession(edge, { current: UNSUBSCRIBE_SECRET });
    const delivery = await sentEmail(await h.contact(tenant));
    const forged = signUnsubscribeToken("another-secret-another-secret-12345", { tenantId: tenant, deliveryId: delivery.id });
    await expect(session.unsubscribe(forged)).rejects.toMatchObject({ code: "NotFound" });
    await expect(session.unsubscribe("zsu1_garbage")).rejects.toMatchObject({ code: "NotFound" });
    const otherTenant = await h.tenant();
    const crossed = signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: otherTenant, deliveryId: delivery.id });
    await expect(session.unsubscribe(crossed)).rejects.toMatchObject({ code: "NotFound" });
    expect(await h.rows("SELECT 1 FROM suppressions WHERE tenant_id IN ($1,$2)", [tenant, otherTenant])).toHaveLength(0);
  });

  it("accepts a token signed with the previous secret during a rotation", async () => {
    const delivery = await sentEmail(await h.contact(tenant));
    const session = createUnsubscribeSession(edge, { current: "rotated-secret-rotated-secret-123456", previous: UNSUBSCRIBE_SECRET });
    const token = signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: tenant, deliveryId: delivery.id });
    expect(await session.unsubscribe(token)).toMatchObject({ suppressed: true });
  });

  it("STOP suppresses the number with one confirmation, START lifts it, HELP answers, other text is ignored", async () => {
    const phone = "+15555550142";
    const contactId = await h.contact(tenant, { phone, consent: { sms: "granted" } });
    const sms = createInboundSmsSession(edge, tenant);
    expect(await sms.receive({ from: phone, body: "When is my appointment?", providerMessageId: "in-1" }))
      .toEqual({ keyword: null, reply: null });
    expect(await sms.receive({ from: phone, body: "help", providerMessageId: "in-2" })).toEqual({ keyword: "help", reply: DEFAULT_SMS_REPLIES.help });
    expect(await sms.receive({ from: phone, body: "  Stop! ", providerMessageId: "in-3" })).toEqual({ keyword: "stop", reply: DEFAULT_SMS_REPLIES.stop });
    // A redelivered webhook replays: one action, one row.
    await sms.receive({ from: phone, body: "  Stop! ", providerMessageId: "in-3" });
    expect(await h.rows("SELECT reason, source FROM suppressions WHERE tenant_id=$1", [tenant])).toEqual([{ reason: "stop", source: "sms:in-3" }]);
    expect(await h.rows("SELECT 1 FROM actions WHERE tenant_id=$1 AND action_type='suppression.record'", [tenant])).toHaveLength(1);
    const blocked = await h.enqueue(tenant, { contactId, channel: "sms" });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, blocked.messageId)).toMatchObject({ status: "blocked", final_reason: "suppressed" });
    expect(await sms.receive({ from: phone, body: "START", providerMessageId: "in-4" })).toEqual({ keyword: "start", reply: DEFAULT_SMS_REPLIES.start });
    expect(await h.rows("SELECT 1 FROM suppressions WHERE tenant_id=$1", [tenant])).toHaveLength(0);
    const allowed = await h.enqueue(tenant, { contactId, channel: "sms" });
    await h.worker().runOnce();
    expect(await h.delivery(tenant, allowed.messageId)).toMatchObject({ status: "sent" });
  });

  it("START does not lift a suppression recorded for another reason", async () => {
    const phone = "+15555550143";
    await h.service((tx) => tx.query(
      "INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'sms',$2,'complaint','carrier',$3)",
      [tenant, phone, h.clock.now()]));
    const sms = createInboundSmsSession(edge, tenant);
    expect(await sms.receive({ from: phone, body: "start", providerMessageId: "in-5" })).toEqual({ keyword: "start", reply: null });
    expect(await h.rows("SELECT reason FROM suppressions WHERE tenant_id=$1", [tenant])).toEqual([{ reason: "complaint" }]);
  });

  it("a lasting reason recorded after STOP replaces it, so START cannot lift it", async () => {
    const phone = "+15555550145";
    const sms = createInboundSmsSession(edge, tenant);
    await sms.receive({ from: phone, body: "STOP", providerMessageId: "in-7" });
    const run = directDispatch(edge, tenant, randomUUID(), async () => {});
    const manual = (reason: "manual" | "stop") => recordSuppression({
      actionType: SUPPRESSION_RECORD_ACTION,
      target: { tenantId: tenant, type: "suppression", id: suppressionTargetId(tenant, "sms", phone) },
      approvalReference: { tenantId: tenant, id: randomUUID() },
      idempotencyKey: `operator:${randomUUID()}`,
      payload: { channel: "sms", address: phone, reason, source: "operator" },
    }, { dispatch: run });
    expect(await manual("manual")).toEqual({ channel: "sms", suppressed: true, changed: true });
    // A stop never downgrades a lasting reason.
    expect(await manual("stop")).toEqual({ channel: "sms", suppressed: true, changed: false });
    expect(await sms.receive({ from: phone, body: "START", providerMessageId: "in-8" })).toEqual({ keyword: "start", reply: null });
    expect(await h.rows("SELECT reason, source FROM suppressions WHERE tenant_id=$1", [tenant])).toEqual([{ reason: "manual", source: "operator" }]);
  });

  it("accepts a provider message ID up to 180 characters, so the key and source built from it stay valid", async () => {
    const sms = createInboundSmsSession(edge, tenant);
    expect(await sms.receive({ from: "+15555550146", body: "STOP", providerMessageId: "S".repeat(180) }))
      .toEqual({ keyword: "stop", reply: DEFAULT_SMS_REPLIES.stop });
    await expect(sms.receive({ from: "+15555550147", body: "STOP", providerMessageId: "S".repeat(181) }))
      .rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("keeps suppressions per tenant: a STOP to one business does not silence another", async () => {
    const phone = "+15555550144";
    const other = await h.tenant();
    await h.credit(other, 100);
    const otherContact = await h.contact(other, { phone, consent: { sms: "granted" } });
    await createInboundSmsSession(edge, tenant).receive({ from: phone, body: "STOP", providerMessageId: "in-6" });
    const { messageId } = await h.enqueue(other, { contactId: otherContact, channel: "sms" });
    await h.worker().runOnce();
    expect(await h.delivery(other, messageId)).toMatchObject({ status: "sent" });
    // Under the runtime role, tenant B cannot see A's list.
    expect(await h.database.db.tenant(other, async (tx) => (await tx.query("SELECT * FROM suppressions WHERE tenant_id=$1", [tenant])).rowCount)).toBe(0);
  });

  it("no member session can run a suppression action", () => {
    expect(Object.keys(ACTION_PERMISSIONS).filter((type) => type.startsWith("suppression."))).toEqual([]);
  });
});
