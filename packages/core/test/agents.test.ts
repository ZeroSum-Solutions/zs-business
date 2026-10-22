// M6 inquiry follow-up agent (docs/requirements/agents.md G-1..G-12) under the runtime role:
// the agent drafts through the Inbox's draft and approval records and never sends; only an
// owner's approval sends, through the real delivery worker. Caps hold under concurrent runs, a
// kill stops new drafts at once, quiet hours follow the tenant's zone, opted-out customers are
// skipped before the model sees them, and tenants stay apart. The clock is injected; each test
// starts a month after the last, so earlier inquiries fall out of the lookback window.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionError, TenantDenied, type ActionCommand, type FollowUpPrompt, type FollowUpSettings, type MemberRole } from "@zs/contracts";
import { asService, DatabaseUnavailable, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  agentActorId,
  agentAuthorize,
  approvalForAction,
  approvalsFromRecords,
  createDeliveryWorker,
  createFakeFollowUpModel,
  createFakeProvider,
  createFollowUpAgent,
  createPublicSession,
  createSession,
  creditWallet,
  directDispatch,
  followUpRunId,
  inQuietHours,
  memberAuthorize,
  runFollowUps,
  setGlobalAgentSwitch,
  settleReplyDelivery,
  type EdgeDependencies,
  type FakeFollowUpModel,
  type Session,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Tuesday 2026-10-20 12:00 UTC; each test moves a month on from here. */
const START = Date.parse("2026-10-20T12:00:00.000Z");
let epoch = START;
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let pageId: string;
let resourceId: string;
let owner: string;
let staff: string;
let ownerB: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const agent = (model: FakeFollowUpModel, maxCandidatesPerRun = 50) => createFollowUpAgent(deps(), { model, maxCandidatesPerRun });

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

/** A website request now, booking the next free hour three weeks out. */
let slot = 0;
async function inquiry(input: { name?: string; email?: string; notes?: string | null; phone?: string | null } = {}) {
  // A request from a known address waits for the owner to link it (public-intake.md P-7).
  const known = input.email === undefined ? null
    : (await rows<{ id: string }>("SELECT id FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [tenantId, input.email]))[0]?.id ?? null;
  const n = slot++;
  const day = new Date(Math.floor(now / DAY) * DAY + (21 + Math.floor(n / 8)) * DAY);
  const startsAt = new Date(day.getTime() + (9 + (n % 8)) * HOUR).toISOString();
  const email = input.email ?? `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`;
  const reply = await createPublicSession(deps(), { tenantId, pageId }).request({
    resourceId, startsAt, name: input.name ?? "Halden Guest", email, phone: input.phone ?? null, notes: input.notes ?? "Do you have parking?",
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  if (known) await sessionFor(owner).linkIntakeItem(reply.requestId, { contactId: known }, randomUUID());
  const item = (await rows<{ contact_id: string }>("SELECT contact_id FROM intake_items WHERE tenant_id=$1 AND id=$2", [tenantId, reply.requestId]))[0]!;
  return { itemId: reply.requestId, contactId: item.contact_id, email };
}

/** Owners set the settings; every test starts from these with the agent on and not killed. */
const BASE: FollowUpSettings = {
  enabled: true, maxDraftsPerDay: 10, maxDraftsPerContact: 1, contactWindowHours: 168, waitHours: 24, lookbackDays: 14,
  quietStartMinute: 21 * 60, quietEndMinute: 8 * 60, timeZone: "UTC",
};
async function configure(settings: Partial<FollowUpSettings> = {}) {
  const session = sessionFor(owner);
  const status = await session.getFollowUpStatus();
  if (status.killed) await session.resumeFollowUp({}, randomUUID());
  return (await session.updateFollowUpSettings({ ...BASE, ...settings, expectedRevision: status.revision }, randomUUID())).result;
}

const decisions = (runId: string) => rows<{ intake_item_id: string; outcome: string; reason: string | null; reply_id: string | null }>(
  "SELECT intake_item_id, outcome, reason, reply_id FROM agent_followups WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at, id", [tenantId, runId]);
const sendEvents = (replyId: string) => rows(
  "SELECT 1 FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId'=$2", [tenantId, replyId]);
const agentDraftsSince = async (since: number) => Number((await rows<{ n: string }>(
  "SELECT count(*)::text AS n FROM agent_followups WHERE tenant_id=$1 AND outcome='drafted' AND created_at >= $2", [tenantId, new Date(since)]))[0]!.n);

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  resourceId = randomUUID();
  pageId = randomUUID();
  for (const tenant of [fixture.a.tenantId, fixture.b.tenantId]) {
    const resource = tenant === tenantId ? resourceId : randomUUID();
    const page = tenant === tenantId ? pageId : randomUUID();
    await fixture.service(async (tx) => {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
        [tenant, resource, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
      );
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
        [tenant, page, new Date(START)]);
      await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenant, page, resource]);
    });
  }
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
});
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  epoch += 30 * DAY;
  now = epoch;
  slot = 0;
  await configure();
  await service((tx) => setGlobalAgentSwitch(tx, { killed: false, now: clock.now() }));
});

/** Make inquiries now, then move past the wait so they are due. */
async function dueInquiries(count: number) {
  const made = [];
  for (let i = 0; i < count; i += 1) made.push(await inquiry({ name: `Guest ${i}` }));
  now += 25 * HOUR;
  return made;
}

describe("drafts but never sends (G-6, G-12)", () => {
  it("leaves an agent draft with a pending proposal; nothing is sent until an owner approves, then once", async () => {
    const { itemId, contactId, email } = await inquiry({ name: "Mara Quill", notes: "Can I bring my dog?" });
    now += 25 * HOUR;
    const model = createFakeFollowUpModel();
    const run = await agent(model).runForMember({ tenantId, actorId: owner }, {}, randomUUID());
    expect(run).toMatchObject({ status: "completed", stopReason: null, considered: 1, drafted: 1, skipped: 0, requestedBy: owner });
    const [decision] = run.decisions;
    expect(decision).toMatchObject({ intakeItemId: itemId, contactId, outcome: "drafted", reason: null });

    // G-9: the model saw this inquiry and nothing about other customers.
    expect(model.prompts).toEqual([{
      businessName: "Tenant A", customerName: "Mara Quill", requestedAt: new Date(now - 25 * HOUR).toISOString(),
      notes: "Can I bring my dog?", booking: { startsAt: expect.any(String), endsAt: expect.any(String), timeZone: "UTC" },
    } satisfies FollowUpPrompt]);
    expect(JSON.stringify(model.prompts)).not.toContain(email);

    const replyId = decision!.replyId!;
    const reply = (await rows<{ status: string; drafted_by: string; subject: string }>(
      "SELECT status, drafted_by, subject FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, replyId]))[0]!;
    expect(reply).toEqual({ status: "draft", drafted_by: agentActorId(tenantId), subject: "Following up from Tenant A" });
    const approval = (await sessionFor(owner).getApproval(decision!.approvalId!));
    expect(approval).toMatchObject({
      actionType: "inbox.reply.send", target: { type: "inbox_reply", id: replyId }, payload: { replyId },
      status: "pending", requestedBy: agentActorId(tenantId),
    });
    // The Inbox shows it as a waiting draft in the customer's thread.
    const thread = await sessionFor(owner).getThread(`c_${contactId}`);
    expect(thread.drafts).toBe(1);

    // Nothing to deliver: no send event exists, and the worker finds nothing.
    expect(await sendEvents(replyId)).toHaveLength(0);
    expect(await rows("SELECT 1 FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND processed_at IS NULL", [tenantId])).toHaveLength(0);
    const provider = createFakeProvider({ clock });
    await service((tx) => creditWallet(tx, { tenantId, ledgerId: randomUUID(), amount: 100, idempotencyKey: `credit:${randomUUID()}`, now: clock.now() }));
    const worker = createDeliveryWorker({
      service, providers: { email: provider, sms: provider }, approvals: approvalsFromRecords(approvalForAction, clock),
      onSettled: async (tx, tenant, messageId, outcome, at) => { await settleReplyDelivery(tx, tenant, messageId, outcome, at); },
      clock, generateId: randomUUID, report: () => undefined,
      config: {
        workerId: "m6", leaseMs: 60_000, providerTimeoutMs: 5_000, pricing: { currency: "usd", email: 2, smsSegment: 3 },
        unsubscribe: { secret: "unsubscribe-test-secret-0123456789abcdef", baseUrl: "https://api.example.test/public/v1/unsubscribe" },
      },
    });
    expect(await worker.runOnce()).toMatchObject({ ingested: 0, claimed: 0 });
    expect(provider.calls).toHaveLength(0);

    // The owner approves: the owner is the send's actor, and the worker delivers it once.
    now += 60_000;
    const approved = await sessionFor(owner).approveReply(replyId, {}, randomUUID());
    expect(approved.result).toMatchObject({ status: "approved", approvedBy: { userId: owner } });
    expect(await sendEvents(replyId)).toHaveLength(1);
    now += 60_000;
    expect(await worker.runOnce()).toMatchObject({ ingested: 1, claimed: 1, results: [{ outcome: "sent" }] });
    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]!.request).toMatchObject({ to: email, subject: "Following up from Tenant A" });
    now += 60_000;
    expect(await worker.runOnce()).toMatchObject({ ingested: 0, claimed: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("staff cannot approve an agent draft, and the agent principal can neither approve nor send", async () => {
    await dueInquiries(1);
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    const { replyId, approvalId } = run.decisions[0]!;
    await expect(sessionFor(staff).approveReply(replyId!, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(staff).approveApproval(approvalId!, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);

    const actor = agentActorId(tenantId);
    const asAgent = directDispatch(deps(), tenantId, actor, agentAuthorize);
    const key = randomUUID();
    const approvalReference = { tenantId, id: randomUUID() };
    await expect(asAgent({ actionType: "approval.approve", target: { tenantId, type: "approval", id: approvalId! }, approvalReference,
      idempotencyKey: key, payload: { approvalId: approvalId! } })).rejects.toBeInstanceOf(TenantDenied);
    await expect(asAgent({ actionType: "inbox.reply.send", target: { tenantId, type: "inbox_reply", id: replyId! }, approvalReference,
      idempotencyKey: `${key}-send`, payload: { replyId: replyId! } })).rejects.toBeInstanceOf(TenantDenied);
    // Members cannot run the agent's own actions either (G-1).
    const asOwner = directDispatch(deps(), tenantId, owner, memberAuthorize(tenantId, owner));
    await expect(asOwner({ actionType: "agent.run.start", target: { tenantId, type: "agent_run", id: randomUUID() }, approvalReference,
      idempotencyKey: `${key}-start`, payload: { runId: randomUUID(), requestedBy: owner, maxDecisions: 3 } })).rejects.toBeInstanceOf(TenantDenied);
    // Staff cannot start a run.
    await expect(agent(createFakeFollowUpModel()).runForMember({ tenantId, actorId: staff }, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);

    expect((await sessionFor(owner).getApproval(approvalId!)).status).toBe("pending");
    expect(await sendEvents(replyId!)).toHaveLength(0);
  });

  it("an owner can discard an agent draft, which withdraws its proposal", async () => {
    await dueInquiries(1);
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    const { replyId, approvalId } = run.decisions[0]!;
    await sessionFor(owner).discardReply(replyId!, {}, randomUUID());
    expect((await sessionFor(owner).getApproval(approvalId!)).status).toBe("revoked");
    // The inquiry has its one agent draft; another run leaves it alone.
    now += HOUR;
    const again = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(again).toMatchObject({ considered: 0, drafted: 0 });
  });
});

describe("skips (G-7, G-8)", () => {
  it("skips suppressed, consent-denied and address-less customers without showing them to the model", async () => {
    const suppressed = await inquiry({ name: "Suppressed Sam" });
    const denied = await inquiry({ name: "Denied Dee" });
    const noEmail = await inquiry({ name: "Phone Only Pat", phone: "+15555550123" });
    const fine = await inquiry({ name: "Fine Fay" });
    await service(async (tx) => {
      await tx.query("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'unsubscribe','test',$3)",
        [tenantId, suppressed.email, clock.now()]);
      await tx.query(
        `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at) VALUES ($1,$2,'email','denied','test',$3)
         ON CONFLICT (tenant_id,contact_id,channel) DO UPDATE SET status='denied'`, [tenantId, denied.contactId, clock.now()]);
      await tx.query("UPDATE crm_contacts SET normalized_email=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, noEmail.contactId]);
    });
    now += 25 * HOUR;
    const model = createFakeFollowUpModel();
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ status: "completed", considered: 4, drafted: 1, skipped: 3 });
    const byItem = new Map((await decisions(run.id)).map((row) => [row.intake_item_id, row]));
    expect(byItem.get(suppressed.itemId)).toMatchObject({ outcome: "skipped", reason: "suppressed", reply_id: null });
    expect(byItem.get(denied.itemId)).toMatchObject({ outcome: "skipped", reason: "consent_denied" });
    expect(byItem.get(noEmail.itemId)).toMatchObject({ outcome: "skipped", reason: "no_email" });
    expect(byItem.get(fine.itemId)).toMatchObject({ outcome: "drafted" });
    expect(model.prompts.map((prompt) => prompt.customerName)).toEqual(["Fine Fay"]);
  });

  it("leaves answered, too-young and too-old inquiries alone, and only follows up a customer's latest request", async () => {
    const old = await inquiry({ name: "Old Ollie" });
    now += 15 * DAY;
    const answered = await inquiry({ name: "Answered Ann" });
    const repeat = await inquiry({ name: "Repeat Rae" });
    now += HOUR;
    const latest = await inquiry({ name: "Repeat Rae", email: repeat.email });
    expect(latest.contactId).toBe(repeat.contactId);
    await sessionFor(staff).draftReply({ contactId: answered.contactId, body: "We have parking out back." }, randomUUID());
    now += 25 * HOUR;
    const young = await inquiry({ name: "Young Yan" });
    const model = createFakeFollowUpModel();
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(run.decisions.map((decision) => decision.intakeItemId)).toEqual([latest.itemId]);
    for (const skipped of [old, answered, repeat, young]) expect(run.decisions.some((d) => d.intakeItemId === skipped.itemId)).toBe(false);
  });

  it("skips a customer whose address is under the reserved .invalid name", async () => {
    const reserved = await inquiry({ name: "Reserved Rory", email: `rory-${randomUUID().slice(0, 8)}@example.invalid` });
    now += 25 * HOUR;
    const model = createFakeFollowUpModel();
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(run.decisions).toEqual([expect.objectContaining({ intakeItemId: reserved.itemId, outcome: "skipped", reason: "no_email" })]);
    expect(model.prompts).toHaveLength(0);
  });

  it("skips an inquiry the customer followed with a newer one while the model wrote, and drafts for the newer one later", async () => {
    const first = await inquiry({ name: "Lio Marsh" });
    now += 25 * HOUR;
    let newer: Awaited<ReturnType<typeof inquiry>> | undefined;
    // The customer asks again, and the owner links it, while the model writes about the first request.
    const model = createFakeFollowUpModel(async () => {
      now += 60_000;
      newer = await inquiry({ name: "Lio Marsh", email: first.email });
      return { subject: "Hello", body: "Checking in." };
    });
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(newer!.contactId).toBe(first.contactId);
    expect(run.decisions).toEqual([expect.objectContaining({ intakeItemId: first.itemId, outcome: "skipped", reason: "superseded" })]);
    expect(await rows("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND contact_id=$2", [tenantId, first.contactId])).toHaveLength(0);
    // The newer request is the one followed up once it is due.
    now += 25 * HOUR;
    const later = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(later.decisions).toEqual([expect.objectContaining({ intakeItemId: newer!.itemId, outcome: "drafted" })]);
  });

  it("records model errors and invalid answers and goes on", async () => {
    const [broken, empty, fine] = await dueInquiries(3);
    const model = createFakeFollowUpModel((prompt) => {
      if (prompt.customerName === "Guest 0") throw new Error("model down");
      if (prompt.customerName === "Guest 1") return { subject: "Hi", body: "   " };
      return { subject: "  Hello again  ", body: "  Checking in.  " };
    });
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ drafted: 1, skipped: 2 });
    const byItem = new Map(run.decisions.map((decision) => [decision.intakeItemId, decision]));
    expect(byItem.get(broken!.itemId)?.reason).toBe("model_error");
    expect(byItem.get(empty!.itemId)?.reason).toBe("model_invalid");
    const reply = (await rows<{ subject: string; body: string }>("SELECT subject, body FROM inbox_replies WHERE tenant_id=$1 AND id=$2",
      [tenantId, byItem.get(fine!.itemId)!.replyId]))[0];
    expect(reply).toEqual({ subject: "Hello again", body: "Checking in." });
  });
  it("puts undecided inquiries ahead of ones already skipped, so lasting skips cannot fill every batch", async () => {
    const stuck = [await inquiry({ name: "Suppressed Sid" }), await inquiry({ name: "Suppressed Sue" })];
    await service(async (tx) => {
      for (const item of stuck)
        await tx.query("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'unsubscribe','test',$3)",
          [tenantId, item.email, clock.now()]);
    });
    now += 25 * HOUR;
    const first = await agent(createFakeFollowUpModel(), 2).runScheduled(tenantId, randomUUID());
    expect(first).toMatchObject({ considered: 2, drafted: 0, skipped: 2 });

    // A newer, sendable inquiry arrives; with a batch of two, the next run reaches it first.
    const fresh = await inquiry({ name: "Fresh Fern" });
    now += 25 * HOUR;
    const second = await agent(createFakeFollowUpModel(), 2).runScheduled(tenantId, randomUUID());
    // Decisions in one run share a time, so find them by inquiry rather than by position.
    expect(second).toMatchObject({ considered: 2, drafted: 1, skipped: 1 });
    expect(second.decisions.find((d) => d.outcome === "drafted")?.intakeItemId).toBe(fresh.itemId);
    // The skip it still had room for went to one of the stuck two; the next goes to the other.
    const skippedAgain = second.decisions.find((d) => d.outcome === "skipped")!.intakeItemId;
    const third = await agent(createFakeFollowUpModel(), 1).runScheduled(tenantId, randomUUID());
    expect(third.decisions.map((d) => d.intakeItemId)).toEqual([stuck.find((item) => item.itemId !== skippedAgain)!.itemId]);
  });
});

describe("caps (G-4)", () => {
  it("holds the daily cap across concurrent runs", async () => {
    await configure({ maxDraftsPerDay: 3 });
    const made = await dueInquiries(8);
    const since = now;
    const runs = await Promise.all(Array.from({ length: 4 }, () => agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID())));
    expect(await agentDraftsSince(since)).toBe(3);
    expect(runs.reduce((sum, run) => sum + run.drafted, 0)).toBe(3);
    // No inquiry got two drafts, and every run ended on the cap or ran out of work.
    const drafted = await rows<{ intake_item_id: string }>(
      "SELECT intake_item_id FROM agent_followups WHERE tenant_id=$1 AND outcome='drafted' AND created_at >= $2", [tenantId, new Date(since)]);
    expect(new Set(drafted.map((row) => row.intake_item_id)).size).toBe(3);
    expect(drafted.every((row) => made.some((item) => item.itemId === row.intake_item_id))).toBe(true);
    for (const run of runs) expect(run.status === "completed" || run.stopReason === "daily_cap").toBe(true);
    expect(runs.some((run) => run.stopReason === "daily_cap")).toBe(true);
    expect((await sessionFor(owner).getFollowUpStatus())).toMatchObject({ canDraft: false, blockedBy: "daily_cap" });

    // The cap is a rolling day: a day later there is room again.
    now += DAY + 1;
    const later = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(later.drafted).toBe(3);
  });

  it("holds the per-customer cap inside its window", async () => {
    await configure({ maxDraftsPerContact: 1, contactWindowHours: 72 });
    const first = await inquiry({ name: "Kai" });
    now += 25 * HOUR;
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(run.drafted).toBe(1);
    await sessionFor(owner).discardReply(run.decisions[0]!.replyId!, {}, randomUUID());
    // The customer asks again; inside the window the agent leaves them alone.
    const second = await inquiry({ name: "Kai", email: first.email });
    now += 25 * HOUR;
    const capped = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(capped.decisions).toEqual([expect.objectContaining({ intakeItemId: second.itemId, outcome: "skipped", reason: "contact_cap" })]);
    now += 48 * HOUR;
    const after = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(after.decisions).toEqual([expect.objectContaining({ intakeItemId: second.itemId, outcome: "drafted" })]);
  });

  it("stops at maxCandidatesPerRun", async () => {
    await dueInquiries(3);
    const run = await agent(createFakeFollowUpModel(), 2).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ considered: 2, drafted: 2 });
  });

  it("counts a draft that committed with a later time than the check's own", async () => {
    // Two runs' clocks can disagree, so another draft can commit with a later time than a
    // check's own. Here the later draft commits first, then a run reads an
    // earlier time: the daily cap of one must still hold.
    await configure({ maxDraftsPerDay: 1 });
    await dueInquiries(2);
    const later = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(later).toMatchObject({ drafted: 1, stopReason: "daily_cap" });
    now -= 30 * 60_000;
    const earlier = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(earlier).toMatchObject({ drafted: 0, stopReason: "daily_cap" });
  });

  it("counts a customer's draft that committed with a later time than the check's own", async () => {
    await configure({ maxDraftsPerContact: 1, contactWindowHours: 72 });
    const start = now;
    const first = await inquiry({ name: "Kai" });
    now = start + 25 * HOUR;
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(run.drafted).toBe(1);
    await sessionFor(owner).discardReply(run.decisions[0]!.replyId!, {}, randomUUID());
    // A second request from Kai, stamped before that draft; then a run whose time is still before it.
    now = start + 30 * 60_000;
    const second = await inquiry({ name: "Kai", email: first.email });
    now = start + 24 * HOUR + 31 * 60_000;
    const capped = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(capped.decisions).toEqual([expect.objectContaining({ intakeItemId: second.itemId, outcome: "skipped", reason: "contact_cap" })]);
  });

  it("a run that fails mid-way stays open, and its retry decides only what is left of the limit", async () => {
    await dueInquiries(4);
    const real = directDispatch(deps(), tenantId, agentActorId(tenantId), agentAuthorize);
    let drafts = 0;
    // The second draft's write is lost (a dropped connection, say).
    const flaky = async (command: ActionCommand) => {
      if (command.actionType === "agent.followup.draft" && ++drafts === 2) throw new DatabaseUnavailable("connect");
      return real(command);
    };
    const reports: unknown[] = [];
    const key = `schedule:${randomUUID()}`;
    const run = (dispatch: typeof real) => runFollowUps({
      db: database.db, clock, model: createFakeFollowUpModel(), config: { maxCandidatesPerRun: 2 },
      dispatch, report: (event) => reports.push(event.error),
    }, tenantId, { key, requestedBy: null });

    await expect(run(flaky)).rejects.toBeInstanceOf(DatabaseUnavailable);
    expect(reports).toEqual([expect.any(DatabaseUnavailable)]);
    const open = (await rows<{ id: string; status: string }>(
      "SELECT id, status FROM agent_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1", [tenantId]))[0]!;
    expect(open.status).toBe("running");
    expect(await decisions(open.id)).toHaveLength(1);

    // The retry continues the same run and stops at two decisions, not two more.
    const resumed = await run(real);
    expect(resumed).toMatchObject({ id: open.id, status: "completed", considered: 2, drafted: 2 });
    expect(await agentDraftsSince(now - 25 * HOUR)).toBe(2);
  });

  it("two overlapping calls on one run decide no more than its limit together", async () => {
    await dueInquiries(4);
    const real = directDispatch(deps(), tenantId, agentActorId(tenantId), agentAuthorize);
    const key = `schedule:${randomUUID()}`;
    const reports: unknown[] = [];
    const run = (db: typeof database.db, dispatch: typeof real) => runFollowUps({
      db, clock, model: createFakeFollowUpModel(), config: { maxCandidatesPerRun: 2 }, dispatch,
      report: (event) => reports.push(event.error),
    }, tenantId, { key, requestedBy: null });
    const gate = () => { let open!: () => void; return { done: new Promise<void>((resolve) => { open = resolve; }), open: () => open() }; };
    const bReadRun = gate();
    const aDecided = gate();
    const bCheckedFirst = gate();
    const aDecidedTwice = gate();
    // B starts once A has started the run; this settles when B does.
    let startSecond!: (run: Promise<unknown>) => void;
    const second = new Promise<unknown>((resolve) => { startSecond = resolve; });
    // B reads the run before A records anything, then picks its inquiries after A's first decision,
    // with a limit of two still in mind. B then finds A's second inquiry undecided, and A drafts it
    // before B's checks, so B's skip meets A's decision.
    let bReads = 0;
    const bDb: typeof database.db = {
      ...database.db,
      tenant: async (tenant, work) => {
        const read = ++bReads;
        if (read === 2) await aDecided.done;
        if (read === 4) await aDecidedTwice.done;
        const result = await database.db.tenant(tenant, work);
        if (read === 1) bReadRun.open();
        if (read === 3) bCheckedFirst.open();
        return result;
      },
    };
    let aDecisions = 0;
    const aDispatch = async (command: ActionCommand) => {
      const decision = command.actionType === "agent.followup.draft" || command.actionType === "agent.followup.skip";
      if (decision && aDecisions === 0) await bReadRun.done;
      if (decision && aDecisions === 1) await bCheckedFirst.done;
      // A closes the run only after B is done, so B's stale limit has every chance to overshoot.
      if (command.actionType === "agent.run.finish") await second.catch(() => undefined);
      const result = await real(command);
      if (command.actionType === "agent.run.start") startSecond(run(bDb, real));
      if (decision && ++aDecisions === 1) aDecided.open();
      if (decision && aDecisions === 2) aDecidedTwice.open();
      return result;
    };

    const settled = await Promise.allSettled([run(database.db, aDispatch), second]);
    const runId = followUpRunId(tenantId, key);
    expect(await decisions(runId)).toHaveLength(2);
    expect(await agentDraftsSince(now - 25 * HOUR)).toBe(2);
    expect(reports).toEqual([]);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await sessionFor(owner).getFollowUpRun(runId)).toMatchObject({ status: "completed", considered: 2, drafted: 2 });
  });
});

describe("kill switches (G-3)", () => {
  it("a tenant kill stops runs; staff may kill, only owners resume", async () => {
    await dueInquiries(2);
    const killed = await sessionFor(staff).killFollowUp({ note: "Wrong tone" }, randomUUID());
    expect(killed.result).toMatchObject({ canDraft: false, blockedBy: "tenant_killed", killed: { by: staff, note: "Wrong tone" } });
    const model = createFakeFollowUpModel();
    const stopped = await agent(model).runScheduled(tenantId, randomUUID());
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "tenant_killed", considered: 0 });
    expect(model.prompts).toHaveLength(0);
    await expect(sessionFor(staff).resumeFollowUp({}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await sessionFor(owner).resumeFollowUp({}, randomUUID());
    expect(await agent(model).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "completed", drafted: 2 });
  });

  it("a kill that commits while a draft is being written refuses that draft", async () => {
    await dueInquiries(2);
    // The kill lands while the model is writing the first draft: that draft must not commit.
    const model = createFakeFollowUpModel(async () => {
      if (model.prompts.length === 1) await sessionFor(staff).killFollowUp({}, randomUUID());
      return { subject: "Hello", body: "Checking in." };
    });
    const run = await agent(model).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ status: "stopped", stopReason: "tenant_killed", drafted: 0, skipped: 1 });
    expect(run.decisions).toEqual([expect.objectContaining({ outcome: "skipped", reason: "tenant_killed" })]);
    expect(model.prompts).toHaveLength(1);
    expect(await rows("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND drafted_by=$2 AND created_at >= $3",
      [tenantId, agentActorId(tenantId), new Date(now)])).toHaveLength(0);
  });

  it("no draft commits after a kill has answered, however many runs are in flight", async () => {
    await configure({ maxDraftsPerDay: 200 });
    await dueInquiries(16);
    const since = now;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const model = () => createFakeFollowUpModel(async () => {
      started += 1;
      await gate;
      return { subject: "Hello", body: "Checking in." };
    });
    const runs = Array.from({ length: 4 }, () => agent(model()).runScheduled(tenantId, randomUUID()));
    while (started < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    while ((await agentDraftsSince(since)) < 1) await new Promise((resolve) => setTimeout(resolve, 2));
    await sessionFor(owner).killFollowUp({}, randomUUID());
    const atKill = await agentDraftsSince(since);
    const finished = await Promise.all(runs);
    expect(atKill).toBeGreaterThanOrEqual(1);
    expect(await agentDraftsSince(since)).toBe(atKill);
    for (const run of finished) expect(run.status === "completed" || run.stopReason === "tenant_killed").toBe(true);
  });

  it("the global switch stops every tenant", async () => {
    await dueInquiries(1);
    await service((tx) => setGlobalAgentSwitch(tx, { killed: true, note: "Incident", now: clock.now() }));
    expect(await sessionFor(owner).getFollowUpStatus()).toMatchObject({ globalKilled: true, canDraft: false, blockedBy: "global_killed" });
    expect(await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "stopped", stopReason: "global_killed" });
    await service((tx) => setGlobalAgentSwitch(tx, { killed: false, now: clock.now() }));
    expect(await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "completed", drafted: 1 });
  });

  it("a tenant that never turned the agent on gets nothing", async () => {
    await configure({ enabled: false });
    await dueInquiries(1);
    expect(await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "stopped", stopReason: "disabled" });
    // Tenant B has no settings row at all: the defaults, agent off.
    expect(await sessionFor(ownerB, fixture.b.tenantId).getFollowUpStatus()).toMatchObject({ revision: 0, canDraft: false, blockedBy: "disabled" });
  });
});

describe("quiet hours (G-5)", () => {
  it("follows the tenant's zone, across midnight", () => {
    const settings = { ...BASE, timeZone: "America/New_York", quietStartMinute: 21 * 60, quietEndMinute: 8 * 60 };
    expect(inQuietHours(settings, new Date("2026-10-21T00:59:00Z"))).toBe(false); // 20:59 EDT
    expect(inQuietHours(settings, new Date("2026-10-21T01:00:00Z"))).toBe(true); // 21:00 EDT
    expect(inQuietHours(settings, new Date("2026-10-21T11:59:00Z"))).toBe(true); // 07:59 EDT
    expect(inQuietHours(settings, new Date("2026-10-21T12:00:00Z"))).toBe(false); // 08:00 EDT
    // After the DST change, the same local hours are an hour later in UTC.
    expect(inQuietHours(settings, new Date("2026-11-10T01:30:00Z"))).toBe(false); // 20:30 EST
    expect(inQuietHours(settings, new Date("2026-11-10T02:00:00Z"))).toBe(true); // 21:00 EST
    expect(inQuietHours({ ...settings, quietStartMinute: 600, quietEndMinute: 600 }, new Date("2026-10-21T14:00:00Z"))).toBe(false);
    expect(inQuietHours({ ...settings, timeZone: "UTC", quietStartMinute: 9 * 60, quietEndMinute: 17 * 60 }, new Date("2026-10-21T16:59:00Z"))).toBe(true);
  });

  it("runs in quiet hours stop without drafting", async () => {
    await configure({ timeZone: "America/New_York" });
    await dueInquiries(1);
    now = Math.floor(now / DAY) * DAY + DAY + 2 * HOUR; // 22:00 or 21:00 local
    const model = createFakeFollowUpModel();
    expect(await agent(model).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "stopped", stopReason: "quiet_hours" });
    expect(model.prompts).toHaveLength(0);
    now += 12 * HOUR; // mid-morning local
    expect(await agent(model).runScheduled(tenantId, randomUUID())).toMatchObject({ status: "completed", drafted: 1 });
  });

  it("checks quiet hours against the clock read after the settings lock: a wait into them is refused", async () => {
    await dueInquiries(1);
    now = Math.floor(now / DAY) * DAY + DAY + 21 * HOUR - 60_000; // 20:59 UTC, a minute before quiet hours
    // While the model writes, another writer takes the settings row (the superuser pool), so the
    // draft waits on that lock; quiet hours begin during the wait.
    let release = async () => {};
    let held!: (pid: number) => void;
    const holderPid = new Promise<number>((resolve) => { held = resolve; });
    const model = createFakeFollowUpModel(async () => {
      const holder = await database.pool.connect();
      release = async () => { release = async () => {}; await holder.query("ROLLBACK"); holder.release(); };
      await holder.query("BEGIN");
      held((await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM agent_settings WHERE tenant_id=$1 FOR UPDATE", [tenantId])).rows[0]!.pid);
      return { subject: "Hello", body: "Checking in." };
    });
    try {
      const run = agent(model).runScheduled(tenantId, randomUUID()).then((value) => value, (error: unknown) => error);
      const pid = await holderPid;
      for (let tries = 0; ; tries += 1) {
        const { rowCount } = await database.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND $1::int = ANY(pg_blocking_pids(pid))`, [pid]);
        if (rowCount) break;
        if (tries > 500) throw new Error("the draft never waited on the settings lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      now += 60_000; // 21:00 UTC
      await release();
      expect(await run).toMatchObject({ status: "stopped", stopReason: "quiet_hours", drafted: 0 });
      expect(model.prompts).toHaveLength(1);
      expect(await rows("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND drafted_by=$2 AND created_at >= $3",
        [tenantId, agentActorId(tenantId), new Date(now - 60_000)])).toHaveLength(0);
    } finally {
      await release();
    }
  });
});

describe("the draft's instant (G-5)", () => {
  it("records a draft, its action and its event at the instant read after the draft's locks", async () => {
    await dueInquiries(1);
    // Every read in a dispatch is a second after the last, so its first read and the draft's differ.
    let at = now;
    const real = directDispatch({ ...deps(), clock: { now: () => new Date((at += 1_000)) } }, tenantId, agentActorId(tenantId), agentAuthorize);
    const drafts: { command: ActionCommand; output: Awaited<ReturnType<typeof real>> }[] = [];
    const dispatch = async (command: ActionCommand) => {
      const output = await real(command);
      if (command.actionType === "agent.followup.draft") drafts.push({ command, output });
      return output;
    };
    const run = await runFollowUps({ db: database.db, clock, model: createFakeFollowUpModel(), config: { maxCandidatesPerRun: 1 }, dispatch },
      tenantId, { key: `schedule:${randomUUID()}`, requestedBy: null });
    expect(run).toMatchObject({ status: "completed", drafted: 1 });
    expect(drafts).toHaveLength(1);
    const { command, output } = drafts[0]!;
    const stamps = await rows<Record<string, Date>>(
      `SELECT x.created_at AS action_at, o.created_at AS event_at, f.created_at AS decision_at, r.created_at AS reply_at, a.requested_at
         FROM actions x JOIN outbox o ON o.tenant_id=x.tenant_id AND o.action_id=x.id
         JOIN agent_followups f ON f.tenant_id=x.tenant_id AND f.id::text=x.payload->>'followupId'
         JOIN inbox_replies r ON r.tenant_id=f.tenant_id AND r.id=f.reply_id
         JOIN approvals a ON a.tenant_id=f.tenant_id AND a.id=f.approval_id
        WHERE x.tenant_id=$1 AND x.id=$2`, [tenantId, output.actionId]);
    expect(stamps).toHaveLength(1);
    const { action_at: actionAt, ...stored } = stamps[0]!;
    for (const value of Object.values(stored)) expect(value).toEqual(actionAt);
    // A replay returns the stored decision and writes nothing more.
    expect(await real(command)).toEqual(output);
    expect(await rows("SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, command.idempotencyKey])).toHaveLength(1);
  });
});

describe("settings (G-2)", () => {
  it("compare-and-set on the revision, and validated values", async () => {
    const session = sessionFor(owner);
    const status = await session.getFollowUpStatus();
    const saved = await session.updateFollowUpSettings({ ...status.settings, maxDraftsPerDay: 5, expectedRevision: status.revision }, randomUUID());
    expect(saved.result).toMatchObject({ revision: status.revision + 1, settings: { maxDraftsPerDay: 5 } });
    const stale = await rejection(session.updateFollowUpSettings({ ...status.settings, expectedRevision: status.revision }, randomUUID()));
    expect(stale).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: status.revision + 1 } });
    for (const bad of [{ maxDraftsPerDay: 0 }, { quietStartMinute: 1440 }, { timeZone: "Mars/Olympus" }, { timeZone: "EST" }]) {
      const invalid = await rejection(session.updateFollowUpSettings({ ...status.settings, ...bad, expectedRevision: status.revision + 1 }, randomUUID()));
      expect(invalid.code, JSON.stringify(bad)).toBe("ValidationFailed");
    }
    await expect(sessionFor(staff).updateFollowUpSettings({ ...status.settings, expectedRevision: status.revision + 1 }, randomUUID()))
      .rejects.toBeInstanceOf(TenantDenied);
    // Server keys are reserved: a member cannot take an agent step's key.
    expect(await rejection(session.killFollowUp({}, `agent:start:${randomUUID()}`))).toMatchObject({ code: "ValidationFailed" });
  });

  it("two first saves at once: one wins, the other is a stale_revision with the new revision", async () => {
    await service((tx) => tx.query("DELETE FROM agent_settings WHERE tenant_id=$1", [tenantId]));
    // Both saves read revision 0 before either inserts the row.
    let arrived = 0;
    let bothRead!: () => void;
    const barrier = new Promise<void>((resolve) => { bothRead = resolve; });
    const db: typeof database.db = {
      ...database.db,
      tenant: (tenant, work) => database.db.tenant(tenant, (tx) => work(new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver);
          return async (sql: string, params?: unknown[]) => {
            if (typeof sql === "string" && sql.includes("INSERT INTO agent_settings (enabled")) {
              if (++arrived === 2) bothRead();
              await barrier;
            }
            return target.query(sql, params);
          };
        },
      }))),
    };
    const session = createSession({ ...deps(), db }, { tenantId, actorId: owner });
    const saves = await Promise.allSettled([5, 6].map((maxDraftsPerDay) =>
      session.updateFollowUpSettings({ ...BASE, maxDraftsPerDay, expectedRevision: 0 }, randomUUID())));
    expect(saves.map((save) => save.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = saves.find((save) => save.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 1 } });
    expect(await sessionFor(owner).getFollowUpStatus()).toMatchObject({ revision: 1 });
  });
});

describe("runs are recorded and replay (G-6, G-10)", () => {
  it("a repeated run key continues the same run without asking the model again", async () => {
    await dueInquiries(2);
    const model = createFakeFollowUpModel();
    const key = randomUUID();
    const first = await agent(model).runForMember({ tenantId, actorId: owner }, {}, key);
    const again = await agent(model).runForMember({ tenantId, actorId: owner }, {}, key);
    expect(again).toEqual(first);
    expect(model.prompts).toHaveLength(2);
    const page = await sessionFor(staff).listFollowUpRuns({ limit: 1 });
    expect(page.items).toEqual([expect.objectContaining({ id: first.id, drafted: 2 })]);
    const next = await sessionFor(staff).listFollowUpRuns({ limit: 1, cursor: page.nextCursor! });
    expect(next.items[0]?.id).not.toBe(first.id);
    expect(await sessionFor(staff).getFollowUpRun(first.id)).toEqual(first);
  });

  it("the runtime role can close a running run once, and cannot reopen or rewrite a closed one", async () => {
    await dueInquiries(1);
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ status: "completed", drafted: 1 });
    const rewrites = [
      "UPDATE agent_runs SET status='running', finished_at=NULL, considered=999, drafted=999, skipped=999 WHERE tenant_id=$1 AND id=$2",
      "UPDATE agent_runs SET drafted=0 WHERE tenant_id=$1 AND id=$2",
      "UPDATE agent_runs SET status='stopped', stop_reason='daily_cap' WHERE tenant_id=$1 AND id=$2",
    ];
    for (const sql of rewrites)
      await expect(fixture.a.run((tx) => tx.query(sql, [tenantId, run.id])), sql).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_guard" });
    expect(await sessionFor(owner).getFollowUpRun(run.id)).toEqual(run);
  });
});

describe("two tenants (G-10)", () => {
  it("a tenant's runs, settings and inquiries stay its own", async () => {
    await dueInquiries(1);
    const run = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    const b = sessionFor(ownerB, fixture.b.tenantId);
    await expect(b.getFollowUpRun(run.id)).rejects.toMatchObject({ code: "NotFound" });
    expect((await b.listFollowUpRuns({})).items.some((item) => item.id === run.id)).toBe(false);

    // Tenant B's agent, turned on, finds none of tenant A's inquiries.
    const bStatus = await b.getFollowUpStatus();
    await b.updateFollowUpSettings({ ...BASE, expectedRevision: bStatus.revision }, randomUUID());
    const fresh = await inquiry({ name: "Only In A" });
    now += 25 * HOUR;
    const bModel = createFakeFollowUpModel();
    const bRun = await agent(bModel).runScheduled(fixture.b.tenantId, randomUUID());
    expect(bRun).toMatchObject({ considered: 0, drafted: 0 });
    expect(bModel.prompts).toHaveLength(0);

    // Tenant B's agent cannot draft for tenant A's inquiry by naming it.
    const bTenant = fixture.b.tenantId;
    const asAgentB = directDispatch(deps(), bTenant, agentActorId(bTenant), agentAuthorize);
    const followupId = randomUUID();
    await expect(asAgentB({
      actionType: "agent.followup.draft", target: { tenantId: bTenant, type: "agent_followup", id: followupId },
      approvalReference: { tenantId: bTenant, id: randomUUID() }, idempotencyKey: randomUUID(),
      payload: { followupId, runId: bRun.id, intakeItemId: fresh.itemId, contactId: fresh.contactId, replyId: randomUUID(),
        approvalId: randomUUID(), subject: "Hi", body: "Hello" },
    })).rejects.toBeInstanceOf(TenantDenied);
    // And the runtime role in tenant B sees none of tenant A's agent rows.
    for (const table of ["agent_settings", "agent_runs", "agent_followups"]) {
      const seen = await fixture.b.run(async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [tenantId])).rowCount);
      expect(seen, table).toBe(0);
    }
    // Tenant A's own agent still drafts for it.
    expect(await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID())).toMatchObject({ drafted: 1 });
  });
});
