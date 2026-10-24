// Templated agent kinds and the standing approval of a message template (docs/requirements/agents.md
// G-19..G-21, approvals.md A-15) under the runtime role, through the real dispatcher and the real
// delivery worker. The clock is injected; each test works in its own 40-day period so earlier
// bookings fall out of every window. Models are fakes: no test reaches a vendor.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionError, type AgentKind, type MemberRole, type TemplatedKind } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  agentActorId,
  approvalForAction,
  approvalsFromRecords,
  createDeliveryWorker,
  createFakeProvider,
  createFakeTextModel,
  createSession,
  createTemplateSession,
  createTemplatedAgents,
  creditWallet,
  FAKE_MODEL_ID,
  FAKE_MODEL_PRICES,
  worstCase,
  type EdgeDependencies,
  type Session,
  type TemplatedAgents,
} from "../src/index.js";
import { suggestionRequest } from "../src/templates/suggest.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-02T00:00:00.000Z");
let now = START;
let period = 0;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let tenantB: string;
let resourceId: string;
let owner: string;
let staff: string;
let ownerB: string;

const BOOKING_LINK = "https://book.example.test/book/abc123";
const REVIEW_URL = "https://reviews.example.test/halden";
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });
const templatesFor = (actorId: string, tenant = tenantId) => createTemplateSession(deps(), { tenantId: tenant, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
  service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const suggestionModelCalls: unknown[] = [];
const agents = (suggestion = true): TemplatedAgents =>
  createTemplatedAgents(deps(), {
    maxCandidatesPerRun: 20,
    bookingLink: async () => BOOKING_LINK,
    ...(suggestion
      ? {
          suggestion: {
            model: createFakeTextModel("no_personal_data", (request) => {
              suggestionModelCalls.push(request.input);
              const review = (request.input as { kind?: string }).kind === "review_request";
              return { subject: "Your visit with {business_name}", body: review
                ? "Hi {customer_first_name}, how was {business_name}? {review_link}"
                : "Hi {customer_first_name}, see you {booking_start_local}. {booking_link}" };
            }),
          },
        }
      : {}),
  });

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

// Scenario helpers

interface Scenario { bookingId: string; contactId: string; startsAt: Date; endsAt: Date; base: number }
/** A confirmed booking with a linked customer. `hour` picks the slot so one test may book several. */
async function booked(opts: {
  hour?: number; email?: string | null; consent?: "granted" | "denied" | null; consentSource?: string; base?: number; contactId?: string;
} = {}): Promise<Scenario> {
  const base = opts.base ?? START + period * 40 * DAY;
  const startsAt = new Date(base + (opts.hour ?? 10) * HOUR);
  now = base + 8 * HOUR;
  const staffSession = sessionFor(staff);
  const bookingId = (await staffSession.createBooking({ resourceId, startsAt: startsAt.toISOString() }, randomUUID())).result.id;
  const email = opts.email === undefined ? `guest-${randomUUID().slice(0, 8)}@haldenrowe.example` : opts.email;
  const contactId = opts.contactId ?? (await staffSession.upsertContact(
    { displayName: "Ana Ruiz", ...(email ? { email } : { phone: "+15555550123" }) }, randomUUID())).result.contact.id;
  await staffSession.linkBookingContact(bookingId, { contactId, expectedRevision: 0 }, randomUUID());
  if (opts.consent && !opts.contactId)
    await service((tx) => tx.query(
      `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
       VALUES ($1,$2,'email'::crm_consent_channel,$3,$4,$5)`,
      [tenantId, contactId, opts.consent, opts.consentSource ?? "test", new Date(now)]));
  return { bookingId, contactId, startsAt, endsAt: new Date(startsAt.getTime() + HOUR), base };
}

async function enable(kind: TemplatedKind, over: { config?: Record<string, unknown>; quiet?: [number, number]; cost?: number } = {}) {
  const session = sessionFor(owner);
  const status = await session.getAgentKindStatus(kind);
  if (status.killed) await session.resumeAgentKind(kind, {}, randomUUID());
  const fresh = await session.getAgentKindStatus(kind);
  return session.updateAgentKindSettings(kind, {
    enabled: true, quietStartMinute: over.quiet?.[0] ?? 0, quietEndMinute: over.quiet?.[1] ?? 0, timeZone: "UTC",
    maxCostMicrosPerDay: over.cost ?? 1_000_000,
    config: over.config ?? (kind === "review_request" ? { reviewUrl: REVIEW_URL } : {}),
    expectedRevision: fresh.revision,
  }, randomUUID());
}

const REMINDER_BODY = "Hi {customer_first_name}, see you {booking_start_local} at {business_name}. Change it: {booking_link}";
const REVIEW_BODY = "Hi {customer_first_name}, thanks for visiting {business_name}. Review us: {review_link}";
async function write(kind: TemplatedKind, over: { body?: string; subject?: string | null; channel?: "email" | "sms"; timingHours?: number } = {}) {
  const templates = templatesFor(owner);
  const state = await templates.getTemplate(kind);
  const channel = over.channel ?? "email";
  return templates.createRevision(kind, {
    expectedRevision: state.currentRevision, channel,
    subject: channel === "sms" ? null : over.subject === undefined ? "A note from {business_name}" : over.subject,
    body: over.body ?? (kind === "appointment_reminder" ? REMINDER_BODY : REVIEW_BODY),
    timingHours: over.timingHours ?? 24,
  }, randomUUID());
}
async function approve(kind: TemplatedKind, over: { expiresInMinutes?: number } = {}) {
  const templates = templatesFor(owner);
  const state = await templates.getTemplate(kind);
  const revision = state.revisions[0]!;
  return templates.approveTemplate(kind, {
    revision: revision.revision, contentDigest: revision.contentDigest,
    ...(over.expiresInMinutes !== undefined ? { expiresInMinutes: over.expiresInMinutes } : {}),
  }, randomUUID());
}
/** Write a revision, approve it, turn the kind on. */
async function ready(kind: TemplatedKind, over: Parameters<typeof enable>[1] = {}) {
  await write(kind);
  const approved = await approve(kind);
  await enable(kind, over);
  return approved;
}
const runNow = (kind: TemplatedKind) => agents().runForMember({ tenantId, actorId: owner }, kind, {}, randomUUID());
const sendEvents = (...bookingIds: string[]) => rows<{ id: string; payload: { body: string; subject: string | null; messageId: string; channel: string; purpose: string } }>(
  `SELECT o.id, o.payload FROM outbox o
    WHERE o.tenant_id=$1 AND o.event_type='message.send_requested' AND o.payload->>'messageId' IN
      (SELECT d.message_id::text FROM agent_decisions d WHERE d.tenant_id=$1 AND d.subject_id = ANY($2::uuid[]) AND d.message_id IS NOT NULL)
    ORDER BY o.created_at, o.id`, [tenantId, bookingIds]);

const provider = createFakeProvider({ clock });
const worker = () => createDeliveryWorker({
  service, providers: { email: provider, sms: provider }, approvals: approvalsFromRecords(approvalForAction, clock),
  clock, generateId: randomUUID, report: () => undefined,
  config: {
    workerId: "templates", leaseMs: 60_000, providerTimeoutMs: 5_000, pricing: { currency: "usd", email: 2, smsSegment: 3 },
    unsubscribe: { secret: "unsubscribe-test-secret-0123456789abcdef", baseUrl: "https://api.example.test/public/v1/unsubscribe" },
  },
});
const deliveryOf = async (bookingId: string) => (await rows<{ message_id: string; status: string; final_reason: string | null }>(
  `SELECT md.message_id, md.status, md.final_reason FROM message_deliveries md
    WHERE md.tenant_id=$1 AND md.message_id IN
      (SELECT d.message_id FROM agent_decisions d WHERE d.tenant_id=$1 AND d.subject_id=$2 AND d.message_id IS NOT NULL)`, [tenantId, bookingId]))[0];

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  tenantB = fixture.b.tenantId;
  resourceId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
      [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
  });
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  ownerB = await addMember(tenantB, "owner");
  await creditWallet(
    // The wallet is a service-role write.
    { query: (sql: string, params?: unknown[]) => service((tx) => tx.query(sql, params)) } as unknown as Transaction,
    { tenantId, ledgerId: randomUUID(), amount: 100_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START) },
  ).catch(async () => {
    await service((tx) => creditWallet(tx, { tenantId, ledgerId: randomUUID(), amount: 100_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START) }));
  });
});
afterAll(async () => { await database?.close(); });
beforeEach(() => { period += 1; });

describe("revisions (G-19, A-15)", () => {
  it("numbers revisions from 1 and records the digest, variables and purpose", async () => {
    const first = await write("appointment_reminder");
    expect(first).toMatchObject({ agentKind: "appointment_reminder", purpose: "transactional", currentRevision: expect.any(Number) });
    const top = first.revisions[0]!;
    expect(top).toMatchObject({
      revision: first.currentRevision, current: true, channel: "email", approved: false, standing: null,
      variables: ["booking_link", "booking_start_local", "business_name", "customer_first_name"],
    });
    expect(top.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    const second = await write("appointment_reminder", { body: "See you {booking_start_local}, {customer_first_name}." });
    expect(second.currentRevision).toBe(first.currentRevision + 1);
    expect(second.revisions.slice(0, 2).map((r) => r.current)).toEqual([true, false]);
  });

  it("refuses a variable the kind does not have, and a stale expected revision", async () => {
    const state = await templatesFor(owner).getTemplate("review_request");
    const bad = await rejection(templatesFor(owner).createRevision("review_request", {
      expectedRevision: state.currentRevision, channel: "email", subject: "Hi", body: "Book again: {booking_link}", timingHours: 24,
    }, randomUUID()));
    expect(bad.code).toBe("ValidationFailed");
    await write("review_request");
    const stale = await rejection(templatesFor(owner).createRevision("review_request", {
      expectedRevision: state.currentRevision, channel: "email", subject: "Hi", body: REVIEW_BODY, timingHours: 24,
    }, randomUUID()));
    expect(stale).toMatchObject({ code: "Conflict", details: { reason: "stale_revision" } });
  });

  it("is for members with agents; staff cannot write or read it", async () => {
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    await expect(templatesFor(staff).createRevision("appointment_reminder", {
      expectedRevision: state.currentRevision, channel: "email", subject: "Hi", body: "Hello {customer_first_name}", timingHours: 24,
    }, randomUUID())).rejects.toBeInstanceOf(ActionError);
    await expect(templatesFor(staff).getTemplate("appointment_reminder")).rejects.toBeInstanceOf(ActionError);
  });

  it("keeps a revision as written: the runtime role cannot update or delete one", async () => {
    await write("appointment_reminder");
    for (const sql of [
      "UPDATE message_template_revisions SET body='changed' WHERE tenant_id=$1",
      "UPDATE message_template_revisions SET content_digest=repeat('a',64) WHERE tenant_id=$1",
      "DELETE FROM message_template_revisions WHERE tenant_id=$1",
      "DELETE FROM message_templates WHERE tenant_id=$1",
    ])
      await expect(database.db.tenant(tenantId, (tx) => tx.query(sql, [tenantId]))).rejects.toThrow(/permission denied/);
  });

  it("keeps two tenants apart", async () => {
    await write("appointment_reminder");
    const b = await templatesFor(ownerB, tenantB).getTemplate("appointment_reminder");
    expect(b.currentRevision).toBe(0);
    expect(b.revisions).toEqual([]);
    const seen = await database.db.tenant(tenantB, async (tx) =>
      (await tx.query("SELECT 1 FROM message_template_revisions")).rows.length +
      (await tx.query("SELECT 1 FROM message_templates")).rows.length);
    expect(seen).toBe(0);
    // Tenant B writes its own; tenant A's numbering is unaffected.
    const own = await templatesFor(ownerB, tenantB).createRevision("appointment_reminder", {
      expectedRevision: 0, channel: "email", subject: "Hi", body: "Hello {customer_first_name}", timingHours: 24,
    }, randomUUID());
    expect(own.currentRevision).toBe(1);
    expect((await templatesFor(owner).getTemplate("appointment_reminder")).currentRevision).toBeGreaterThan(1);
  });
});

describe("standing approval (A-15)", () => {
  it("is granted by an owner's approval and recorded on the revision", async () => {
    await write("appointment_reminder");
    const approved = await approve("appointment_reminder");
    expect(approved.execution.result).toMatchObject({ standingApprovalId: approved.approval.result.id });
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    expect(state.revisions[0]).toMatchObject({ approved: true, standing: { approvalId: approved.approval.result.id, standing: "approved", sends: 0 } });
    expect(approved.approval.result).toMatchObject({ actionType: "template.standing.grant", status: "approved" });
  });

  it("is not available to staff, who may not decide an approval", async () => {
    await write("appointment_reminder");
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    const revision = state.revisions[0]!;
    await expect(templatesFor(staff).approveTemplate("appointment_reminder", {
      revision: revision.revision, contentDigest: revision.contentDigest,
    }, randomUUID())).rejects.toBeInstanceOf(ActionError);
  });

  it("a new revision revokes the previous revision's pending and approved grants, noted superseded", async () => {
    await write("appointment_reminder");
    const approved = await approve("appointment_reminder");
    const first = (await templatesFor(owner).getTemplate("appointment_reminder")).revisions[0]!;
    // A second grant waits, undecided.
    const waiting = await sessionFor(owner).requestApproval({
      action: {
        actionType: "template.standing.grant", target: { type: "message_template_revision", id: first.id },
        payload: { templateId: (await templatesFor(owner).getTemplate("appointment_reminder")).templateId, revision: first.revision, contentDigest: first.contentDigest },
      },
      summary: "Wording, second grant",
    }, randomUUID());
    await write("appointment_reminder", { body: "New wording for {customer_first_name}." });
    for (const id of [approved.approval.result.id, waiting.result.id]) {
      const record = await sessionFor(owner).getApproval(id);
      expect(record).toMatchObject({ status: "revoked", revokeNote: "superseded", revokedBy: owner });
    }
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    expect(state.revisions.slice(0, 2).map((r) => [r.current, r.approved])).toEqual([[true, false], [false, false]]);
  });

  it("refuses a grant for a digest the owner did not see (template_changed) or a replaced revision (template_superseded)", async () => {
    await write("appointment_reminder");
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    const old = state.revisions[0]!;
    const wrongDigest = await rejection(templatesFor(owner).approveTemplate("appointment_reminder", {
      revision: old.revision, contentDigest: "0".repeat(64),
    }, randomUUID()));
    expect(wrongDigest).toMatchObject({ code: "Conflict", details: { reason: "template_changed" } });
    await write("appointment_reminder", { body: "Newer wording for {customer_first_name}." });
    const superseded = await rejection(templatesFor(owner).approveTemplate("appointment_reminder", {
      revision: old.revision, contentDigest: old.contentDigest,
    }, randomUUID()));
    expect(superseded).toMatchObject({ code: "Conflict", details: { reason: "template_superseded" } });
  });

  it("the grant action itself checks the digest and the revision under its locks", async () => {
    await write("appointment_reminder");
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    const old = state.revisions[0]!;
    const session = sessionFor(owner);
    // A request that names another digest is stored (it is only a proposal) but cannot run.
    const stale = await session.requestApproval({
      action: {
        actionType: "template.standing.grant", target: { type: "message_template_revision", id: old.id },
        payload: { templateId: state.templateId, revision: old.revision, contentDigest: "1".repeat(64) },
      },
      summary: "Wrong digest",
    }, randomUUID());
    const changed = await rejection(session.approveApproval(stale.result.id, {}, randomUUID()));
    expect(changed).toMatchObject({ code: "Conflict", details: { reason: "template_changed" } });
    // A proposal for the current revision becomes stale once a newer one is written.
    const proposal = await session.requestApproval({
      action: {
        actionType: "template.standing.grant", target: { type: "message_template_revision", id: old.id },
        payload: { templateId: state.templateId, revision: old.revision, contentDigest: old.contentDigest },
      },
      summary: "Right digest, replaced",
    }, randomUUID());
    await write("appointment_reminder", { body: "Newer wording for {customer_first_name}." });
    // The new revision revoked the pending proposal, so it cannot be approved at all.
    await expect(session.approveApproval(proposal.result.id, {}, randomUUID())).rejects.toBeInstanceOf(ActionError);
  });

  it("is not a direct action: a member cannot run the grant without an approval", async () => {
    await write("appointment_reminder");
    const state = await templatesFor(owner).getTemplate("appointment_reminder");
    const revision = state.revisions[0]!;
    // Writing a revision is direct; the grant has no direct path, so nothing records an approval.
    expect(revision.standing).toBeNull();
    expect(revision.approved).toBe(false);
  });
});

describe("appointment reminders (G-19)", () => {
  it("queues nothing until the revision is approved: the booking is skipped as template_not_approved", async () => {
    const s = await booked();
    await write("appointment_reminder");
    await enable("appointment_reminder");
    const run = await runNow("appointment_reminder");
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({ subjectId: s.bookingId, outcome: "skipped", reason: "template_not_approved", messageId: null });
    expect(await sendEvents(s.bookingId)).toHaveLength(0);
  });

  it("queues one rendered message with the recorded values, under the standing approval, as the kind's principal", async () => {
    const s = await booked();
    const approved = await ready("appointment_reminder");
    const run = await runNow("appointment_reminder");
    expect(run).toMatchObject({ status: "completed", stopReason: null });
    const decision = run.decisions.find((d) => d.subjectId === s.bookingId)!;
    expect(decision).toMatchObject({
      outcome: "queued", reason: null, agentKind: "appointment_reminder", subjectType: "booking", contactId: s.contactId,
      approvalId: approved.approval.result.id,
    });
    const events = await sendEvents(s.bookingId);
    expect(events).toHaveLength(1);
    const sent = events[0]!.payload;
    expect(sent).toMatchObject({ messageId: decision.messageId, channel: "email", purpose: "transactional", contactId: s.contactId });
    expect(sent.subject).toMatch(/^A note from /);
    expect(sent.body).toMatch(/^Hi Ana, see you \w{3}, \w{3} \d{1,2} at 10:00 AM at /);
    expect(sent.body).toContain(`Change it: ${BOOKING_LINK}`);
    expect(sent.body).not.toMatch(/[{}]/);
    const action = (await rows<{ actor_id: string; payload: { values: Record<string, string>; templateRevisionId: string; standingApprovalId: string } }>(
      "SELECT actor_id, payload FROM actions WHERE tenant_id=$1 AND action_type='agent.reminder.queue' AND payload->>'bookingId'=$2",
      [tenantId, s.bookingId]))[0]!;
    expect(action.actor_id).toBe(agentActorId(tenantId, "appointment_reminder"));
    expect(action.payload.standingApprovalId).toBe(approved.approval.result.id);
    expect(action.payload.values).toMatchObject({ customer_first_name: "Ana", booking_link: BOOKING_LINK });
    expect(Object.keys(action.payload.values).sort()).toEqual(["booking_link", "booking_start_local", "business_name", "customer_first_name"]);
    // The revision shows the send it covered.
    expect((await templatesFor(owner).getTemplate("appointment_reminder")).revisions[0]!.standing!.sends).toBe(1);
  });

  it("is delivered by the worker once, with the approved content", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    await runNow("appointment_reminder");
    now += 60_000;
    await worker().runOnce();
    const sent = provider.delivered.find((d) => d.request.text.includes(`${BOOKING_LINK}`))!.request;
    expect(sent.text).toContain("Hi Ana, see you");
    expect(await deliveryOf(s.bookingId)).toMatchObject({ status: "sent", final_reason: null });
    // A rerun of the agent queues nothing more for the same booking.
    now += 60_000;
    const again = await runNow("appointment_reminder");
    expect(again.decisions.filter((d) => d.subjectId === s.bookingId)).toHaveLength(0);
    expect(await sendEvents(s.bookingId)).toHaveLength(1);
  });

  it("sends one reminder per booking: the unique index refuses a second queued decision", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    const run = await runNow("appointment_reminder");
    const queued = run.decisions.find((d) => d.subjectId === s.bookingId)!;
    expect(queued.outcome).toBe("queued");
    await expect(service((tx) => tx.query(
      `INSERT INTO agent_decisions (tenant_id,id,run_id,agent_kind,subject_type,subject_id,contact_id,outcome,message_id,created_at)
       VALUES ($1,$2,$3,'appointment_reminder','booking',$4,$5,'queued',$6,$7)`,
      [tenantId, randomUUID(), run.id, s.bookingId, s.contactId, randomUUID(), new Date(now)],
    ))).rejects.toThrow(/agent_decisions_one_message/);
  });

  it("only considers bookings with a customer, inside the window, and not ones in the past", async () => {
    const withCustomer = await booked({ hour: 10 });
    const staffSession = sessionFor(staff);
    const bare = (await staffSession.createBooking({ resourceId, startsAt: new Date(withCustomer.base + 11 * HOUR).toISOString() }, randomUUID())).result.id;
    const far = (await staffSession.createBooking({ resourceId, startsAt: new Date(withCustomer.base + 3 * DAY + 11 * HOUR).toISOString() }, randomUUID())).result.id;
    await ready("appointment_reminder");
    const run = await runNow("appointment_reminder");
    expect(run.decisions.map((d) => d.subjectId)).toEqual([withCustomer.bookingId]);
    expect(run.decisions.some((d) => [bare, far].includes(d.subjectId))).toBe(false);
  });

  it("skips with a recorded reason when the customer has no address or opted out", async () => {
    const noAddress = await booked({ hour: 10, email: null });
    const denied = await booked({ hour: 11, base: noAddress.base, consent: "denied" });
    now = noAddress.base + 8 * HOUR;
    await ready("appointment_reminder");
    const run = await runNow("appointment_reminder");
    const reason = (id: string) => run.decisions.find((d) => d.subjectId === id)?.reason;
    expect(reason(noAddress.bookingId)).toBe("no_address");
    expect(reason(denied.bookingId)).toBe("consent_denied");
    expect(await sendEvents(noAddress.bookingId, denied.bookingId)).toHaveLength(0);
  });

  it("stops on quiet hours with no decision, and records the stop on the run", async () => {
    const s = await booked();
    await ready("appointment_reminder", { quiet: [7 * 60, 9 * 60] });
    const run = await runNow("appointment_reminder");
    expect(run).toMatchObject({ status: "stopped", stopReason: "quiet_hours" });
    expect(run.decisions.filter((d) => d.outcome === "queued")).toHaveLength(0);
    expect(await sendEvents(s.bookingId)).toHaveLength(0);
  });

  it("stops at the daily cap", async () => {
    const first = await booked({ hour: 10 });
    const second = await booked({ hour: 11, base: first.base });
    now = first.base + 8 * HOUR;
    await ready("appointment_reminder", { config: { maxSendsPerDay: 1 } });
    const run = await runNow("appointment_reminder");
    expect(run.stopReason).toBe("daily_cap");
    expect(run.decisions.filter((d) => d.outcome === "queued")).toHaveLength(1);
    expect(await sendEvents(first.bookingId)).toHaveLength(1);
    expect(await sendEvents(second.bookingId)).toHaveLength(0);
  });

  it("the kill switch and the disabled setting stop a run before any message", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    await sessionFor(owner).killAgentKind("appointment_reminder", {}, randomUUID());
    const killed = await runNow("appointment_reminder");
    expect(killed.stopReason).toBe("tenant_killed");
    expect(await sendEvents(s.bookingId)).toHaveLength(0);
    await sessionFor(owner).resumeAgentKind("appointment_reminder", {}, randomUUID());
    const resumed = await runNow("appointment_reminder");
    expect(resumed.decisions.filter((d) => d.outcome === "queued")).toHaveLength(1);
  });

  it("skips as template_not_approved once the approval has expired", async () => {
    const s = await booked({ hour: 15 });
    await write("appointment_reminder");
    await approve("appointment_reminder", { expiresInMinutes: 60 });
    await enable("appointment_reminder");
    now += 2 * HOUR;
    const run = await runNow("appointment_reminder");
    expect(run.decisions.find((d) => d.subjectId === s.bookingId)).toMatchObject({ outcome: "skipped", reason: "template_not_approved" });
    expect(await sendEvents(s.bookingId)).toHaveLength(0);
  });

  it("a new revision stops a queued message that was not yet delivered (approval_revoked)", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    await runNow("appointment_reminder");
    expect(await sendEvents(s.bookingId)).toHaveLength(1);
    await write("appointment_reminder", { body: "Different words for {customer_first_name}." });
    now += 60_000;
    await worker().runOnce();
    expect(await deliveryOf(s.bookingId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
  });

  it("an owner's revoke of the standing approval stops the queued message too", async () => {
    const s = await booked();
    const approved = await ready("appointment_reminder");
    await runNow("appointment_reminder");
    await sessionFor(owner).revokeApproval(approved.approval.result.id, { note: "Changed my mind" }, randomUUID());
    now += 60_000;
    await worker().runOnce();
    expect(await deliveryOf(s.bookingId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked" });
    expect(await sendEvents(s.bookingId)).toHaveLength(1);
  });

  it("does not send content that differs from the approved rendering (approval_missing)", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    await runNow("appointment_reminder");
    await service((tx) => tx.query(
      `UPDATE outbox SET payload = jsonb_set(payload, '{body}', '"A different message nobody approved."')
        WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId' IN
          (SELECT message_id::text FROM agent_decisions WHERE tenant_id=$1 AND subject_id=$2)`, [tenantId, s.bookingId]));
    now += 60_000;
    await worker().runOnce();
    expect(await deliveryOf(s.bookingId)).toMatchObject({ status: "blocked", final_reason: "approval_missing" });
  });

  it("holds the revision's own timing: a longer lead time reaches a booking further ahead", async () => {
    const s = await booked({ hour: 10 });
    now = s.base - 2 * DAY;
    await write("appointment_reminder", { timingHours: 72 });
    await approve("appointment_reminder");
    await enable("appointment_reminder");
    const run = await runNow("appointment_reminder");
    expect(run.decisions.find((d) => d.subjectId === s.bookingId)?.outcome).toBe("queued");
  });

  it("is refused to a tenant whose booking another tenant names: tenants stay apart", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    await enable("appointment_reminder");
    const runB = await createTemplatedAgents(deps(), { maxCandidatesPerRun: 20, bookingLink: async () => BOOKING_LINK })
      .runForMember({ tenantId: tenantB, actorId: ownerB }, "appointment_reminder", {}, randomUUID());
    expect(runB.decisions).toEqual([]);
    expect(await rows("SELECT 1 FROM agent_decisions WHERE tenant_id=$1 AND subject_id=$2", [tenantB, s.bookingId])).toHaveLength(0);
  });
});

describe("review requests (G-20)", () => {
  /** A booking that ended 26 hours before the clock. */
  async function ended(opts: Parameters<typeof booked>[0] = {}) {
    const s = await booked(opts);
    now = s.endsAt.getTime() + 26 * HOUR;
    return s;
  }

  it("queues a marketing message only with a granted marketing consent, with the review link", async () => {
    const consented = await ended({ hour: 10, consent: "granted" });
    const noConsent = await booked({ hour: 11, base: consented.base });
    await sessionFor(staff);
    now = consented.endsAt.getTime() + 26 * HOUR;
    const approved = await ready("review_request");
    const run = await runNow("review_request");
    expect(run.decisions.find((d) => d.subjectId === consented.bookingId)).toMatchObject({
      outcome: "queued", approvalId: approved.approval.result.id,
    });
    expect(run.decisions.find((d) => d.subjectId === noConsent.bookingId)).toMatchObject({ outcome: "skipped", reason: "consent_missing" });
    const sent = (await sendEvents(consented.bookingId))[0]!.payload;
    expect(sent).toMatchObject({ purpose: "marketing", channel: "email" });
    expect(sent.body).toContain(`Review us: ${REVIEW_URL}`);
  });

  it("is delivered with its unsubscribe link and the consent re-checked", async () => {
    const s = await ended({ consent: "granted" });
    await ready("review_request");
    await runNow("review_request");
    now += 60_000;
    await worker().runOnce();
    expect(await deliveryOf(s.bookingId)).toMatchObject({ status: "sent", final_reason: null });
    const sent = provider.delivered.find((d) => d.request.text.split(/\s+/).includes(REVIEW_URL))!.request;
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await sendEvents(s.bookingId)).toHaveLength(1);
  });

  it("a denied consent is a skip, and so is a missing one", async () => {
    const denied = await ended({ hour: 10, consent: "denied" });
    await ready("review_request");
    const run = await runNow("review_request");
    expect(run.decisions.find((d) => d.subjectId === denied.bookingId)).toMatchObject({ outcome: "skipped", reason: "consent_denied" });
  });

  it("a grant recorded by a phone call (twilio-voice:) never counts, at queue time or at delivery", async () => {
    const voice = await ended({ hour: 10, consent: "granted", consentSource: "twilio-voice:CA123" });
    await ready("review_request");
    const run = await runNow("review_request");
    expect(run.decisions.find((d) => d.subjectId === voice.bookingId)).toMatchObject({ outcome: "skipped", reason: "consent_missing" });
    expect(await sendEvents(voice.bookingId)).toHaveLength(0);

    // A real grant is queued; then the record is replaced by a voice grant before delivery.
    const web = await booked({ hour: 11, base: voice.base, consent: "granted", consentSource: "booking_page" });
    now = web.endsAt.getTime() + 26 * HOUR;
    const second = await runNow("review_request");
    expect(second.decisions.find((d) => d.subjectId === web.bookingId)?.outcome).toBe("queued");
    await service((tx) => tx.query(
      "UPDATE crm_contact_consent SET source='twilio-voice:CA999' WHERE tenant_id=$1 AND contact_id=$2", [tenantId, web.contactId]));
    now += 60_000;
    await worker().runOnce();
    expect(await deliveryOf(web.bookingId)).toMatchObject({ status: "blocked", final_reason: "consent_missing" });
  });

  it("asks a customer at most once in the contact window (contact_cap) and once per booking", async () => {
    const first = await booked({ hour: 10, consent: "granted" });
    // The same customer has a later booking too.
    const second = await booked({ hour: 12, base: first.base, contactId: first.contactId });
    now = second.endsAt.getTime() + 26 * HOUR;
    await ready("review_request");
    const run = await runNow("review_request");
    const outcomes = run.decisions.map((d) => [d.outcome, d.reason]);
    expect(outcomes.filter(([o]) => o === "queued")).toHaveLength(1);
    expect(outcomes).toContainEqual(["skipped", "contact_cap"]);
    const again = await runNow("review_request");
    expect(again.decisions.filter((d) => d.outcome === "queued")).toHaveLength(0);
    expect(await sendEvents(first.bookingId, second.bookingId)).toHaveLength(1);
  });

  it("does not ask too early, and not for a booking past the lookback", async () => {
    const recent = await booked({ hour: 10, consent: "granted" });
    now = recent.endsAt.getTime() + 2 * HOUR;
    await ready("review_request");
    expect((await runNow("review_request")).decisions).toHaveLength(0);
    now = recent.endsAt.getTime() + 9 * DAY;
    expect((await runNow("review_request")).decisions).toHaveLength(0);
  });
});

describe("turning kinds on (G-21)", () => {
  const settings = (revision: number, kind: AgentKind, config: Record<string, unknown>) => ({
    enabled: true, quietStartMinute: 0, quietEndMinute: 0, timeZone: "UTC", maxCostMicrosPerDay: 1_000_000, config, expectedRevision: revision,
  });

  it("refuses document_intake: kind_not_available", async () => {
    const status = await sessionFor(owner).getAgentKindStatus("document_intake");
    const refused = await rejection(sessionFor(owner).updateAgentKindSettings("document_intake", settings(status.revision, "document_intake", {}), randomUUID()));
    expect(refused).toMatchObject({ code: "Conflict", details: { reason: "kind_not_available" } });
    // Turning it off still works.
    const off = await sessionFor(owner).updateAgentKindSettings("document_intake", { ...settings(status.revision, "document_intake", {}), enabled: false }, randomUUID());
    expect(off.result.settings.enabled).toBe(false);
  });

  it("refuses review_request without a reviewUrl, and takes only an https one", async () => {
    const status = await sessionFor(owner).getAgentKindStatus("review_request");
    const missing = await rejection(sessionFor(owner).updateAgentKindSettings("review_request", settings(status.revision, "review_request", {}), randomUUID()));
    expect(missing.code).toBe("ValidationFailed");
    const insecure = await rejection(sessionFor(owner).updateAgentKindSettings("review_request", settings(status.revision, "review_request", { reviewUrl: "http://reviews.example.test/x" }), randomUUID()));
    expect(insecure.code).toBe("ValidationFailed");
    const ok = await sessionFor(owner).updateAgentKindSettings("review_request", settings(status.revision, "review_request", { reviewUrl: REVIEW_URL }), randomUUID());
    expect(ok.result.settings).toMatchObject({ enabled: true, config: { reviewUrl: REVIEW_URL } });
  });
});

describe("wording suggestions (G-19, G-15, G-18)", () => {
  const tenantName = async () => (await rows<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId]))[0]!.name;
  const actual = Math.ceil((120 * 350_000 + 60 * 750_000) / 1_000_000);

  it("sends the model only the business name, kind, channel and variables, and writes a call row without a run", async () => {
    await enable("appointment_reminder", { cost: 1_000_000 });
    suggestionModelCalls.length = 0;
    const key = randomUUID();
    const suggestion = await agents().suggest({ tenantId, actorId: owner }, "appointment_reminder", { channel: "email" }, key);
    expect(suggestion).toMatchObject({ agentKind: "appointment_reminder", channel: "email", costWarning: false });
    expect(suggestion.body).toContain("{customer_first_name}");
    expect(suggestionModelCalls).toEqual([{
      businessName: await tenantName(), kind: "appointment_reminder", channel: "email",
      variables: ["booking_link", "booking_start_local", "business_name", "customer_first_name"],
    }]);
    const calls = await rows<{ call_key: string; run_id: string | null; lane: string; outcome: string; cost_micros: string; model: string }>(
      "SELECT call_key, run_id, lane, outcome, cost_micros::text, model FROM agent_model_calls WHERE tenant_id=$1 AND call_key LIKE $2",
      [tenantId, `agent:appointment_reminder:suggestion:%${key}%`]);
    expect(calls).toEqual([{
      call_key: `agent:appointment_reminder:suggestion:member:${owner}:${key}:0`, run_id: null, lane: "no_personal_data",
      outcome: "ok", cost_micros: String(actual), model: FAKE_MODEL_ID,
    }]);
  });

  it("refuses at the daily cap before any provider call, and warns once at 80% as the kind's principal", async () => {
    const worst = worstCase(FAKE_MODEL_PRICES, FAKE_MODEL_ID, suggestionRequest(await tenantName(), "review_request", "email")).costMicros;
    // Room for one call at its worst case, and not for a second.
    await enable("review_request", { cost: worst + 5 });
    suggestionModelCalls.length = 0;
    await agents().suggest({ tenantId, actorId: owner }, "review_request", { channel: "email" }, randomUUID());
    expect(suggestionModelCalls).toHaveLength(1);
    const warned = await rows<{ actor_id: string; payload: { agentKind: string } }>(
      "SELECT actor_id, payload FROM actions WHERE tenant_id=$1 AND action_type='agent.cost.warn' AND payload->>'agentKind'='review_request' AND created_at >= $2",
      [tenantId, new Date(now - HOUR)]);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.actor_id).toBe(agentActorId(tenantId, "review_request"));
    expect(warned[0]!.actor_id).not.toBe(owner);

    const refused = await rejection(agents().suggest({ tenantId, actorId: owner }, "review_request", { channel: "email" }, randomUUID()));
    expect(refused).toMatchObject({ code: "Conflict", details: { reason: "cost_cap" } });
    expect(suggestionModelCalls).toHaveLength(1);
    // The refusal wrote no model call, and a refusal does not warn a second time that day.
    const count = await rows<{ n: number }>("SELECT count(*)::int AS n FROM agent_model_calls WHERE tenant_id=$1 AND agent_kind='review_request' AND call_key LIKE 'agent:review_request:suggestion:%' AND created_at > $2", [tenantId, new Date(now - HOUR)]);
    expect(count[0]!.n).toBe(1);
    expect(await rows("SELECT 1 FROM actions WHERE tenant_id=$1 AND action_type='agent.cost.warn' AND payload->>'agentKind'='review_request' AND created_at >= $2", [tenantId, new Date(now - HOUR)])).toHaveLength(1);
  });

  it("a suggestion's spend never stops a templated kind's run", async () => {
    await enable("appointment_reminder", { cost: 10 });
    const s = await booked();
    await write("appointment_reminder");
    await approve("appointment_reminder");
    await enable("appointment_reminder", { cost: 10 });
    const run = await runNow("appointment_reminder");
    expect(run.decisions.find((d) => d.subjectId === s.bookingId)?.outcome).toBe("queued");
  });

  it("is off without a configured model, needs the agents permission and refuses an unknown kind", async () => {
    await expect(agents(false).suggest({ tenantId, actorId: owner }, "appointment_reminder", { channel: "email" }, randomUUID())).rejects.toMatchObject({ code: "NotFound" });
    await expect(agents().suggest({ tenantId, actorId: staff }, "appointment_reminder", { channel: "email" }, randomUUID())).rejects.toBeInstanceOf(ActionError);
    await expect(agents().suggest({ tenantId, actorId: owner }, "inquiry_followup", { channel: "email" }, randomUUID())).rejects.toMatchObject({ code: "NotFound" });
  });

  it("a model on the personal-data lane is refused when the agents are created", () => {
    expect(() => createTemplatedAgents(deps(), {
      maxCandidatesPerRun: 5,
      suggestion: { model: createFakeTextModel("personal_data") as never },
    })).toThrow(/no_personal_data/);
  });

  it("an answer that breaks the kind's rules is a model_invalid conflict and still bills its call", async () => {
    await enable("appointment_reminder");
    const bad = createTemplatedAgents(deps(), {
      maxCandidatesPerRun: 5,
      suggestion: { model: createFakeTextModel("no_personal_data", () => ({ subject: "Hi", body: "Review us: {review_link}" })) },
    });
    const failed = await rejection(bad.suggest({ tenantId, actorId: owner }, "appointment_reminder", { channel: "email" }, randomUUID()));
    expect(failed).toMatchObject({ code: "Conflict", details: { reason: "model_invalid" } });
  });
});

describe("scheduled runs", () => {
  it("a scheduled slot runs each due tenant once and continues a repeated slot", async () => {
    const s = await booked();
    await ready("appointment_reminder");
    const { dueKindTenants } = await import("../src/index.js");
    const slot = new Date(now).toISOString();
    const due = await service((tx) => dueKindTenants(tx, "appointment_reminder", new Date(now), slot));
    expect(due.tenantIds).toContain(tenantId);
    const first = await agents().runScheduled("appointment_reminder", tenantId, slot);
    expect(first.decisions.find((d) => d.subjectId === s.bookingId)?.outcome).toBe("queued");
    const second = await agents().runScheduled("appointment_reminder", tenantId, slot);
    expect(second.id).toBe(first.id);
    expect(await sendEvents(s.bookingId)).toHaveLength(1);
    const after = await service((tx) => dueKindTenants(tx, "appointment_reminder", new Date(now), slot));
    expect(after.tenantIds).not.toContain(tenantId);
  });
});
