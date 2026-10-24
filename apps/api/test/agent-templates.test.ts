import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentKindStatusSchema,
  apiErrorBodySchema,
  approvalRecordSchema,
  approveApprovalResponseSchema,
  templateStateSchema,
  templateSuggestionSchema,
  type TemplateState,
} from "@zs/contracts";
import { createLocalStubSessionCheck, modelForLane } from "@zs/core";
import { createApp, createHs256Verifier, type App } from "../src/app.js";
import { signDevToken } from "../src/dev-token.js";
import {
  call,
  createApiHarness,
  KEY_SECRET,
  NOW,
  ORIGIN,
  provisionPage,
  PUBLIC_BASE_URL,
  SECRET,
  signedInMember,
  type ApiHarness,
  type MemberSetup,
} from "./helpers.js";

// agents.md G-19, G-20 and approvals.md A-15 over HTTP, as zs_runtime on a real database. The
// harness app has no booking link (no publicIntake) and no suggestion model; `linkedApp` is the same
// database and clock with both. The injected clock stays at the fixed test instant (Monday 08:00 UTC).
let now = Date.parse(NOW);
const testClock = { now: () => new Date(now) };
const HOUR = 3_600_000;
const KIND = "appointment_reminder";
const REMINDER_BODY = "Hi {customer_first_name}, see you {booking_start_local} at {business_name}. Change it: {booking_link}";

let h: ApiHarness;
/** Booking link (publicIntake) and the fake no-personal-data suggestion model configured. */
let linkedApp: App;
let staff: MemberSetup;

beforeAll(async () => {
  h = await createApiHarness({ clock: testClock });
  linkedApp = createApp({
    verifier: createHs256Verifier(SECRET, { clock: testClock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, testClock),
    clock: testClock,
    db: h.database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    publicIntake: { keySecrets: { current: KEY_SECRET }, publicBaseUrl: PUBLIC_BASE_URL },
    templated: { maxCandidatesPerRun: 20, suggestion: { model: modelForLane("no_personal_data", { provider: "fake" }) } },
  });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const tokenOf = (member: MemberSetup) => signDevToken(SECRET, member, testClock, 3600);
const as = async (member: MemberSetup, method: string, path: string, body?: unknown, options: { key?: string; app?: App } = {}) =>
  call(options.app ?? h.app, method, `/v1/agents${path}`, {
    token: await tokenOf(member),
    ...(body === undefined ? {} : { body, key: options.key ?? randomUUID() }),
  });
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const template = async (member: MemberSetup = h.a, kind = KIND): Promise<TemplateState> => {
  const response = await as(member, "GET", `/${kind}/template`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return templateStateSchema.parse(response.body);
};
const revisionBody = (expectedRevision: number, over: Record<string, unknown> = {}) => ({
  expectedRevision, channel: "email", subject: "A note from {business_name}", body: REMINDER_BODY, timingHours: 24, ...over,
});
const runs = (member: MemberSetup, options: { key?: string; app?: App } = {}) => as(member, "POST", `/${KIND}/runs`, {}, options);

/** A confirmed booking at Monday 10:00 UTC (two hours ahead) with a linked customer, over HTTP. */
async function bookedWithCustomer(hour = 10): Promise<string> {
  const token = await tokenOf(h.a);
  const booking = await call(h.app, "POST", "/v1/booking/bookings", {
    token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: new Date(Date.parse(NOW) + (hour - 8) * HOUR).toISOString() },
  });
  expect(booking.status, JSON.stringify(booking.body)).toBe(201);
  const contact = await call(h.app, "POST", "/v1/crm/contacts", {
    token, key: randomUUID(), body: { displayName: "Ana Ruiz", email: `ana.${randomUUID().slice(0, 8)}@haldenrowe.example` },
  });
  expect(contact.status, JSON.stringify(contact.body)).toBeLessThan(300);
  const bookingId = booking.body.result.id as string;
  const linked = await call(h.app, "POST", `/v1/booking/bookings/${bookingId}/contact/link`, {
    token, key: randomUUID(), body: { contactId: contact.body.result.contact.id, expectedRevision: 0 },
  });
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  return bookingId;
}

describe("templates over HTTP (G-19, A-15)", () => {
  let bookingId: string;
  let firstApprovalId: string;

  it("reads an empty template before any revision", async () => {
    expect(await template()).toMatchObject({
      agentKind: KIND, purpose: "transactional", currentRevision: 0, revisions: [],
      variables: ["booking_link", "booking_start_local", "business_name", "customer_first_name"],
    });
  });

  it("lets an owner write a revision (201) and reads it back", async () => {
    const created = await as(h.a, "POST", `/${KIND}/template/revisions`, revisionBody(0));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(templateStateSchema.parse(created.body)).toMatchObject({ currentRevision: 1 });
    const state = await template();
    expect(state.currentRevision).toBe(1);
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0]).toMatchObject({
      revision: 1, current: true, approved: false, standing: null, channel: "email", purpose: "transactional",
      subject: "A note from {business_name}", body: REMINDER_BODY, timingHours: 24, createdBy: h.a.actorId,
    });
    expect(state.revisions[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an invalid placeholder, a bad body, a stale revision and a missing key", async () => {
    const placeholder = await as(h.a, "POST", `/${KIND}/template/revisions`, revisionBody(1, { body: "Review us: {review_link}" }));
    expect(placeholder.status).toBe(400);
    expect(errorOf(placeholder).code).toBe("ValidationFailed");
    const unknown = await as(h.a, "POST", `/${KIND}/template/revisions`, revisionBody(1, { body: "Hi {first_name}" }));
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe("ValidationFailed");
    const extra = await as(h.a, "POST", `/${KIND}/template/revisions`, { ...revisionBody(1), surprise: true });
    expect(extra.status).toBe(400);
    const stale = await as(h.a, "POST", `/${KIND}/template/revisions`, revisionBody(0));
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision" } });
    const noKey = await call(h.app, "POST", `/v1/agents/${KIND}/template/revisions`, { token: await tokenOf(h.a), body: revisionBody(1) });
    expect(noKey.status).toBe(400);
    const reserved = await as(h.a, "POST", `/${KIND}/template/revisions`, revisionBody(1), { key: `agent:${randomUUID()}` });
    expect(reserved.status).toBe(400);
    expect((await template()).currentRevision).toBe(1);
  });

  it("refuses a member without the agents permission (staff) on every template route", async () => {
    const state = await template();
    const top = state.revisions[0]!;
    const responses = [
      await as(staff, "GET", `/${KIND}/template`),
      await as(staff, "POST", `/${KIND}/template/revisions`, revisionBody(1)),
      await as(staff, "POST", `/${KIND}/template/approve`, { revision: top.revision, contentDigest: top.contentDigest }),
      await as(staff, "POST", `/${KIND}/runs`, {}),
      await as(staff, "POST", `/${KIND}/template-suggestion`, { channel: "email" }, { app: linkedApp }),
    ];
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(errorOf(response).code).toBe("Forbidden");
    }
    expect(await template()).toEqual(state);
  });

  it("queues nothing before approval: the booking is skipped template_not_approved", async () => {
    bookingId = await bookedWithCustomer(10);
    const current = agentKindStatusSchema.parse((await as(h.a, "GET", `/${KIND}`)).body);
    const enabled = await as(h.a, "PUT", `/${KIND}/settings`, {
      ...current.settings, enabled: true, quietStartMinute: 0, quietEndMinute: 0, timeZone: "UTC", expectedRevision: current.revision,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

    const ran = await runs(h.a, { app: linkedApp });
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    expect(ran.body).toMatchObject({ status: "completed", agent: KIND, requestedBy: h.a.actorId });
    expect(ran.body.decisions).toHaveLength(1);
    expect(ran.body.decisions[0]).toMatchObject({ subjectId: bookingId, outcome: "skipped", reason: "template_not_approved", messageId: null });
  });

  it("approves the current revision with its digest; a wrong digest is template_changed", async () => {
    const top = (await template()).revisions[0]!;
    const wrong = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: top.revision, contentDigest: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(errorOf(wrong)).toMatchObject({ code: "Conflict", details: { reason: "template_changed" } });
    const missing = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: 99, contentDigest: top.contentDigest });
    expect(missing.status).toBe(404);
    const bad = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: top.revision });
    expect(bad.status).toBe(400);

    const key = randomUUID();
    const approved = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: top.revision, contentDigest: top.contentDigest }, { key });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const response = approveApprovalResponseSchema.parse(approved.body);
    expect(response.approval.result).toMatchObject({ actionType: "template.standing.grant", status: "approved" });
    firstApprovalId = response.approval.result.id;
    expect(response.execution.result).toMatchObject({ standingApprovalId: firstApprovalId });

    // A replay with the same key returns the same approval and records nothing new.
    const again = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: top.revision, contentDigest: top.contentDigest }, { key });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(approveApprovalResponseSchema.parse(again.body).approval.result.id).toBe(firstApprovalId);

    expect((await template()).revisions[0]).toMatchObject({
      approved: true, standing: { approvalId: firstApprovalId, standing: "approved", sends: 0 },
    });
  });

  it("skips no_link when the server has no booking link configured", async () => {
    const ran = await runs(h.a);
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    expect(ran.body.decisions).toHaveLength(1);
    expect(ran.body.decisions[0]).toMatchObject({ subjectId: bookingId, outcome: "skipped", reason: "no_link", messageId: null });
  });

  it("queues a reminder once approved with a booking link, and a replayed run returns the same run", async () => {
    await provisionPage(h, h.a);
    const key = randomUUID();
    const ran = await runs(h.a, { app: linkedApp, key });
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    expect(ran.body.decisions).toHaveLength(1);
    expect(ran.body.decisions[0]).toMatchObject({
      subjectId: bookingId, outcome: "queued", reason: null, approvalId: firstApprovalId, messageId: expect.any(String),
    });
    const sent = await h.fixture.service((tx) => tx.query<{ payload: { body: string; purpose: string } }>(
      "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId'=$2",
      [h.a.tenantId, ran.body.decisions[0].messageId]));
    expect(sent.rows).toHaveLength(1);
    expect(sent.rows[0]!.payload.purpose).toBe("transactional");
    expect(sent.rows[0]!.payload.body).toContain(`Change it: ${PUBLIC_BASE_URL}`);
    expect(sent.rows[0]!.payload.body).not.toMatch(/[{}]/);

    const again = await runs(h.a, { app: linkedApp, key });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(ran.body);
    // A fresh run has nothing left to decide for the booking.
    expect((await runs(h.a, { app: linkedApp })).body.decisions).toEqual([]);
    expect((await template()).revisions[0]!.standing!.sends).toBe(1);
  });

  it("replays a revision write with the same key; a new revision supersedes and revokes the old approval", async () => {
    const old = (await template()).revisions[0]!;
    const key = randomUUID();
    const body = revisionBody(1, { body: "See you {booking_start_local}, {customer_first_name}. {booking_link}" });
    const created = await as(h.a, "POST", `/${KIND}/template/revisions`, body, { key });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const replay = await as(h.a, "POST", `/${KIND}/template/revisions`, body, { key });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(templateStateSchema.parse(replay.body).currentRevision).toBe(2);

    const state = await template();
    expect(state.currentRevision).toBe(2);
    expect(state.revisions.map((r) => [r.revision, r.current, r.approved])).toEqual([[2, true, false], [1, false, false]]);
    const revoked = await call(h.app, "GET", `/v1/approvals/${firstApprovalId}`, { token: await tokenOf(h.a) });
    expect(revoked.status).toBe(200);
    expect(approvalRecordSchema.parse(revoked.body)).toMatchObject({ status: "revoked", revokeNote: "superseded" });

    // The old revision cannot be approved again, and a new booking waits for revision 2's approval.
    const superseded = await as(h.a, "POST", `/${KIND}/template/approve`, { revision: old.revision, contentDigest: old.contentDigest });
    expect(superseded.status).toBe(409);
    expect(errorOf(superseded)).toMatchObject({ code: "Conflict", details: { reason: "template_superseded" } });
    const second = await bookedWithCustomer(11);
    const ran = await runs(h.a, { app: linkedApp });
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    expect(ran.body.decisions).toEqual([expect.objectContaining({ subjectId: second, outcome: "skipped", reason: "template_not_approved" })]);
  });

  it("refuses the follow-up kind and an unknown kind on every template route", async () => {
    for (const kind of ["inquiry_followup", "document_intake", "nope"]) {
      for (const [method, path, body] of [
        ["GET", "/template", undefined],
        ["POST", "/template/revisions", revisionBody(0)],
        ["POST", "/template/approve", { revision: 1, contentDigest: "0".repeat(64) }],
        ["POST", "/template-suggestion", { channel: "email" }],
        ["POST", "/runs", {}],
      ] as const) {
        const response = await as(h.a, method, `/${kind}${path}`, body, { app: linkedApp });
        expect(response.status, `${kind} ${method} ${path}`).toBe(404);
        expect(errorOf(response).code).toBe("NotFound");
      }
    }
  });

  it("keeps two tenants apart: tenant B cannot read or approve tenant A's template", async () => {
    const a = await template();
    const top = a.revisions[0]!;
    const b = await template(h.b);
    expect(b).toMatchObject({ currentRevision: 0, revisions: [] });
    expect(b.templateId).not.toBe(a.templateId);
    const approve = await as(h.b, "POST", `/${KIND}/template/approve`, { revision: top.revision, contentDigest: top.contentDigest });
    expect(approve.status).toBe(404);
    // B's run sees none of A's bookings.
    const ran = await runs(h.b, { app: linkedApp });
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    expect(ran.body.decisions).toEqual([]);
    // A's template is unchanged and still unapproved.
    expect(await template()).toEqual(a);
    expect(top.approved).toBe(false);
  });
});

describe("template suggestions (G-19)", () => {
  it("is not found without a suggestion model", async () => {
    const response = await as(h.a, "POST", `/${KIND}/template-suggestion`, { channel: "email" });
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe("NotFound");
  });

  it("suggests a wording with the fake no-personal-data model when one is configured", async () => {
    const response = await as(h.a, "POST", `/${KIND}/template-suggestion`, { channel: "email" }, { app: linkedApp });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const suggestion = templateSuggestionSchema.parse(response.body);
    expect(suggestion).toMatchObject({ agentKind: KIND, channel: "email", costWarning: false });
    expect(suggestion.body.length).toBeGreaterThan(0);
    expect(suggestion.costSpentMicros).toBeGreaterThan(0);
    // Every placeholder it used is one of the kind's variables.
    expect(suggestion.variables.length).toBeGreaterThan(0);
    for (const name of suggestion.variables)
      expect(["booking_link", "booking_start_local", "business_name", "customer_first_name"]).toContain(name);

    const sms = await as(h.a, "POST", `/${KIND}/template-suggestion`, { channel: "sms" }, { app: linkedApp });
    expect(sms.status, JSON.stringify(sms.body)).toBe(200);
    expect(templateSuggestionSchema.parse(sms.body)).toMatchObject({ agentKind: KIND, channel: "sms", subject: null });

    const bad = await as(h.a, "POST", `/${KIND}/template-suggestion`, { channel: "fax" }, { app: linkedApp });
    expect(bad.status).toBe(400);
  });
});

describe("authentication", () => {
  it("answers 401 without a token on every template route", async () => {
    for (const [method, path] of [
      ["GET", "/template"], ["POST", "/template/revisions"], ["POST", "/template/approve"],
      ["POST", "/template-suggestion"], ["POST", "/runs"],
    ] as const) {
      const response = await call(linkedApp, method, `/v1/agents/${KIND}${path}`, method === "GET" ? {} : { body: {}, key: randomUUID() });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
