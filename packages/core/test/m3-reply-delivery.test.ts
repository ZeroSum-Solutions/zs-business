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

  it("never settles another tenant's reply from a worker pass over this tenant's deliveries", async () => {
    const { contactId } = await customer();
    const { replyId } = await approvedReply(contactId);
    await service((tx) => settleReplyDelivery(tx, fixture.b.tenantId, replyId, "sent", clock.now()));
    expect(await reply(replyId)).toEqual({ status: "approved", settled_at: null });
    await worker().runOnce();
    expect(await reply(replyId)).toMatchObject({ status: "sent" });
  });
});
