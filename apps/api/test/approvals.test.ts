// M3b approval and source records over HTTP (docs/requirements/approvals.md A-5..A-11, F-4..F-7).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  approvalOutputSchema,
  approvalPageSchema,
  approvalRecordSchema,
  approveApprovalResponseSchema,
  bookingRecordSchema,
  observeSourceOutputSchema,
  sourceListSchema,
} from "@zs/contracts";
import { call, contactAndDeal, createApiHarness, NOW, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

let h: ApiHarness;
let staff: MemberSetup;
let otherStaff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness();
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
  otherStaff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const nowMs = Date.parse(NOW);
const at = (minutesFromNow: number) => new Date(nowMs + minutesFromNow * 60_000).toISOString();

/** The harness calendar opens Monday 09:00-17:00 UTC; NOW is Monday 08:00, so each proposal takes the next hour. */
let hour = 1;
function bookingAction() {
  const bookingId = randomUUID();
  return {
    actionType: "booking.create",
    target: { type: "booking", id: bookingId },
    payload: { bookingId, resourceId: h.a.resourceId, startsAt: at(60 * hour++) },
  };
}
const request = (token: string, body: unknown, key: string | null = randomUUID()) =>
  call(h.app, "POST", "/v1/approvals", { token, body, ...(key === null ? {} : { key }) });
const decide = (token: string, id: string, verb: "approve" | "reject" | "revoke", body: unknown = {}, key: string = randomUUID()) =>
  call(h.app, "POST", `/v1/approvals/${id}/${verb}`, { token, key, body });
async function requested(token: string) {
  const action = bookingAction();
  const response = await request(token, { action, summary: "Book Ada" });
  expect(response.status).toBe(201);
  return { action, approval: approvalOutputSchema.parse(response.body).result };
}

describe("approval routes", () => {
  it("lets staff request, refuses staff deciding, and runs the action once when an owner approves", async () => {
    const action = bookingAction();
    const response = await request(staff.token, { action, summary: "Book Ada at 9" });
    expect(response.status).toBe(201);
    const approval = approvalOutputSchema.parse(response.body).result;
    expect(approval).toMatchObject({
      tenantId: h.a.tenantId, actionType: "booking.create", status: "pending", standing: "pending",
      requestedBy: staff.actorId, requestedAt: NOW, expiresAt: at(10_080), executedActionId: null,
    });

    const denied = await decide(staff.token, approval.id, "approve");
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe("Forbidden");

    const key = randomUUID();
    const approved = await decide(h.a.token, approval.id, "approve", { note: "ok" }, key);
    expect(approved.status).toBe(200);
    const body = approveApprovalResponseSchema.parse(approved.body);
    expect(body.approval.result).toMatchObject({ id: approval.id, status: "approved", decidedBy: h.a.actorId, decisionNote: "ok" });
    expect(bookingRecordSchema.parse(body.execution.result)).toMatchObject({
      id: action.target.id, resourceId: h.a.resourceId, startsAt: action.payload.startsAt, status: "confirmed",
    });
    const bookings = await h.database.pool.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, action.target.id]);
    expect(bookings.rowCount).toBe(1);

    // The same key replays the decision and the run.
    const replay = await decide(h.a.token, approval.id, "approve", { note: "ok" }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(approved.body);

    const read = await call(h.app, "GET", `/v1/approvals/${approval.id}`, { token: h.a.token });
    expect(approvalRecordSchema.parse(read.body).executedActionId).toBe(body.execution.actionId);
  });

  it("refuses to approve a rejected approval", async () => {
    const { approval } = await requested(staff.token);
    const rejected = await decide(h.a.token, approval.id, "reject", { note: "no" });
    expect(rejected.status).toBe(200);
    expect(approvalOutputSchema.parse(rejected.body).result).toMatchObject({ status: "rejected", decisionNote: "no" });
    const late = await decide(h.a.token, approval.id, "approve");
    expect(late.status).toBe(409);
    expect(errorOf(late)).toMatchObject({ code: "Conflict", details: { reason: "approval_not_pending" } });
  });

  it("shows owners every approval and staff only their own", async () => {
    const mine = await requested(staff.token);
    const theirs = await requested(otherStaff.token);
    const ownerList = approvalPageSchema.parse((await call(h.app, "GET", "/v1/approvals", { token: h.a.token })).body);
    expect(ownerList.items.map((item) => item.id)).toEqual(expect.arrayContaining([mine.approval.id, theirs.approval.id]));

    const staffList = approvalPageSchema.parse((await call(h.app, "GET", "/v1/approvals?status=pending", { token: staff.token })).body);
    expect(staffList.items.map((item) => item.id)).toContain(mine.approval.id);
    for (const item of staffList.items) expect(item).toMatchObject({ requestedBy: staff.actorId, status: "pending" });

    expect((await call(h.app, "GET", `/v1/approvals/${mine.approval.id}`, { token: staff.token })).status).toBe(200);
    const hidden = await call(h.app, "GET", `/v1/approvals/${theirs.approval.id}`, { token: staff.token });
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden).code).toBe("NotFound");
  });

  it("revokes, and hides one tenant's approvals from another", async () => {
    const { approval } = await requested(staff.token);
    const revoked = await decide(h.a.token, approval.id, "revoke", { note: "changed plans" });
    expect(revoked.status).toBe(200);
    expect(approvalOutputSchema.parse(revoked.body).result).toMatchObject({
      status: "revoked", standing: "revoked", revokedBy: h.a.actorId, revokeNote: "changed plans",
    });
    const again = await decide(h.a.token, approval.id, "revoke");
    expect(again.status).toBe(409);
    expect(errorOf(again).details).toEqual({ reason: "approval_not_revocable" });

    expect((await call(h.app, "GET", `/v1/approvals/${approval.id}`, { token: h.b.token })).status).toBe(404);
    const otherList = approvalPageSchema.parse((await call(h.app, "GET", "/v1/approvals", { token: h.b.token })).body);
    expect(otherList.items.map((item) => item.id)).not.toContain(approval.id);
  });

  it("requires an Idempotency-Key on writes, and refuses the reserved run key", async () => {
    const missing = await request(staff.token, { action: bookingAction(), summary: "x" }, null);
    expect(missing.status).toBe(400);
    expect(errorOf(missing).code).toBe("ValidationFailed");
    const { approval } = await requested(staff.token);
    const decision = await call(h.app, "POST", `/v1/approvals/${approval.id}/approve`, { token: h.a.token, body: {} });
    expect(decision.status).toBe(400);
    // A-7: approval:<id> is the run's own key.
    for (const response of [
      await decide(h.a.token, approval.id, "approve", {}, `approval:${approval.id}`),
      await call(h.app, "POST", "/v1/crm/contacts", { token: staff.token, key: `approval:${approval.id}`, body: { displayName: "Ada" } }),
    ]) {
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe("ValidationFailed");
    }
    const approved = await decide(h.a.token, approval.id, "approve");
    expect(approved.status).toBe(200);
  });
});

describe("source routes", () => {
  const observe = (token: string, body: unknown, key = randomUUID()) => call(h.app, "POST", "/v1/sources", { token, key, body });

  it("records an observation, ignores an older one, and lists records with freshness", async () => {
    const { contactId } = await contactAndDeal(h, h.a, `${randomUUID()}@example.com`);
    const subject = { type: "contact", id: contactId };
    const first = await observe(h.a.token, { subject, source: "website", sourceRef: "form-1", observedAt: at(-60), freshForMinutes: 30 });
    expect(first.status).toBe(200);
    const recorded = observeSourceOutputSchema.parse(first.body).result;
    expect(recorded).toMatchObject({ applied: true, record: { subject, source: "website", sourceRef: "form-1", revision: 1, observedAt: at(-60), freshUntil: at(-30), fresh: false } });

    const older = observeSourceOutputSchema.parse((await observe(h.a.token, { subject, source: "website", observedAt: at(-120) })).body).result;
    expect(older).toMatchObject({ applied: false, record: { id: recorded.record.id, revision: 1, sourceRef: "form-1" } });

    const owner = observeSourceOutputSchema.parse((await observe(h.a.token, { subject, source: "owner", observedAt: at(-10) })).body).result;
    expect(owner).toMatchObject({ applied: true, record: { revision: 1, freshUntil: null, fresh: true } });

    const list = await call(h.app, "GET", `/v1/sources?subjectType=contact&subjectId=${contactId}`, { token: staff.token });
    expect(list.status).toBe(200);
    expect(sourceListSchema.parse(list.body).items.map((item) => [item.source, item.fresh])).toEqual([["owner", true], ["website", false]]);
  });

  it("checks the subject's permission, its existence and the clock", async () => {
    const forbidden = await observe(staff.token, { subject: { type: "intake_item", id: randomUUID() }, source: "website" });
    expect(forbidden.status).toBe(403);
    expect(errorOf(forbidden).code).toBe("Forbidden");

    const unknown = await call(h.app, "GET", `/v1/sources?subjectType=contact&subjectId=${randomUUID()}`, { token: h.a.token });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown).code).toBe("NotFound");

    const { contactId } = await contactAndDeal(h, h.a, `${randomUUID()}@example.com`);
    const future = await observe(h.a.token, { subject: { type: "contact", id: contactId }, source: "website", observedAt: at(1) });
    expect(future.status).toBe(400);
    expect(errorOf(future).code).toBe("ValidationFailed");

    // Years outside 0001-9999 are refused at the boundary and leave no row behind.
    const yearZero = await observe(h.a.token, { subject: { type: "contact", id: contactId }, source: "website", observedAt: "0000-01-01T00:00:00.000Z" });
    expect(yearZero.status).toBe(400);
    expect(errorOf(yearZero).code).toBe("ValidationFailed");
    expect((await h.fixture.service((tx) => tx.query("SELECT 1 FROM source_records WHERE tenant_id=$1 AND subject_id=$2",
      [h.a.tenantId, contactId]))).rowCount).toBe(0);

    // Another tenant cannot see or record against this contact.
    expect((await call(h.app, "GET", `/v1/sources?subjectType=contact&subjectId=${contactId}`, { token: h.b.token })).status).toBe(404);
  });
});
