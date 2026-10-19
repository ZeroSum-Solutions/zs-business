// M2a owner/staff matrix, enforced in core: every action and read the edge session offers,
// run as an owner, a staff member and a signed-in stranger under the runtime role.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, TenantDenied, roleCan, type MemberRole, type Permission } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { ACTION_PERMISSIONS, createSession, type Session } from "../src/edge/session.js";
import { bookingHandlers, createDispatcher, crmHandlers, memberHandlers, type DispatchContext } from "../src/index.js";

const NOW = "2026-10-19T08:00:00.000Z";
const clock = { now: () => new Date(NOW) };

/** What each action needs, written out so a change to the map has to change this test too. */
const EXPECTED_ACTIONS: Record<string, Permission> = {
  "booking.create": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
};

interface Tenant {
  tenantId: string;
  resourceId: string;
  pipelineId: string;
  stages: [string, string];
  ownerId: string;
  dealId: string;
  contactId: string;
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

const sessionFor = (actorId: string, tenantId = tenant.tenantId): Session =>
  createSession({ db: database.db, clock, generateId: randomUUID }, { tenantId, actorId });

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
  const owner = await addMember(tenantId, "owner");
  const ownerSession = createSession({ db: database.db, clock, generateId: randomUUID }, { tenantId, actorId: owner.userId });
  const contact = await ownerSession.upsertContact({ displayName: "Ada", email: "ada@example.com" }, randomUUID());
  const deal = await ownerSession.createDeal(
    { contactId: contact.result.contact.id, pipelineId, stageId: stages[0], title: "Ring" }, randomUUID());
  tenant = { tenantId, resourceId, pipelineId, stages, ownerId: owner.userId, dealId: deal.result.id, contactId: contact.result.contact.id };
});
afterAll(async () => { await database?.close(); });

/** Monday 09:00-17:00 UTC: each booking takes the next free hour. */
let hour = 9;

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
    me: { permission: null, run: () => session.me() },
  };
}

describe("permission map", () => {
  it("names a permission for every registered action, and only those", () => {
    const registered = Object.keys({ ...bookingHandlers, ...crmHandlers, ...memberHandlers }).sort();
    expect(Object.keys(ACTION_PERMISSIONS).sort()).toEqual(registered);
    expect({ ...ACTION_PERMISSIONS }).toEqual(EXPECTED_ACTIONS);
  });

  it("leaves members, billing, plan and publish to owners", () => {
    expect(ROLE_PERMISSIONS.staff).toEqual(["calendar", "customers", "inbox.drafts"]);
    for (const permission of ["members", "billing", "plan", "publish"] as const) expect(roleCan("staff", permission)).toBe(false);
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
