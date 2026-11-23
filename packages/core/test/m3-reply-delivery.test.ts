// M3 seam between M3c and M3d (inbox-home.md I-6, delivery.md D-6, approvals.md A-10): an
// Inbox reply a member drafts and an owner approves goes through the real delivery worker,
// wired as it will run in production: M3b's approval record behind the approvals port and the
// reply's own settle hook. The delivery tests use stand-ins for both; this runs the real ones.
// The clock is injected and moves only when a test moves it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type MemberRole } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  approvalForAction,
  approvalsFromRecords,
  createDeliveryWorker,
  createFakeProvider,
  createSession,
  createUnsubscribeSession,
  creditWallet,
  settleReplyDelivery,
  type DeliveryReport,
  type EdgeDependencies,
  type FakeProvider,
} from "../src/index.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const PRICES = { currency: "usd", email: 2, smsSegment: 3 } as const;
const UNSUBSCRIBE_SECRET = "unsubscribe-test-secret-0123456789abcdef";
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let owner: string;
let staff: string;
let provider: FakeProvider;
let reports: DeliveryReport[];

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string) => createSession(deps(), { tenantId, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);

/** The worker as production wires it: approvalsFromRecords over M3b, onSettled from M3c. */
function worker() {
  return createDeliveryWorker({
    service,
    providers: { email: provider, sms: provider },
    approvals: approvalsFromRecords(approvalForAction, clock),
    onSettled: async (tx, tenant, messageId, outcome, at) => { await settleReplyDelivery(tx, tenant, messageId, outcome, at); },
    clock,
    generateId: randomUUID,
    report: (event) => reports.push(event),
    config: {
      workerId: "m3-seam",
      leaseMs: 60_000,
      providerTimeoutMs: 5_000,
      pricing: PRICES,
      unsubscribe: { secret: UNSUBSCRIBE_SECRET, baseUrl: "https://api.example.test/public/v1/unsubscribe" },
    },
  });
}

async function addMember(role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

async function customer() {
  const email = `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`;
  const { result } = await sessionFor(owner).upsertContact({ displayName: "Halden Guest", email }, randomUUID());
  return { contactId: result.contact.id, email };
}

/** Staff drafts, an owner approves: the reply is `approved` and its send event is committed. */
async function approvedReply(contactId: string, body = "Your table is ready at 7.") {
  const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body }, randomUUID());
  const approved = await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID());
  expect(approved.result.status).toBe("approved");
  const approval = (await rows<{ id: string }>(
    "SELECT id FROM approvals WHERE tenant_id=$1 AND target_type='inbox_reply' AND target_id=$2 AND status='approved'",
    [tenantId, draft.result.id]))[0]!;
  return { replyId: draft.result.id, approvalId: approval.id };
}

const reply = async (replyId: string) => (await rows<{ status: string; settled_at: Date | null }>(
  "SELECT status, settled_at FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, replyId]))[0]!;
const delivery = async (replyId: string) => (await rows<{ status: string; final_reason: string | null; attempts: number }>(
  "SELECT status, final_reason, attempts FROM message_deliveries WHERE tenant_id=$1 AND message_id=$2", [tenantId, replyId]))[0];
const balance = async () => Number((await rows<{ balance: string }>("SELECT balance FROM wallets WHERE tenant_id=$1", [tenantId]))[0]!.balance);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  owner = await addMember("owner");
  staff = await addMember("staff");
  await service((tx) => creditWallet(tx, {
    tenantId, ledgerId: randomUUID(), amount: 1_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START),
  }));
});
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  now = START;
  provider = createFakeProvider({ clock });
  reports = [];
  // Each test starts with no unprocessed send event from an earlier one.
  await service((tx) => tx.query("UPDATE outbox SET processed_at=$1 WHERE processed_at IS NULL", [clock.now()]));
});

describe("Inbox reply through the delivery worker", () => {
  it("sends an approved reply once, charges it once and settles the reply as sent", async () => {
    const { contactId, email } = await customer();
    const { replyId } = await approvedReply(contactId);
    const before = await balance();
    now += 60_000;
    const first = await worker().runOnce();
    expect(reports).toEqual([]);
    expect(first).toMatchObject({ ingested: 1, invalid: 0, claimed: 1, results: [{ outcome: "sent" }] });
    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]!.request).toMatchObject({ channel: "email", to: email, subject: "Your booking", tenantId });
    expect(provider.delivered[0]!.request.text.startsWith("Your table is ready at 7.")).toBe(true);
    expect(await delivery(replyId)).toMatchObject({ status: "sent", final_reason: null, attempts: 1 });
    expect(await reply(replyId)).toEqual({ status: "sent", settled_at: new Date(now) });
    expect(await balance()).toBe(before - PRICES.email);

    // Nothing is left to do: a second pass neither resends, re-charges nor re-settles.
    now += 60_000;
    expect(await worker().runOnce()).toMatchObject({ ingested: 0, claimed: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(await reply(replyId)).toEqual({ status: "sent", settled_at: new Date(now - 60_000) });
    expect(await balance()).toBe(before - PRICES.email);
  });

  it("stops a reply whose approval an owner revoked before it went out, and charges nothing", async () => {
    const { contactId } = await customer();
    const { replyId, approvalId } = await approvedReply(contactId);
    await sessionFor(owner).revokeApproval(approvalId, { note: "Wrong customer" }, randomUUID());
    const before = await balance();
    await worker().runOnce();
    expect(provider.calls).toHaveLength(0);
    expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked", attempts: 0 });
    expect(await reply(replyId)).toMatchObject({ status: "failed" });
    expect(await balance()).toBe(before);
  });

  it("stops a reply whose approval expired before the worker reached it (A-3, A-10)", async () => {
    const { contactId } = await customer();
    const { replyId } = await approvedReply(contactId);
    now += 10_080 * 60_000;
    await worker().runOnce();
    expect(provider.calls).toHaveLength(0);
    expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
    expect(await reply(replyId)).toMatchObject({ status: "failed" });
  });

  it("re-checks consent at delivery: a denial recorded after approval blocks the reply", async () => {
    const { contactId } = await customer();
    const { replyId } = await approvedReply(contactId);
    await service((tx) => tx.query(
      `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
       VALUES ($1,$2,'email','denied','test',$3)`, [tenantId, contactId, clock.now()]));
    await worker().runOnce();
    expect(provider.calls).toHaveLength(0);
    expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "consent_denied" });
    expect(await reply(replyId)).toMatchObject({ status: "failed" });
  });

  it("honours an unsubscribe from one reply's link on the next reply to that customer", async () => {
    const { contactId, email } = await customer();
    const first = await approvedReply(contactId);
    await worker().runOnce();
    expect(await reply(first.replyId)).toMatchObject({ status: "sent" });
    const link = provider.delivered[0]!.request.headers["List-Unsubscribe"]!;
    const token = /\/([^/>]+)>$/.exec(link)![1]!;
    const unsubscribe = createUnsubscribeSession(deps(), { current: UNSUBSCRIBE_SECRET });
    expect(await unsubscribe.unsubscribe(token)).toMatchObject({ channel: "email", suppressed: true });
    expect(await rows("SELECT address, reason FROM suppressions WHERE tenant_id=$1 AND address=$2", [tenantId, email]))
      .toEqual([{ address: email, reason: "unsubscribe" }]);

    const second = await approvedReply(contactId, "One more thing about your booking.");
    await worker().runOnce();
    expect(provider.calls).toHaveLength(1);
    expect(await delivery(second.replyId)).toMatchObject({ status: "blocked", final_reason: "suppressed" });
    expect(await reply(second.replyId)).toMatchObject({ status: "failed" });
  });

  describe("the approved address (approvals.md A-16, delivery.md D-6 revision 6)", () => {
    const setAddress = (contactId: string, column: "normalized_email" | "e164_phone", value: string) => service((tx) => tx.query(
      `UPDATE crm_contacts SET ${column}=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, contactId, value]));

    it("the approval read shows the address, subject and body the owner approves", async () => {
      const { contactId, email } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      const pending = (await rows<{ id: string; payload: unknown }>(
        "SELECT id, payload FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, draft.result.id]))[0]!;
      expect(pending.payload).toEqual({ replyId: draft.result.id, destination: email });
      const record = await sessionFor(owner).getApproval(pending.id);
      expect(record.send).toEqual({ contactId, channel: "email", destination: email, subject: "Your booking", body: "See you at 7." });
      const page = await sessionFor(owner).listApprovals({ status: "pending" });
      expect(page.items.find((item) => item.id === pending.id)?.send).toEqual(record.send);
    });

    it("a changed email between approval and delivery ends the send with no provider call; the owner re-approves the new address", async () => {
      const { contactId } = await customer();
      const { replyId } = await approvedReply(contactId);
      await setAddress(contactId, "normalized_email", "moved@haldenrowe.example");
      const before = await balance();
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
      expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "destination_changed", attempts: 0 });
      expect(await reply(replyId)).toMatchObject({ status: "failed" });
      expect(await balance()).toBe(before);
      // The owner sees why on the reply.
      const thread = await sessionFor(owner).getThread(`c_${contactId}`);
      expect(thread.entries.flatMap((entry) => (entry.type === "reply" && entry.reply.id === replyId ? [entry.reply] : [])))
        .toEqual([expect.objectContaining({ status: "failed", deliveryReason: "destination_changed" })]);

      // Approving the failed reply drafts the same words again for the new address and answers 409.
      const key = randomUUID();
      const error = await sessionFor(owner).approveReply(replyId, {}, key).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: "moved@haldenrowe.example" } });
      const copyId = (error as { details: { replyId: string } }).details.replyId;
      expect(copyId).not.toBe(replyId);
      // A retry of that call names the same copy and makes no second one.
      expect(await sessionFor(owner).approveReply(replyId, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", replyId: copyId } });
      // Another call names the same copy too: one failed reply gets one copy.
      expect(await sessionFor(owner).approveReply(replyId, {}, randomUUID()).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", replyId: copyId } });
      // A second owner gets the same copy, not a binding error.
      const secondOwner = await addMember("owner");
      expect(await sessionFor(secondOwner).approveReply(replyId, {}, randomUUID()).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", replyId: copyId } });
      expect(await rows("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND contact_id=$2", [tenantId, contactId])).toHaveLength(2);
      const proposal = (await rows<{ id: string }>(
        "SELECT id FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, copyId]))[0]!;
      expect((await sessionFor(owner).getApproval(proposal.id)).send).toMatchObject({
        destination: "moved@haldenrowe.example", subject: "Your booking", body: "Your table is ready at 7.",
      });
      expect((await sessionFor(owner).approveReply(copyId, {}, randomUUID())).result.status).toBe("approved");
      await worker().runOnce();
      expect(provider.delivered).toHaveLength(1);
      expect(provider.delivered[0]!.request).toMatchObject({ to: "moved@haldenrowe.example" });
      expect(await reply(copyId)).toMatchObject({ status: "sent" });
    });

    it("a proposal made for an old address is proposed again, not approved", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      await setAddress(contactId, "normalized_email", "new@haldenrowe.example");
      const error = await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID()).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: "new@haldenrowe.example" } });
      expect(await rows<{ status: string; destination: string }>(
        "SELECT status, payload->>'destination' AS destination FROM approvals WHERE tenant_id=$1 AND target_id=$2 ORDER BY status",
        [tenantId, draft.result.id])).toEqual(expect.arrayContaining([
        { status: "revoked", destination: expect.stringMatching(/@haldenrowe\.example$/) },
        { status: "pending", destination: "new@haldenrowe.example" },
      ]));
      expect((await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID())).result.status).toBe("approved");
      await worker().runOnce();
      expect(provider.delivered[0]!.request).toMatchObject({ to: "new@haldenrowe.example" });
    });

    it("a retry of the call that proposed again replays the same 409; the key cannot move to another reply", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      await setAddress(contactId, "normalized_email", "again@haldenrowe.example");
      const key = randomUUID();
      const first = await sessionFor(owner).approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught);
      const approvalId = (first as { details: { approvalId: string } }).details.approvalId;
      expect(first).toMatchObject({ details: { reason: "destination_changed", destination: "again@haldenrowe.example" } });
      expect(await sessionFor(owner).approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", approvalId } });
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, draft.result.id]))
        .toHaveLength(1);
      const other = await sessionFor(staff).draftReply({ contactId, subject: "Other", body: "Other words." }, randomUUID());
      expect(await sessionFor(owner).approveReply(other.result.id, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ code: "IdempotencyConflict" });
    });

    it("an address that changes between the approve call's read and its run is withdrawn and proposed again", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      // The first transaction of the call is its read; the address changes right after it commits.
      let move: (() => Promise<unknown>) | null = () => setAddress(contactId, "normalized_email", "race@haldenrowe.example");
      const db = database.db;
      const racing: typeof db = { ...db, tenant: async (tenant, work, options) => {
        const out = await db.tenant(tenant, work, options);
        const next = move; move = null;
        if (next) await next();
        return out;
      } };
      const key = randomUUID();
      const owners = createSession({ ...deps(), db: racing }, { tenantId, actorId: owner });
      const error = await owners.approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: "race@haldenrowe.example" } });
      const approvalId = (error as { details: { approvalId: string } }).details.approvalId;
      expect(await rows<{ status: string; destination: string }>(
        "SELECT status, payload->>'destination' AS destination FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status IN ('pending','approved')",
        [tenantId, draft.result.id])).toEqual([{ status: "pending", destination: "race@haldenrowe.example" }]);
      // The same key replays the same answer.
      expect(await sessionFor(owner).approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", approvalId } });
      expect((await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID())).result.status).toBe("approved");
      await worker().runOnce();
      expect(provider.delivered[0]!.request).toMatchObject({ to: "race@haldenrowe.example" });
    });

    it("with no open proposal, an address that changes before the new proposal is left pending, not approved", async () => {
      const { contactId, email } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      const pending = (await rows<{ id: string }>(
        "SELECT id FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, draft.result.id]))[0]!;
      await sessionFor(owner).revokeApproval(pending.id, {}, randomUUID());
      let move: (() => Promise<unknown>) | null = () => setAddress(contactId, "normalized_email", "between@haldenrowe.example");
      const db = database.db;
      const racing: typeof db = { ...db, tenant: async (tenant, work, options) => {
        const out = await db.tenant(tenant, work, options);
        const next = move; move = null;
        if (next) await next();
        return out;
      } };
      const owners = createSession({ ...deps(), db: racing }, { tenantId, actorId: owner });
      const error = await owners.approveReply(draft.result.id, { destination: email }, randomUUID()).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: "between@haldenrowe.example" } });
      expect(await rows<{ status: string; destination: string }>(
        "SELECT status, payload->>'destination' AS destination FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status IN ('pending','approved')",
        [tenantId, draft.result.id])).toEqual([{ status: "pending", destination: "between@haldenrowe.example" }]);
      expect(await reply(draft.result.id)).toMatchObject({ status: "draft" });
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
    });

    it("a call that withdrew the stale proposal but failed before proposing again finishes on retry", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      await setAddress(contactId, "normalized_email", "half@haldenrowe.example");
      // The read, then the withdrawal commit; the next transaction (the new proposal) fails once.
      let calls = 0;
      const db = database.db;
      const flaky: typeof db = { ...db, tenant: async (tenant, work, options) => {
        calls += 1;
        if (calls === 3) throw new Error("connection lost");
        return db.tenant(tenant, work, options);
      } };
      const key = randomUUID();
      const owners = createSession({ ...deps(), db: flaky }, { tenantId, actorId: owner });
      await expect(owners.approveReply(draft.result.id, {}, key)).rejects.toThrow();
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='revoked'", [tenantId, draft.result.id]))
        .toHaveLength(1);
      expect(await sessionFor(owner).approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", destination: "half@haldenrowe.example", approvalId: expect.any(String) } });
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, draft.result.id]))
        .toHaveLength(1);
    });

    it("after its own approval met a changed address, a call that failed before proposing again finishes on retry", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      // The address moves after the read; the transaction that proposes again fails once.
      let calls = 0;
      let failed = false;
      const db = database.db;
      const flaky: typeof db = { ...db, tenant: async (tenant, work, options) => {
        calls += 1;
        const revoked = (await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='revoked'", [tenantId, draft.result.id])).length > 0;
        if (revoked && !failed) { failed = true; throw new Error("connection lost"); }
        const out = await db.tenant(tenant, work, options);
        if (calls === 1) await setAddress(contactId, "normalized_email", "after@haldenrowe.example");
        return out;
      } };
      const key = randomUUID();
      const owners = createSession({ ...deps(), db: flaky }, { tenantId, actorId: owner });
      await expect(owners.approveReply(draft.result.id, {}, key)).rejects.toThrow("connection lost");
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status IN ('pending','approved')", [tenantId, draft.result.id]))
        .toHaveLength(0);
      expect(await sessionFor(owner).approveReply(draft.result.id, {}, key).then(() => null, (caught: unknown) => caught))
        .toMatchObject({ details: { reason: "destination_changed", destination: "after@haldenrowe.example", approvalId: expect.any(String) } });
      expect(await rows<{ destination: string }>(
        "SELECT payload->>'destination' AS destination FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'",
        [tenantId, draft.result.id])).toEqual([{ destination: "after@haldenrowe.example" }]);
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
    });

    it("an email cleared between the approve call's read and its run answers destination_changed and queues nothing", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      let move: (() => Promise<unknown>) | null = () => service((tx) => tx.query(
        "UPDATE crm_contacts SET normalized_email=NULL, e164_phone='+15555550143' WHERE tenant_id=$1 AND id=$2", [tenantId, contactId]));
      const db = database.db;
      const racing: typeof db = { ...db, tenant: async (tenant, work, options) => {
        const out = await db.tenant(tenant, work, options);
        const next = move; move = null;
        if (next) await next();
        return out;
      } };
      const owners = createSession({ ...deps(), db: racing }, { tenantId, actorId: owner });
      const error = await owners.approveReply(draft.result.id, {}, randomUUID()).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: null } });
      expect(await reply(draft.result.id)).toMatchObject({ status: "draft" });
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='approved'", [tenantId, draft.result.id]))
        .toHaveLength(0);
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
    });

    it("an approve that names another address than the customer's now records nothing and answers 409", async () => {
      const { contactId, email } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      const error = await sessionFor(owner).approveReply(draft.result.id, { destination: "stale@haldenrowe.example" }, randomUUID())
        .then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: email } });
      expect(await reply(draft.result.id)).toMatchObject({ status: "draft" });
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='approved'", [tenantId, draft.result.id]))
        .toHaveLength(0);
      const approved = await sessionFor(owner).approveReply(draft.result.id, { destination: email }, randomUUID());
      expect(approved.result.status).toBe("approved");
    });

    it("with no open proposal, one made for an old address is proposed again before any approval", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      const pending = (await rows<{ id: string }>(
        "SELECT id FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='pending'", [tenantId, draft.result.id]))[0]!;
      await sessionFor(owner).revokeApproval(pending.id, {}, randomUUID());
      await setAddress(contactId, "normalized_email", "later@haldenrowe.example");
      const error = await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID()).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "destination_changed", destination: "later@haldenrowe.example" } });
      expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND target_id=$2 AND status='approved'", [tenantId, draft.result.id]))
        .toHaveLength(0);
    });

    it("an email cleared after approval (phone kept) ends the send destination_changed, not no_address", async () => {
      const { contactId } = await customer();
      const { replyId } = await approvedReply(contactId);
      await service((tx) => tx.query("UPDATE crm_contacts SET normalized_email=NULL, e164_phone=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, contactId, "+15555550199"]));
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
      expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "destination_changed" });
    });

    it("an owner's own draft is bound the same way", async () => {
      const { contactId } = await customer();
      const draft = await sessionFor(owner).draftReply({ contactId, subject: "Your booking", body: "Mine." }, randomUUID());
      expect((await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID())).result.status).toBe("approved");
      await setAddress(contactId, "normalized_email", "owner-moved@haldenrowe.example");
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
      expect(await delivery(draft.result.id)).toMatchObject({ status: "blocked", final_reason: "destination_changed" });
    });

    it("a requester cannot name the address: the proposal stores the customer's", async () => {
      const { contactId, email } = await customer();
      const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body: "See you at 7." }, randomUUID());
      const out = await sessionFor(staff).requestApproval({
        action: { actionType: "inbox.reply.send", target: { type: "inbox_reply", id: draft.result.id },
          payload: { replyId: draft.result.id, destination: "attacker@evil.example" } },
        summary: "Send it",
      }, randomUUID());
      expect(out.result.payload).toEqual({ replyId: draft.result.id, destination: email });
    });

    it("a send event whose words or address differ from the approved ones is not approved (approval_missing)", async () => {
      // The last case leaves the customer's address alone: a forged address is not a changed one.
      const cases = [["body", "Words nobody approved.", false], ["destination", "elsewhere@haldenrowe.example", true],
        ["destination", "forged@haldenrowe.example", false]] as const;
      for (const [field, value, moved] of cases) {
        const { contactId } = await customer();
        const { replyId } = await approvedReply(contactId);
        if (moved) await setAddress(contactId, "normalized_email", value);
        await service((tx) => tx.query(
          `UPDATE outbox SET payload = jsonb_set(payload, ARRAY[$3::text], to_jsonb($4::text))
            WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId'=$2`, [tenantId, replyId, field, value]));
        await worker().runOnce();
        expect(provider.calls).toHaveLength(0);
        expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "approval_missing" });
      }
    });

    it("a revoked approval says approval_revoked even when the address also changed", async () => {
      const { contactId } = await customer();
      const { replyId, approvalId } = await approvedReply(contactId);
      await sessionFor(owner).revokeApproval(approvalId, { note: "Do not send" }, randomUUID());
      await setAddress(contactId, "normalized_email", "revoked-too@haldenrowe.example");
      await worker().runOnce();
      expect(provider.calls).toHaveLength(0);
      expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
    });

    it("a changed phone does not stop an email reply", async () => {
      const { contactId, email } = await customer();
      const { replyId } = await approvedReply(contactId);
      await setAddress(contactId, "e164_phone", "+15555550142");
      await worker().runOnce();
      expect(provider.delivered).toHaveLength(1);
      expect(provider.delivered[0]!.request).toMatchObject({ to: email });
      expect(await reply(replyId)).toMatchObject({ status: "sent" });
    });
  });

  it("never settles another tenant's reply from a worker pass over this tenant's deliveries", async () => {
    const { contactId } = await customer();
    const { replyId } = await approvedReply(contactId);
    await service((tx) => settleReplyDelivery(tx, fixture.b.tenantId, replyId, "sent", clock.now()));
    expect(await reply(replyId)).toEqual({ status: "approved", settled_at: null });
    await worker().runOnce();
    expect(await reply(replyId)).toMatchObject({ status: "sent" });
  });
});
