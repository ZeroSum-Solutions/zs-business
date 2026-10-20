// M2a owner/staff matrix, enforced in core: every action and read the edge session offers,
// run as an owner, a staff member and a signed-in stranger under the runtime role. M3 intake
// review is owner-only; the public principal runs the one public action and nothing else.
// M3b: owners decide approvals; source records need their subject's permission.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, TenantDenied, roleCan, type MemberRole, type Permission } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../src/edge/public-session.js";
import { ACTION_PERMISSIONS, PAYLOAD_PERMISSION_ACTIONS, createSession, type EdgeDependencies, type Session } from "../src/edge/session.js";
import { PUBLIC_REQUEST_ACTION } from "../src/intake/public-request.js";
import {
  AGENT_ACTIONS, agentHandlers, approvalHandlers, bookingHandlers, createDispatcher, crmHandlers, dealDetailsHandlers, inboxHandlers, intakeHandlers, memberHandlers,
  sourceHandlers, type DispatchContext,
} from "../src/index.js";

const NOW = "2026-10-19T08:00:00.000Z";
const clock = { now: () => new Date(NOW) };
/** Synthetic booking key secret, built at runtime so secret scanners do not flag a literal. */
const bookingKeys = { secret: ["test", "booking", "k".repeat(32)].join("-"), publicBaseUrl: "http://book.test" };

/** What each action needs, written out so a change to the map has to change this test too. */
const EXPECTED_ACTIONS: Record<string, Permission> = {
  "booking.create": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "crm.deal.set-details": "customers",
  "inbox.reply.draft": "inbox.drafts",
  "inbox.reply.discard": "inbox.drafts",
  "inbox.reply.send": "inbox.drafts",
  "inbox.reply.resume": "approve",
  "intake.item.link": "intake",
  "intake.item.reject": "intake",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
  "approval.approve": "approve",
  "approval.reject": "approve",
  "agent.settings.update": "agents",
  "agent.kill": "inbox.drafts",
  "agent.resume": "agents",
};

interface Tenant {
  tenantId: string;
  resourceId: string;
  pipelineId: string;
  stages: [string, string];
  ownerId: string;
  dealId: string;
  contactId: string;
  /** A published booking page over its own every-day resource, for website requests. */
  pageId: string;
  publicResourceId: string;
}

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenant: Tenant;

async function addMember(tenantId: string, role: MemberRole): Promise<{ userId: string; memberId: string }> {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, NOW],
  ));
  return { userId, memberId };
}

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID, bookingKeys });
const sessionFor = (actorId: string, tenantId = tenant.tenantId): Session => createSession(deps(), { tenantId, actorId });

/** Each website request takes the next free hour, from Tuesday 09:00 UTC. */
let publicSlot = 0;
/** A website request from a known email: a `possible_match` item the owner must review. */
async function intakeItem(): Promise<string> {
  const n = publicSlot++;
  const startsAt = `2026-10-${20 + Math.floor(n / 8)}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
  const reply = await createPublicSession(deps(), { tenantId: tenant.tenantId, pageId: tenant.pageId }).request({
    resourceId: tenant.publicResourceId, startsAt, name: "Ada", email: "ada@example.com",
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  return reply.requestId;
}

async function actionRows(tenantId: string, actorId: string): Promise<number> {
  return Number((await fixture.service((tx) => tx.query<{ n: string }>(
    "SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND actor_id=$2", [tenantId, actorId],
  ))).rows[0]!.n);
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  const tenantId = fixture.a.tenantId;
  const resourceId = randomUUID();
  const pipelineId = randomUUID();
  const stages: [string, string] = [randomUUID(), randomUUID()];
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`,
      [tenantId, resourceId, JSON.stringify([{ weekday: 1, windows: [{ startMinute: 540, endMinute: 1020 }] }])],
    );
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
    await tx.query(
      "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0),($1,$4,$3,'Won',1)",
      [tenantId, stages[0], pipelineId, stages[1]],
    );
  });
  const publicResourceId = randomUUID();
  const pageId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
      [tenantId, publicResourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [tenantId, pageId, NOW],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, publicResourceId]);
  });
  const owner = await addMember(tenantId, "owner");
  const ownerSession = createSession({ db: database.db, clock, generateId: randomUUID }, { tenantId, actorId: owner.userId });
  const contact = await ownerSession.upsertContact({ displayName: "Ada", email: "ada@example.com" }, randomUUID());
  const deal = await ownerSession.createDeal(
    { contactId: contact.result.contact.id, pipelineId, stageId: stages[0], title: "Ring" }, randomUUID());
  tenant = {
    tenantId, resourceId, pipelineId, stages, ownerId: owner.userId, dealId: deal.result.id, contactId: contact.result.contact.id,
    pageId, publicResourceId,
  };
});
afterAll(async () => { await database?.close(); });

/** Monday 09:00-17:00 UTC: each booking takes the next free hour. */
let hour = 9;

/** A draft by the owner, for steps any caller may then try on it. */
async function ownerDraft(): Promise<string> {
  return (await sessionFor(tenant.ownerId).draftReply({ contactId: tenant.contactId, body: "Thanks, see you soon." }, randomUUID())).result.id;
}

/** One call per session operation. Each builds fresh inputs, so it can run for any caller. */
function operations(session: Session): Record<string, { permission: Permission | null; run: () => Promise<unknown> }> {
  return {
    createBooking: { permission: "calendar", run: () => session.createBooking(
      { resourceId: tenant.resourceId, startsAt: `2026-10-19T${String(hour++).padStart(2, "0")}:00:00.000Z` }, randomUUID()) },
    upsertContact: { permission: "customers", run: () => session.upsertContact({ displayName: "Bo", email: `${randomUUID()}@example.com` }, randomUUID()) },
    createDeal: { permission: "customers", run: async () => {
      const contact = await sessionFor(tenant.ownerId).upsertContact({ email: `${randomUUID()}@example.com` }, randomUUID());
      return session.createDeal({ contactId: contact.result.contact.id, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], title: "Band" }, randomUUID());
    } },
    setDealDetails: { permission: "customers", run: async () => {
      const deals = await sessionFor(tenant.ownerId).listDeals({ limit: 100 });
      const current = deals.items.find((deal) => deal.id === tenant.dealId)!;
      return session.setDealDetails(tenant.dealId,
        { expectedRevision: current.revision, value: { amountMinor: 1_000, currency: "USD" }, leadSource: "referral" }, randomUUID());
    } },
    draftReply: { permission: "inbox.drafts", run: () => session.draftReply({ contactId: tenant.contactId, body: "Hello from the shop" }, randomUUID()) },
    approveReply: { permission: "approve", run: async () => session.approveReply(await ownerDraft(), {}, randomUUID()) },
    discardReply: { permission: "inbox.drafts", run: async () => session.discardReply(await ownerDraft(), {}, randomUUID()) },
    listThreads: { permission: "inbox.drafts", run: () => session.listThreads({}) },
    getThread: { permission: "inbox.drafts", run: async () => {
      await ownerDraft();
      return session.getThread(`c_${tenant.contactId}`);
    } },
    homeResults: { permission: "reports", run: () => session.homeResults({ zone: "America/New_York" }) },
    moveDealStage: { permission: "customers", run: async () => {
      const deals = await sessionFor(tenant.ownerId).listDeals({ limit: 100 });
      const current = deals.items.find((deal) => deal.id === tenant.dealId)!;
      const stageId = current.stageId === tenant.stages[0] ? tenant.stages[1] : tenant.stages[0];
      return session.moveDealStage(tenant.dealId, { pipelineId: tenant.pipelineId, stageId, expectedRevision: current.revision }, randomUUID());
    } },
    inviteMember: { permission: "members", run: () => session.inviteMember({ email: `${randomUUID()}@example.com`, role: "staff" }, randomUUID()) },
    changeMemberRole: { permission: "members", run: async () => {
      const target = await addMember(tenant.tenantId, "staff");
      return session.changeMemberRole(target.memberId, { role: "owner" }, randomUUID());
    } },
    removeMember: { permission: "members", run: async () => {
      const target = await addMember(tenant.tenantId, "staff");
      return session.removeMember(target.memberId, randomUUID());
    } },
    listBookings: { permission: "calendar", run: () => session.listBookings({}) },
    listResources: { permission: "calendar", run: () => session.listResources() },
    findSlots: { permission: "calendar", run: () => session.findSlots(
      { resourceId: tenant.resourceId, from: "2026-10-19T08:00:00.000Z", to: "2026-10-20T08:00:00.000Z" }) },
    listContacts: { permission: "customers", run: () => session.listContacts({}) },
    getContact: { permission: "customers", run: () => session.getContact(tenant.contactId) },
    listDeals: { permission: "customers", run: () => session.listDeals({}) },
    listPipelines: { permission: "customers", run: () => session.listPipelines() },
    listMembers: { permission: "members", run: () => session.listMembers() },
    getWallet: { permission: "billing", run: () => session.getWallet() },
    linkIntakeItem: { permission: "intake", run: async () => session.linkIntakeItem(await intakeItem(), { contactId: tenant.contactId }, randomUUID()) },
    rejectIntakeItem: { permission: "intake", run: async () => session.rejectIntakeItem(await intakeItem(), {}, randomUUID()) },
    listIntakeItems: { permission: "intake", run: () => session.listIntakeItems({}) },
    listBookingPages: { permission: "publish", run: () => session.listBookingPages() },
    me: { permission: null, run: () => session.me() },
    // M3b approvals: anyone may request what they may do; owners decide (approvals.md A-5, A-6).
    requestApproval: { permission: "calendar", run: () => session.requestApproval({ action: proposal(), summary: "Book" }, randomUUID()) },
    approveApproval: { permission: "approve", run: async () => session.approveApproval(await ownerProposal(true), {}, randomUUID()) },
    rejectApproval: { permission: "approve", run: async () => session.rejectApproval(await ownerProposal(), {}, randomUUID()) },
    revokeApproval: { permission: "approve", run: async () => session.revokeApproval(await ownerProposal(), {}, randomUUID()) },
    listApprovals: { permission: null, run: () => session.listApprovals({}) },
    // Another member's approval reads as NotFound to staff (A-11, approvals.test.ts); their own is visible.
    getApproval: { permission: "calendar", run: async () =>
      session.getApproval((await session.requestApproval({ action: proposal(), summary: "Mine" }, randomUUID())).result.id) },
    observeSource: { permission: "customers", run: () => session.observeSource(
      { subject: { type: "contact", id: tenant.contactId }, source: "owner" }, randomUUID()) },
    listSources: { permission: "customers", run: () => session.listSources({ subjectType: "contact", subjectId: tenant.contactId }) },
    // M6 follow-up agent: owners set it up and resume it; anyone who drafts may read it or stop it (agents.md G-11).
    getFollowUpStatus: { permission: "inbox.drafts", run: () => session.getFollowUpStatus() },
    updateFollowUpSettings: { permission: "agents", run: async () => {
      const { settings, revision } = await sessionFor(tenant.ownerId).getFollowUpStatus();
      return session.updateFollowUpSettings({ ...settings, expectedRevision: revision }, randomUUID());
    } },
    killFollowUp: { permission: "inbox.drafts", run: () => session.killFollowUp({ note: "Stop" }, randomUUID()) },
    resumeFollowUp: { permission: "agents", run: () => session.resumeFollowUp({}, randomUUID()) },
    listFollowUpRuns: { permission: "inbox.drafts", run: () => session.listFollowUpRuns({}) },
    getFollowUpRun: { permission: "inbox.drafts", run: async () => {
      const runId = randomUUID();
      await fixture.service((tx) => tx.query(
        "INSERT INTO agent_runs (tenant_id,id,started_at,finished_at,status) VALUES ($1,$2,$3,$3,'completed')", [tenant.tenantId, runId, NOW]));
      return session.getFollowUpRun(runId);
    } },
  };
}

/** A booking proposal; only one that will run needs a free hour (`next`). */
function proposal(next = false) {
  const bookingId = randomUUID();
  const startsAt = next ? `2026-10-19T${String(hour++).padStart(2, "0")}:00:00.000Z` : "2026-10-19T09:00:00.000Z";
  return { actionType: "booking.create", target: { type: "booking", id: bookingId }, payload: { bookingId, resourceId: tenant.resourceId, startsAt } };
}
/** A pending approval the tenant's owner asked for; only approvers may see or decide it. */
async function ownerProposal(next = false): Promise<string> {
  return (await sessionFor(tenant.ownerId).requestApproval({ action: proposal(next), summary: "Book" }, randomUUID())).result.id;
}

describe("permission map", () => {
  it("names a permission for every registered action, and only those", () => {
    // The public request is the one action no member session may run (public-intake.md P-1).
    // M3b: three actions take their permission from the payload (approvals.md A-8, A-9, F-2).
    const registered = Object.keys({
      ...bookingHandlers, ...crmHandlers, ...dealDetailsHandlers, ...inboxHandlers, ...intakeHandlers, ...memberHandlers,
      ...approvalHandlers, ...sourceHandlers, ...agentHandlers,
    })
      // M6: the agent's own run actions belong to the agent principal only (agents.md G-1).
      .filter((action) => action !== PUBLIC_REQUEST_ACTION && !PAYLOAD_PERMISSION_ACTIONS.includes(action) && !AGENT_ACTIONS.includes(action))
      .sort();
    expect([...PAYLOAD_PERMISSION_ACTIONS].sort()).toEqual(["approval.request", "approval.revoke", "source.observe"]);
    expect(Object.keys(ACTION_PERMISSIONS).sort()).toEqual(registered);
    expect(Object.keys(ACTION_PERMISSIONS)).not.toContain(PUBLIC_REQUEST_ACTION);
    for (const action of AGENT_ACTIONS) expect(Object.keys(ACTION_PERMISSIONS)).not.toContain(action);
    expect({ ...ACTION_PERMISSIONS }).toEqual(EXPECTED_ACTIONS);
  });

  it("leaves members, billing, plan, publish, intake review, approving, reports and agents to owners", () => {
    expect(ROLE_PERMISSIONS.staff).toEqual(["calendar", "customers", "inbox.drafts"]);
    for (const permission of ["members", "billing", "plan", "publish", "intake", "approve", "reports", "agents"] as const) {
      expect(roleCan("staff", permission)).toBe(false);
      expect(roleCan("owner", permission)).toBe(true);
    }
  });
});

describe("every session operation, per role", () => {
  it("covers every operation a session offers", () => {
    const session = sessionFor(randomUUID());
    const offered = Object.keys(session).filter((name) => typeof session[name as keyof Session] === "function");
    expect(Object.keys(operations(session)).sort()).toEqual(offered.sort());
  });

  for (const role of ["owner", "staff"] as const) {
    it(`${role}: allowed exactly where the role grants the permission`, async () => {
      const { userId } = await addMember(tenant.tenantId, role);
      const session = sessionFor(userId);
      for (const [name, operation] of Object.entries(operations(session))) {
        const allowed = operation.permission === null || roleCan(role, operation.permission);
        if (allowed) await expect(operation.run(), `${role} ${name}`).resolves.toBeDefined();
        else await expect(operation.run(), `${role} ${name}`).rejects.toBeInstanceOf(TenantDenied);
      }
      // Staff wrote calendar and customer actions, never a member action.
      const memberActions = Number((await fixture.service((tx) => tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND actor_id=$2 AND action_type LIKE 'member.%'", [tenant.tenantId, userId],
      ))).rows[0]!.n);
      expect(memberActions).toBe(role === "owner" ? 3 : 0);
    });
  }

  it("refuses a caller with no membership, and a member of another tenant, everything", async () => {
    const outsiders = [randomUUID(), (await addMember(fixture.b.tenantId, "owner")).userId];
    for (const actorId of outsiders) {
      for (const [name, operation] of Object.entries(operations(sessionFor(actorId))))
        await expect(operation.run(), name).rejects.toBeInstanceOf(TenantDenied);
      expect(await actionRows(tenant.tenantId, actorId)).toBe(0);
    }
  });

  it("re-reads the role on every call: a demoted owner loses member actions at once", async () => {
    const promoted = await addMember(tenant.tenantId, "owner");
    const session = sessionFor(promoted.userId);
    await expect(session.listMembers()).resolves.toBeDefined();
    await sessionFor(tenant.ownerId).changeMemberRole(promoted.memberId, { role: "staff" }, randomUUID());
    await expect(session.listMembers()).rejects.toBeInstanceOf(TenantDenied);
    await expect(session.inviteMember({ email: `${randomUUID()}@example.com`, role: "owner" }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(session.listContacts({})).resolves.toBeDefined();
  });
});

describe("member handlers", () => {
  it("refuse staff even when dispatched without the edge's authorize hook", async () => {
    const staff = await addMember(tenant.tenantId, "staff");
    const target = await addMember(tenant.tenantId, "staff");
    const dispatch = createDispatcher({ ...memberHandlers });
    const key = randomUUID();
    const command = {
      actionType: "member.change-role",
      target: { tenantId: tenant.tenantId, type: "member", id: target.memberId },
      approvalReference: { tenantId: tenant.tenantId, id: randomUUID() },
      idempotencyKey: key,
      payload: { memberId: target.memberId, role: "owner" },
    } as const;
    const { idempotencyKey: _key, ...fields } = command;
    const ctx: DispatchContext = {
      tenantId: tenant.tenantId,
      actor: { id: staff.userId, tenantId: tenant.tenantId },
      db: database.db,
      clock,
      config: {},
      generateId: randomUUID,
      resolveApproval: async () => ({ ...fields, tenantId: tenant.tenantId, actorId: staff.userId }),
    };
    await expect(dispatch(ctx, command)).rejects.toBeInstanceOf(TenantDenied);
    const roles = await fixture.service((tx) => tx.query<{ role: string }>(
      "SELECT role::text AS role FROM tenant_members WHERE tenant_id=$1 AND id=$2", [tenant.tenantId, target.memberId]));
    expect(roles.rows[0]?.role).toBe("staff");
  });
});
