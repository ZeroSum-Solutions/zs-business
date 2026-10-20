// M3b approval record (docs/requirements/approvals.md), under the runtime role: request,
// decide, run once, revoke, expiry against the injected clock, visibility, two tenants.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Conflict, NotFound, TenantDenied, ValidationFailed, type ActionCommand, type MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  ACTION_PERMISSIONS,
  approvalForAction,
  approvalHandlers,
  approvalPolicy,
  approvedDispatch,
  bookingHandlers,
  checkApproval,
  createDispatcher,
  createSession,
  directDispatch,
  memberAuthorize,
  resolveStoredApproval,
  type DispatchContext,
  type EdgeDependencies,
  type Session,
} from "../src/index.js";

const START = Date.parse("2026-10-19T08:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let resourceId: string;
let owner: { userId: string; memberId: string };
let staff: { userId: string; memberId: string };

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return { userId, memberId };
}

/** The resource is open around the clock: each proposal takes the next free hour after START. */
let hour = 1;
const nextSlot = () => new Date(START + hour++ * 3_600_000).toISOString();
function bookingAction(startsAt = nextSlot()) {
  const bookingId = randomUUID();
  return { actionType: "booking.create", target: { type: "booking", id: bookingId }, payload: { bookingId, resourceId, startsAt } };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await fixture.service((tx) => tx.query<{ n: string }>(sql, params))).rows[0]!.n);
}

/** Approve without running, as a decider whose run comes later (A-6 alone). */
function approveOnly(actorId: string, approvalId: string) {
  const run = directDispatch(deps(), tenantId, actorId, memberAuthorize(tenantId, actorId));
  return run({
    actionType: "approval.approve",
    target: { tenantId, type: "approval", id: approvalId },
    approvalReference: { tenantId, id: randomUUID() },
    idempotencyKey: randomUUID(),
    payload: { approvalId },
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  resourceId = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })))],
  ));
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
});
afterAll(async () => { await database?.close(); });
beforeEach(() => { now = START; });

describe("request (A-5)", () => {
  it("records a pending approval with the requester and an expiry from the injected clock", async () => {
    const action = bookingAction();
    const out = await sessionFor(staff.userId).requestApproval({ action, summary: "Book Ada at 9" }, randomUUID());
    expect(out.result).toMatchObject({
      tenantId, actionType: "booking.create", target: { tenantId, ...action.target }, payload: action.payload,
      status: "pending", standing: "pending", requestedBy: staff.userId,
      requestedAt: new Date(START).toISOString(), expiresAt: new Date(START + 10_080 * 60_000).toISOString(),
      decidedBy: null, executedActionId: null,
    });
    expect(await count("SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type='approval.requested'", [tenantId])).toBeGreaterThan(0);
  });

  it("replays with the same key and refuses another proposal under it", async () => {
    const key = randomUUID();
    const action = bookingAction();
    const first = await sessionFor(staff.userId).requestApproval({ action, summary: "One" }, key);
    now += 60_000;
    expect(await sessionFor(staff.userId).requestApproval({ action, summary: "One" }, key)).toEqual(first);
    await expect(sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Two" }, key))
      .rejects.toMatchObject({ code: "IdempotencyConflict" });
  });

  it("refuses actions that cannot be approved, and actions the requester may not ask for", async () => {
    const session = sessionFor(owner.userId);
    for (const actionType of ["approval.approve", "approval.request", "booking.public_request", "calendar.google.connect", "wallet.topup.create", "nope.never"])
      await expect(session.requestApproval({ action: { ...bookingAction(), actionType }, summary: "x" }, randomUUID()))
        .rejects.toBeInstanceOf(ValidationFailed);
    // member.invite needs "members"; staff hold calendar, customers and inbox drafts.
    await expect(sessionFor(staff.userId).requestApproval({
      action: { actionType: "member.invite", target: { type: "member", id: randomUUID() }, payload: {} }, summary: "x",
    }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(randomUUID()).requestApproval({ action: bookingAction(), summary: "x" }, randomUUID()))
      .rejects.toBeInstanceOf(TenantDenied);
  });

  it("never lets calendar.google.connect be requested, even past the edge check (G-2)", async () => {
    expect(approvalPolicy("calendar.google.connect", ACTION_PERMISSIONS)).toBeNull();
    // The disconnect action keeps its ordinary policy.
    expect(approvalPolicy("calendar.google.disconnect", ACTION_PERMISSIONS)).toEqual({ request: "publish", required: false });
    const connectionId = randomUUID();
    const action = {
      actionType: "calendar.google.connect", target: { type: "calendar_connection", id: connectionId },
      payload: { connectionId, resourceId, accountEmail: null, scope: "x", refreshTokenSealed: "zsg1.a.b.c" },
    };
    await expect(sessionFor(owner.userId).requestApproval({ action, summary: "Connect" }, randomUUID())).rejects.toBeInstanceOf(ValidationFailed);
    // A dispatcher whose authorize lets everything through still meets the handler's refusal.
    const approvalId = randomUUID();
    await expect(directDispatch(deps(), tenantId, owner.userId, async () => {})({
      actionType: "approval.request", target: { tenantId, type: "approval", id: approvalId },
      approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: randomUUID(),
      payload: { approvalId, action, summary: "Connect", expiresInMinutes: 60 },
    })).rejects.toBeInstanceOf(ValidationFailed);
    expect(await count("SELECT count(*) AS n FROM approvals WHERE tenant_id=$1 AND action_type='calendar.google.connect'", [tenantId])).toBe(0);
  });

  it("refuses site actions at the edge and in the handler: their publish path runs around the handler", async () => {
    const siteAction = (actionType: string) => ({ actionType, target: { type: "site", id: randomUUID() }, payload: {} });
    const dispatch = createDispatcher({ ...approvalHandlers });
    const ctx: DispatchContext = {
      tenantId, actor: { id: owner.userId, tenantId }, db: database.db, clock, config: {}, generateId: randomUUID,
      resolveApproval: (tx, reference) => resolveStoredApproval(tx, tenantId, reference.id, clock.now),
    };
    for (const actionType of ["site.create", "site.release.publish", "site.release.activate"]) {
      await expect(sessionFor(owner.userId).requestApproval({ action: siteAction(actionType), summary: "Publish" }, randomUUID()))
        .rejects.toBeInstanceOf(ValidationFailed);
      // A dispatcher without the edge's permission check refuses it too.
      const approvalId = randomUUID();
      await expect(dispatch(ctx, {
        actionType: "approval.request", target: { type: "approval", id: approvalId }, idempotencyKey: randomUUID(),
        payload: { approvalId, action: siteAction(actionType), summary: "Publish", expiresInMinutes: 60 },
      })).rejects.toBeInstanceOf(ValidationFailed);
    }
    expect(await count("SELECT count(*) AS n FROM approvals WHERE tenant_id=$1 AND action_type LIKE 'site.%'", [tenantId])).toBe(0);
  });

  it("bounds the expiry and the summary", async () => {
    const session = sessionFor(owner.userId);
    for (const body of [
      { action: bookingAction(), summary: "x", expiresInMinutes: 0 },
      { action: bookingAction(), summary: "x", expiresInMinutes: 43_201 },
      { action: bookingAction(), summary: "" },
      { action: bookingAction(), summary: "x".repeat(501) },
      { action: bookingAction(), summary: "x", tenantId },
    ]) await expect(session.requestApproval(body, randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("approve and run (A-6, A-7)", () => {
  it("runs the exact stored action once, as the deciding owner", async () => {
    const action = bookingAction();
    const requested = await sessionFor(staff.userId).requestApproval({ action, summary: "Book" }, randomUUID());
    const key = randomUUID();
    const approved = await sessionFor(owner.userId).approveApproval(requested.result.id, { note: "ok" }, key);
    expect(approved.approval.result).toMatchObject({ status: "approved", standing: "approved", decidedBy: owner.userId, decisionNote: "ok" });
    expect(approved.execution.result).toMatchObject({ id: action.target.id, resourceId, status: "confirmed" });
    const stored = (await fixture.service((tx) => tx.query(
      "SELECT actor_id, action_type, idempotency_key, approval_reference FROM actions WHERE tenant_id=$1 AND id=$2",
      [tenantId, approved.execution.actionId]))).rows[0];
    expect(stored).toEqual({
      actor_id: owner.userId, action_type: "booking.create", idempotency_key: `approval:${requested.result.id}`,
      approval_reference: { tenantId, id: requested.result.id },
    });
    // A retry of the same approve replays the decision and the run.
    expect(await sessionFor(owner.userId).approveApproval(requested.result.id, { note: "ok" }, key)).toEqual(approved);
    expect(await count("SELECT count(*) AS n FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, action.target.id])).toBe(1);
    expect((await sessionFor(owner.userId).getApproval(requested.result.id)).executedActionId).toBe(approved.execution.actionId);
  });

  it("lets staff request and only owners decide", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    await expect(sessionFor(staff.userId).approveApproval(result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(staff.userId).rejectApproval(result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(approvedDispatch(deps(), tenantId, staff.userId)(result.id)).rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_approved" } });
    expect((await sessionFor(owner.userId).getApproval(result.id)).status).toBe("pending");
  });

  it("refuses a second decision and runs nothing that is not approved", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    const rejected = await sessionFor(owner.userId).rejectApproval(result.id, { note: "no" }, randomUUID());
    expect(rejected.result).toMatchObject({ status: "rejected", decidedBy: owner.userId, decisionNote: "no" });
    await expect(sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_pending" } });
    await expect(approvedDispatch(deps(), tenantId, owner.userId)(result.id))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_approved" } });
    expect(await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND approval_reference->>'id'=$2", [tenantId, result.id])).toBe(0);
  });

  it("runs only as its decider: another owner's run is a binding mismatch", async () => {
    const other = await addMember(tenantId, "owner");
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    await approveOnly(owner.userId, result.id);
    await expect(approvedDispatch(deps(), tenantId, other.userId)(result.id)).rejects.toMatchObject({ code: "BindingMismatch" });
    await expect(approvedDispatch(deps(), tenantId, owner.userId)(result.id)).resolves.toMatchObject({ result: { status: "confirmed" } });
  });

  it("keeps the approval approved when the run fails, so a retry can run it", async () => {
    const startsAt = nextSlot();
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(startsAt), summary: "Book" }, randomUUID());
    // Someone books that slot directly first.
    const taken = await sessionFor(owner.userId).createBooking({ resourceId, startsAt }, randomUUID());
    const key = randomUUID();
    await expect(sessionFor(owner.userId).approveApproval(result.id, { note: "go" }, key))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    expect((await sessionFor(owner.userId).getApproval(result.id)).status).toBe("approved");
    // The slot frees up. Another owner may not take over the run; the decider retries with a
    // fresh key (a reloaded dashboard), skips the decision and runs the stored action once.
    await fixture.service((tx) => tx.query("DELETE FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, taken.result.id]));
    const other = await addMember(tenantId, "owner");
    await expect(sessionFor(other.userId).approveApproval(result.id, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_pending" } });
    await expect(sessionFor(staff.userId).approveApproval(result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    const retried = await sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID());
    expect(retried.approval.result).toMatchObject({ status: "approved", decidedBy: owner.userId, decisionNote: "go" });
    expect(retried.execution.result).toMatchObject({ startsAt, status: "confirmed" });
    expect(await count("SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type='approval.approved' AND payload->>'approvalId'=$2", [tenantId, result.id])).toBe(1);
    // Once it ran, another approve is refused and the first key replays both steps.
    await expect(sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_pending" } });
    expect((await sessionFor(owner.userId).approveApproval(result.id, { note: "go" }, key)).execution).toEqual(retried.execution);
    // An invalid stored payload fails in the action's own handler the same way.
    const invalid = await sessionFor(staff.userId).requestApproval({
      action: { actionType: "booking.create", target: { type: "booking", id: randomUUID() }, payload: { bogus: true } }, summary: "x",
    }, randomUUID());
    await expect(sessionFor(owner.userId).approveApproval(invalid.result.id, {}, randomUUID())).rejects.toBeInstanceOf(ValidationFailed);
    expect(taken.result.status).toBe("confirmed");
  });

  it("reserves the run key: no member write may use approval:<id> (A-7)", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    const runKey = `approval:${result.id}`;
    // Case B: the requester knows its approval's ID and tries to take the run key first.
    for (const write of [
      () => sessionFor(staff.userId).upsertContact({ displayName: "Ada" }, runKey),
      () => sessionFor(staff.userId).createBooking({ resourceId, startsAt: nextSlot() }, runKey.toUpperCase()),
      () => sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "x" }, runKey),
      () => sessionFor(staff.userId).revokeApproval(result.id, {}, runKey),
      () => sessionFor(staff.userId).observeSource({ subject: { type: "booking_resource", id: resourceId }, source: "owner" }, runKey),
    ]) await expect(write()).rejects.toMatchObject({ code: "ValidationFailed" });
    // Case A: the owner approves with the run key as its own key.
    await expect(sessionFor(owner.userId).approveApproval(result.id, {}, runKey)).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND idempotency_key ILIKE $2", [tenantId, runKey])).toBe(0);
    const approved = await sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID());
    expect(approved.execution.result).toMatchObject({ status: "confirmed" });
  });

  it("allows one committed action per approval, whatever key carries it", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    await sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID());
    const dispatch = createDispatcher({ ...bookingHandlers });
    const row = (await sessionFor(owner.userId).getApproval(result.id));
    const command: ActionCommand = {
      actionType: row.actionType, target: row.target, payload: row.payload,
      approvalReference: { tenantId, id: row.id }, idempotencyKey: randomUUID(),
    };
    const ctx: DispatchContext = {
      tenantId, actor: { id: owner.userId, tenantId }, db: database.db, clock, config: {}, generateId: randomUUID,
      resolveApproval: (tx, reference) => resolveStoredApproval(tx, tenantId, reference.id, clock.now),
    };
    await expect(dispatch(ctx, command)).rejects.toBeInstanceOf(Conflict);
  });
});

describe("expiry (A-3)", () => {
  it("expires against the injected clock: no decision, no run, and the list says expired", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book", expiresInMinutes: 5 }, randomUUID());
    now = START + 5 * 60_000 - 1;
    expect((await sessionFor(owner.userId).getApproval(result.id)).standing).toBe("pending");
    now = START + 5 * 60_000;
    expect((await sessionFor(owner.userId).getApproval(result.id)).standing).toBe("expired");
    await expect(sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_expired" } });
  });

  it("stops an approved action that was not run before the approval expired", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book", expiresInMinutes: 5 }, randomUUID());
    await approveOnly(owner.userId, result.id);
    now = START + 5 * 60_000;
    await expect(approvedDispatch(deps(), tenantId, owner.userId)(result.id))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_expired" } });
    const check = await database.db.tenant(tenantId, (tx) => checkApproval(tx, tenantId, result.id, clock.now()));
    expect(check).toMatchObject({ kind: "stored", standing: "expired", binding: null });
  });


  it("reads the clock after the row lock: a wait past expiry stops the run", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book", expiresInMinutes: 5 }, randomUUID());
    await approveOnly(owner.userId, result.id);
    // A writer (a revocation that fails, say) holds the row while the run starts, then rolls back.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((resolve) => { locked = resolve; });
    const holder = fixture.service(async (tx) => {
      const { rows } = await tx.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, result.id]);
      locked(rows[0]!.pid);
      await released;
      throw new Error("rolled back");
    }).catch(() => undefined);
    try {
      const pid = await holderPid;
      const outcome = approvedDispatch(deps(), tenantId, owner.userId)(result.id).then(() => null, (error: unknown) => error);
      // The superuser pool sees every backend: wait until the run is queued behind the holder.
      for (let tries = 0; ; tries += 1) {
        const { rowCount } = await database.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND $1::int = ANY(pg_blocking_pids(pid))`, [pid]);
        if (rowCount) break;
        if (tries > 500) throw new Error("the run never waited on the row lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      now = START + 5 * 60_000;
      release();
      await holder;
      expect(await outcome).toMatchObject({ code: "Conflict", details: { reason: "approval_expired" } });
    } finally {
      release();
      await holder;
    }
    expect(await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND approval_reference->>'id'=$2", [tenantId, result.id])).toBe(0);
  });
});

describe("revoke (A-8) and delivery re-check (A-10)", () => {
  it("revokes after the run: the action stays, and the delivery check says revoked", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Book" }, randomUUID());
    const { execution } = await sessionFor(owner.userId).approveApproval(result.id, {}, randomUUID());
    const before = await database.db.tenant(tenantId, (tx) => approvalForAction(tx, tenantId, execution.actionId, clock.now()));
    expect(before).toMatchObject({ kind: "stored", standing: "approved", binding: { actorId: owner.userId, actionType: "booking.create" } });
    const revoked = await sessionFor(owner.userId).revokeApproval(result.id, { note: "stop" }, randomUUID());
    expect(revoked.result).toMatchObject({ status: "revoked", revokedBy: owner.userId, revokeNote: "stop", decidedBy: owner.userId });
    const after = await database.db.tenant(tenantId, (tx) => approvalForAction(tx, tenantId, execution.actionId, clock.now()));
    expect(after).toMatchObject({ kind: "stored", standing: "revoked", binding: null });
    expect(await count("SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type='approval.revoked' AND payload->>'approvalId'=$2", [tenantId, result.id])).toBe(1);
  });

  it("calls direct approvals direct, and an unknown action null", async () => {
    const booked = await sessionFor(owner.userId).createBooking({ resourceId, startsAt: nextSlot() }, randomUUID());
    await database.db.tenant(tenantId, async (tx) => {
      const action = (await tx.query<{ id: string }>("SELECT id FROM actions WHERE tenant_id=$1 AND result->>'id'=$2", [tenantId, booked.result.id])).rows[0]!;
      expect(await approvalForAction(tx, tenantId, action.id, clock.now())).toEqual({ kind: "direct" });
      expect(await approvalForAction(tx, tenantId, randomUUID(), clock.now())).toBeNull();
    });
  });

  it("lets a requester withdraw their own pending request, and nothing else", async () => {
    const other = await addMember(tenantId, "staff");
    const mine = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Mine" }, randomUUID());
    await expect(sessionFor(other.userId).revokeApproval(mine.result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    expect((await sessionFor(staff.userId).revokeApproval(mine.result.id, {}, randomUUID())).result)
      .toMatchObject({ status: "revoked", revokedBy: staff.userId, decidedBy: null });
    await expect(sessionFor(owner.userId).revokeApproval(mine.result.id, {}, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "approval_not_revocable" } });

    const approved = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Approved" }, randomUUID());
    await approveOnly(owner.userId, approved.result.id);
    await expect(sessionFor(staff.userId).revokeApproval(approved.result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
  });

  it("serializes a run with a revocation: either the run commits first or it is refused", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Race" }, randomUUID());
      await approveOnly(owner.userId, result.id);
      const [run, revoke] = await Promise.allSettled([
        approvedDispatch(deps(), tenantId, owner.userId)(result.id),
        sessionFor(owner.userId).revokeApproval(result.id, {}, randomUUID()),
      ]);
      expect(revoke.status).toBe("fulfilled");
      const ran = await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND approval_reference->>'id'=$2", [tenantId, result.id]);
      if (run.status === "fulfilled") expect(ran).toBe(1);
      else {
        expect(run.reason).toMatchObject({ code: "Conflict", details: { reason: "approval_not_approved" } });
        expect(ran).toBe(0);
      }
    }
  });
});

describe("policy (A-9)", () => {
  it("refuses a required action run directly, and runs it once approved", async () => {
    const policies = { "booking.create": { request: "calendar" as const, required: true } };
    const run = directDispatch(deps(), tenantId, owner.userId, memberAuthorize(tenantId, owner.userId, policies));
    const action = bookingAction();
    await expect(run({ ...action, target: { tenantId, ...action.target }, approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(TenantDenied);
    const request = directDispatch(deps(), tenantId, staff.userId, memberAuthorize(tenantId, staff.userId, policies));
    const approvalId = randomUUID();
    await request({
      actionType: "approval.request", target: { tenantId, type: "approval", id: approvalId },
      approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: randomUUID(),
      payload: { approvalId, action, summary: "Needs approval", expiresInMinutes: 60 },
    });
    await approveOnly(owner.userId, approvalId);
    await expect(approvedDispatch(deps(), tenantId, owner.userId)(approvalId)).resolves.toMatchObject({ result: { status: "confirmed" } });
  });
});

describe("visibility (A-11) and tenants", () => {
  it("shows owners every approval and other members only their own", async () => {
    const other = await addMember(tenantId, "staff");
    const mine = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Mine" }, randomUUID());
    const theirs = await sessionFor(other.userId).requestApproval({ action: bookingAction(), summary: "Theirs" }, randomUUID());
    const ids = async (session: Session) => (await session.listApprovals({ limit: 100 })).items.map((item) => item.id);
    expect(await ids(sessionFor(owner.userId))).toEqual(expect.arrayContaining([mine.result.id, theirs.result.id]));
    expect(await ids(sessionFor(staff.userId))).toContain(mine.result.id);
    expect(await ids(sessionFor(staff.userId))).not.toContain(theirs.result.id);
    await expect(sessionFor(staff.userId).getApproval(theirs.result.id)).rejects.toBeInstanceOf(NotFound);
    await expect(approvedDispatch(deps(), tenantId, staff.userId)(theirs.result.id)).rejects.toBeInstanceOf(NotFound);
    const pending = await sessionFor(owner.userId).listApprovals({ status: "pending", limit: 100 });
    expect(pending.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("pages newest first with a cursor", async () => {
    const tenant = fixture.b.tenantId;
    const bOwner = await addMember(tenant, "owner");
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      now = START + i * 1000;
      const bookingId = randomUUID();
      created.push((await sessionFor(bOwner.userId, tenant).requestApproval({
        action: { actionType: "booking.create", target: { type: "booking", id: bookingId }, payload: { bookingId } }, summary: `n${i}`,
      }, randomUUID())).result.id);
    }
    const first = await sessionFor(bOwner.userId, tenant).listApprovals({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([created[2], created[1]]);
    const second = await sessionFor(bOwner.userId, tenant).listApprovals({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([created[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps another tenant's approvals out of reach", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "A only" }, randomUUID());
    const outsider = await addMember(fixture.b.tenantId, "owner");
    const b = sessionFor(outsider.userId, fixture.b.tenantId);
    await expect(b.getApproval(result.id)).rejects.toBeInstanceOf(NotFound);
    await expect(b.approveApproval(result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(b.revokeApproval(result.id, {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    expect((await b.listApprovals({ limit: 100 })).items.map((item) => item.id)).not.toContain(result.id);
    await expect(fixture.b.run((tx) => tx.query("UPDATE approvals SET status='approved' WHERE id=$1", [result.id])))
      .resolves.toMatchObject({ rowCount: 0 });
    // Tenant A's own owner, in tenant B's session, sees nothing either.
    await expect(sessionFor(owner.userId, fixture.b.tenantId).getApproval(result.id)).rejects.toBeInstanceOf(TenantDenied);
  });
});

describe("the table under the runtime role (A-2, A-4)", () => {
  it("cannot change what an approval approves, delete it, or reopen a decision", async () => {
    const { result } = await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "Fixed" }, randomUUID());
    for (const sql of [
      "UPDATE approvals SET payload='{}' WHERE id=$1",
      "UPDATE approvals SET action_type='member.invite' WHERE id=$1",
      "UPDATE approvals SET expires_at=expires_at + interval '1 year' WHERE id=$1",
      "DELETE FROM approvals WHERE id=$1",
    ]) await expect(fixture.a.run((tx) => tx.query(sql, [result.id])), sql).rejects.toMatchObject({ code: "42501" });
    await sessionFor(owner.userId).rejectApproval(result.id, {}, randomUUID());
    await expect(fixture.a.run((tx) => tx.query("UPDATE approvals SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=$1", [result.id])))
      .rejects.toMatchObject({ code: "23514" });
    await expect(fixture.a.run((tx) => tx.query("UPDATE approvals SET status='approved' WHERE id=$1", [result.id])))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("refuses partial revocations and decisions a withdrawal never made (A-2)", async () => {
    const pending = (await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "P" }, randomUUID())).result.id;
    const approved = (await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "A" }, randomUUID())).result.id;
    await approveOnly(owner.userId, approved);
    const rejected = (await sessionFor(staff.userId).requestApproval({ action: bookingAction(), summary: "R" }, randomUUID())).result.id;
    await sessionFor(owner.userId).rejectApproval(rejected, {}, randomUUID());
    const actor = owner.userId;
    for (const id of [pending, approved])
      for (const [sql, params] of [
        ["UPDATE approvals SET revoked_by=$2 WHERE id=$1", [id, actor]],
        ["UPDATE approvals SET revoked_at=now() WHERE id=$1", [id]],
        ["UPDATE approvals SET revoke_note='x' WHERE id=$1", [id]],
        ["UPDATE approvals SET revoked_by=$2, revoked_at=now() WHERE id=$1", [id, actor]],
        ["UPDATE approvals SET status='revoked', revoked_by=$2 WHERE id=$1", [id, actor]],
        ["UPDATE approvals SET status='revoked', revoked_at=now() WHERE id=$1", [id]],
      ] as const) await expect(fixture.a.run((tx) => tx.query(sql, [...params])), `${sql} on ${id === pending ? "pending" : "approved"}`)
        .rejects.toMatchObject({ code: "23514" });
    await expect(fixture.a.run((tx) => tx.query("UPDATE approvals SET revoke_note='x' WHERE id=$1", [rejected])))
      .rejects.toMatchObject({ code: "23514" });
    // Withdrawing a pending request records no decision, not even a note.
    for (const [sql, params] of [
      ["UPDATE approvals SET status='revoked', revoked_by=$2, revoked_at=now(), decision_note='x' WHERE id=$1", [pending, actor]],
      ["UPDATE approvals SET status='revoked', revoked_by=$2, revoked_at=now(), decided_by=$2, decided_at=now() WHERE id=$1", [pending, actor]],
      ["UPDATE approvals SET status='revoked', revoked_by=$2, revoked_at=now(), decided_by=NULL, decided_at=NULL WHERE id=$1", [approved, actor]],
    ] as const) await expect(fixture.a.run((tx) => tx.query(sql, [...params])), sql).rejects.toMatchObject({ code: "23514" });
    // The consistent forms still pass.
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE approvals SET status='revoked', revoked_by=$2, revoked_at=now() WHERE id=$1", [pending, actor]))).resolves.toMatchObject({ rowCount: 1 });
  });

  it("refuses inconsistent states even from the service role", async () => {
    await expect(fixture.service((tx) => tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status)
       VALUES ($1,$2,'booking.create','booking',$2,'{}','x',$2,$3,$3,'pending')`, [tenantId, randomUUID(), new Date(START)],
    ))).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.service((tx) => tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status)
       VALUES ($1,$2,'booking.create','booking',$2,'{}','x',$2,$3,$4,'approved')`, [tenantId, randomUUID(), new Date(START), new Date(START + 1000)],
    ))).rejects.toMatchObject({ code: "23514" });
  });

  it("registers exactly the four approval actions", () => {
    expect(Object.keys(approvalHandlers).sort()).toEqual(["approval.approve", "approval.reject", "approval.request", "approval.revoke"]);
  });
});
