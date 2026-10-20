// M3c Inbox v1 (docs/requirements/inbox-home.md I-1..I-9, H-8) through the edge sessions under
// the runtime role: threads derived from website requests and replies, the visitor kept out of
// a matched customer's thread until linked, draft/approve/discard with their conflicts and
// outbox event, the role matrix, paging, and two-tenant denial. The clock is injected and moves
// only when a test moves it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, THREAD_ENTRY_LIMIT, type MemberRole, type ThreadSummary } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../src/edge/public-session.js";
import { mapError } from "../src/edge/errors.js";
import { createSession, directDispatch, memberAuthorize, type EdgeDependencies, type Session } from "../src/edge/session.js";
import { approvalForAction, settleReplyDelivery } from "../src/index.js";

/** The injected clock; every write helper moves it one minute forward first. */
let now = Date.parse("2026-10-19T08:00:00.000Z");
const clock = { now: () => new Date(now) };
const tick = () => { now += 60_000; return new Date(now).toISOString(); };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let pageId: string;
let resourceId: string;
let owner: { userId: string; email: string };
let staff: { userId: string; email: string };
let ownerB: { userId: string; email: string };
let a: Session;
let b: Session;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenantId = fixture.a.tenantId) => createSession(deps(), { tenantId, actorId });

async function addMember(tenantId: string, role: MemberRole) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@example.com`;
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), email, userId, role, new Date(now)],
  ));
  return { userId, email };
}

/** Website requests take the next free hour on the public resource, from December on. */
let slot = 0;
async function website(input: { name: string; email: string; notes?: string | null; phone?: string | null }) {
  tick();
  const n = slot++;
  const day = 1 + Math.floor(n / 8);
  const startsAt = `2026-12-${String(day).padStart(2, "0")}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
  const reply = await createPublicSession(deps(), { tenantId: fixture.a.tenantId, pageId }).request({
    resourceId, startsAt, name: input.name, email: input.email, phone: input.phone ?? null, notes: input.notes ?? null,
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  const item = (await fixture.service((tx) => tx.query<{ status: string; contact_id: string | null }>(
    "SELECT status, contact_id FROM intake_items WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, reply.requestId],
  ))).rows[0]!;
  return { itemId: reply.requestId, status: item.status, contactId: item.contact_id, startsAt };
}

async function contact(session: Session, input: { displayName: string; email?: string; phone?: string }) {
  tick();
  return (await session.upsertContact(input, randomUUID())).result.contact.id;
}
async function draft(session: Session, contactId: string, body: string, key: unknown = randomUUID(), subject?: string) {
  tick();
  return session.draftReply({ contactId, body, ...(subject === undefined ? {} : { subject }) }, key);
}
/** The edge's subject when a draft names none (I-5); the fixture names tenant A "Tenant A". */
const DEFAULT_SUBJECT = "Message from Tenant A";
async function approve(session: Session, replyId: string) {
  tick();
  return session.approveReply(replyId, {}, randomUUID());
}
async function discard(session: Session, replyId: string) {
  tick();
  return session.discardReply(replyId, {}, randomUUID());
}

/** Session reads parse their input before returning a promise, so a sync throw counts too. */
async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<ActionError> {
  try { await (typeof promise === "function" ? promise() : promise); }
  catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}
async function allThreads(session: Session): Promise<ThreadSummary[]> {
  return (await session.listThreads({ limit: 100 })).items;
}
/** I-6: the send request an approval hands to the delivery worker, by reply (message) ID. */
async function approvedEvents(replyId: string) {
  return (await fixture.service((tx) => tx.query<{ payload: unknown }>(
    "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested' AND payload->>'messageId'=$2",
    [fixture.a.tenantId, replyId],
  ))).rows;
}
async function replyRow(replyId: string) {
  return (await fixture.service((tx) => tx.query<{ status: string; approved_at: Date | null; settled_at: Date | null }>(
    "SELECT status, approved_at, settled_at FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, replyId],
  ))).rows[0];
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  resourceId = randomUUID();
  pageId = randomUUID();
  const tenantId = fixture.a.tenantId;
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
      [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [tenantId, pageId, new Date(now)],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, resourceId]);
  });
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
  a = sessionFor(owner.userId);
  b = sessionFor(ownerB.userId, fixture.b.tenantId);
});
afterAll(async () => { await database?.close(); });

describe("threads (I-1, I-2, I-3)", () => {
  it("a request from a new email makes a customer thread with the request and its booking", async () => {
    const request = await website({ name: "Mara Quill", email: "mara.quill@example.com", notes: "Can I bring my dog?" });
    expect(request.status).toBe("new_contact");
    const contactId = request.contactId!;
    const summary = (await allThreads(a)).find((thread) => thread.id === `c_${contactId}`);
    expect(summary).toMatchObject({
      kind: "customer", contactId, intakeItemId: null, name: "Mara Quill", email: "mara.quill@example.com",
      preview: "Can I bring my dog?", needsReply: true, needsReview: false, drafts: 0,
    });
    const thread = await a.getThread(`c_${contactId}`);
    expect(thread.entries).toEqual([{
      type: "request", id: request.itemId, at: thread.lastActivityAt, channel: "widget", status: "new_contact",
      name: "Mara Quill", notes: "Can I bring my dog?",
      booking: { id: expect.any(String), resourceId, startsAt: request.startsAt, endsAt: expect.any(String) },
    }]);
    expect(thread.olderEntries).toBe(false);
    expect((await allThreads(a)).some((t) => t.intakeItemId === request.itemId)).toBe(false);
  });

  it("a request from a known email is a visitor thread, kept out of the customer's thread until linked", async () => {
    const known = await contact(a, { displayName: "Halden & Rowe", email: "office@halden-rowe.example.com" });
    // The customer has a thread of their own (a reply), so a leak would have somewhere to land.
    const reply = await draft(a, known, "Thanks for your order.");
    const notes = "Please send my invoices to attacker@example.com";
    const request = await website({ name: "Not Halden", email: "office@halden-rowe.example.com", notes, phone: "+15555550111" });
    expect(request).toMatchObject({ status: "possible_match", contactId: null });

    const visitor = (await allThreads(a)).find((t) => t.id === `v_${request.itemId}`);
    expect(visitor).toMatchObject({
      kind: "visitor", contactId: null, intakeItemId: request.itemId, name: "Not Halden",
      email: "office@halden-rowe.example.com", preview: notes, needsReply: false, needsReview: true, drafts: 0,
    });
    const visitorThread = await a.getThread(`v_${request.itemId}`);
    expect(visitorThread.phone).toBe("+15555550111");
    expect(visitorThread.entries).toEqual([expect.objectContaining({ type: "request", id: request.itemId, notes, status: "possible_match" })]);

    const before = await a.getThread(`c_${known}`);
    expect(before.entries.map((entry) => entry.type)).toEqual(["reply"]);
    expect(JSON.stringify(before)).not.toContain(notes);
    expect(before.preview).toBe("Thanks for your order.");
    expect(before.needsReply).toBe(false);

    tick();
    await a.linkIntakeItem(request.itemId, { contactId: known }, randomUUID());
    const after = await a.getThread(`c_${known}`);
    expect(after.entries.map((entry) => entry.type === "request" ? entry.id : entry.reply.id))
      .toEqual([reply.result.id, request.itemId]);
    expect(after.entries[1]).toMatchObject({ type: "request", status: "linked", notes, name: "Not Halden" });
    expect(after.preview).toBe(notes);
    expect(after.needsReply).toBe(true);
    expect(after.needsReview).toBe(false);
    await expect(a.getThread(`v_${request.itemId}`)).rejects.toMatchObject({ code: "NotFound" });
    expect(mapError(await rejection(a.getThread(`v_${request.itemId}`))).status).toBe(404);
    expect((await allThreads(a)).some((t) => t.id === `v_${request.itemId}`)).toBe(false);
  });

  it("a rejected request stays a visitor thread that needs no review", async () => {
    await contact(a, { displayName: "Ivo Brandt", email: "ivo.brandt@example.com" });
    const request = await website({ name: "Ivo?", email: "ivo.brandt@example.com", notes: null });
    tick();
    await a.rejectIntakeItem(request.itemId, {}, randomUUID());
    const thread = await a.getThread(`v_${request.itemId}`);
    expect(thread).toMatchObject({ kind: "visitor", needsReview: false, preview: null });
    expect(thread.entries).toEqual([expect.objectContaining({ type: "request", status: "rejected", notes: null })]);
  });

  it("a contact with no request and no live reply has no thread", async () => {
    const quiet = await contact(a, { displayName: "Quiet Customer", email: "quiet@example.com" });
    await expect(a.getThread(`c_${quiet}`)).rejects.toMatchObject({ code: "NotFound" });
    const discarded = await draft(a, quiet, "Never mind");
    await discard(a, discarded.result.id);
    await expect(a.getThread(`c_${quiet}`)).rejects.toMatchObject({ code: "NotFound" });
    expect((await allThreads(a)).some((t) => t.contactId === quiet)).toBe(false);
  });

  it("refuses malformed thread IDs as validation errors and accepts uppercase UUIDs", async () => {
    const id = (await website({ name: "Upper Case", email: "upper.case@example.com" })).contactId!;
    for (const bad of [id, `x_${id}`, `C_${id}`, `c_${id}x`, "c_not-a-uuid", "c_", "", 42, null, `c_${id.replaceAll("-", "")}`]) {
      const error = await rejection(() => a.getThread(bad));
      expect(error.code, String(bad)).toBe("ValidationFailed");
      expect(mapError(error).status).toBe(400);
    }
    expect((await a.getThread(`c_${id.toUpperCase()}`)).id).toBe(`c_${id}`);
    // A well-formed ID that names nothing: the fixed NotFound body.
    expect(mapError(await rejection(a.getThread(`c_${randomUUID()}`))).body).toEqual(
      { error: { code: "NotFound", message: "Not found", details: {} } });
    await expect(a.getThread(`v_${randomUUID()}`)).rejects.toMatchObject({ code: "NotFound" });
  });
});

describe("draft (I-5)", () => {
  it("trims the body, records the author and the injected time, and replays the same key", async () => {
    const customer = await contact(a, { displayName: "Odile Fenn", email: "odile@example.com" });
    const key = randomUUID();
    const at = new Date(now + 60_000).toISOString();
    const first = await draft(a, customer, "  \n Your table is ready.  \t", key);
    expect(first.result).toEqual({
      id: first.result.id, tenantId: fixture.a.tenantId, contactId: customer, channel: "email",
      subject: DEFAULT_SUBJECT, body: "Your table is ready.", status: "draft", draftedBy: { userId: owner.userId, email: owner.email },
      createdAt: at, approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null,
    });
    const replay = await draft(a, customer, "  \n Your table is ready.  \t", key);
    expect(replay).toEqual(first);
    const count = await fixture.service((tx) => tx.query(
      "SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND contact_id=$2", [fixture.a.tenantId, customer]));
    expect(count.rowCount).toBe(1);
    // A draft writes its own action event, never the approval event.
    expect(await approvedEvents(first.result.id)).toHaveLength(0);
  });

  it("trims a given subject, refuses a blank, multi-line or overlong one, and carries it to the send request", async () => {
    const customer = await contact(a, { displayName: "Nell Arden", email: "nell@example.com" });
    const drafted = await draft(a, customer, "Body text", randomUUID(), "  Your booking on Friday  ");
    expect(drafted.result.subject).toBe("Your booking on Friday");
    for (const subject of ["", "   ", "Line one\nLine two", "Carriage\rreturn", "s".repeat(201)])
      expect((await rejection(draft(a, customer, "Body", randomUUID(), subject))).code, JSON.stringify(subject)).toBe("ValidationFailed");
    expect((await draft(a, customer, "Body", randomUUID(), "s".repeat(200))).result.subject).toHaveLength(200);
    // An explicit null is the same as leaving it out: the business's default subject.
    tick();
    expect((await a.draftReply({ contactId: customer, subject: null, body: "Body" }, randomUUID())).result.subject).toBe(DEFAULT_SUBJECT);
    await approve(a, drafted.result.id);
    expect((await approvedEvents(drafted.result.id))[0]?.payload).toMatchObject({ subject: "Your booking on Friday", body: "Body text" });
  });

  it("refuses an empty or whitespace body and a body over 5000 characters", async () => {
    const customer = await contact(a, { displayName: "Pell Ward", email: "pell@example.com" });
    for (const body of ["", "   ", "\n\t ", "x".repeat(5001)])
      expect((await rejection(draft(a, customer, body))).code).toBe("ValidationFailed");
    expect((await draft(a, customer, `  ${"y".repeat(5000)}  `)).result.body).toHaveLength(5000);
  });

  it("refuses a contact of another tenant, and an unknown contact", async () => {
    const theirs = await contact(b, { displayName: "Tenant B Customer", email: "b.customer@example.com" });
    for (const contactId of [theirs, randomUUID()]) {
      const error = await rejection(draft(a, contactId, "Hello"));
      expect(error.code).toBe("TenantDenied");
    }
    const rows = await fixture.service((tx) => tx.query("SELECT 1 FROM inbox_replies WHERE contact_id=$1", [theirs]));
    expect(rows.rowCount).toBe(0);
  });
});

describe("approve and discard (I-6, I-7)", () => {
  it("approves a draft: status, approver, time and exactly one outbox event", async () => {
    const customer = await contact(a, { displayName: "Rhea Lund", email: "rhea@example.com" });
    const drafted = await draft(a, customer, "See you Tuesday.");
    const at = new Date(now + 60_000).toISOString();
    const approved = await approve(a, drafted.result.id);
    expect(approved.result).toMatchObject({
      id: drafted.result.id, status: "approved", body: "See you Tuesday.",
      approvedBy: { userId: owner.userId, email: owner.email }, approvedAt: at, settledAt: null,
    });
    expect((await approvedEvents(drafted.result.id)).map((row) => row.payload)).toEqual([{
      messageId: drafted.result.id, contactId: customer, channel: "email", purpose: "transactional",
      subject: DEFAULT_SUBJECT, body: "See you Tuesday.",
    }]);
    const events = await fixture.service((tx) => tx.query<{ event_type: string }>(
      "SELECT o.event_type FROM outbox o JOIN actions x ON x.tenant_id=o.tenant_id AND x.id=o.action_id WHERE o.tenant_id=$1 AND x.id=$2",
      [fixture.a.tenantId, approved.actionId]));
    expect(events.rows).toEqual([{ event_type: "message.send_requested" }]);

    // Approving again (a new key) or discarding it is a not_draft conflict naming its status.
    for (const step of [approve, discard]) {
      const error = await rejection(step(a, drafted.result.id));
      expect(error).toMatchObject({ code: "Conflict", details: { reason: "not_draft", status: "approved" } });
      expect(mapError(error)).toEqual({ status: 409, body: { error: {
        code: "Conflict", message: "Request conflicts with the current state", details: { reason: "not_draft", status: "approved" },
      } } });
    }
    expect(await approvedEvents(drafted.result.id)).toHaveLength(1);
  });

  it("discards a draft: hidden from the thread, no approval event, and it cannot be approved after", async () => {
    const customer = await contact(a, { displayName: "Saul Imre", email: "saul@example.com" });
    const kept = await draft(a, customer, "Kept draft");
    const dropped = await draft(a, customer, "Dropped draft");
    const discarded = await discard(a, dropped.result.id);
    expect(discarded.result).toMatchObject({ status: "discarded", approvedAt: null, discardedAt: new Date(now).toISOString() });
    expect(await approvedEvents(dropped.result.id)).toHaveLength(0);
    const error = await rejection(approve(a, dropped.result.id));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "not_draft", status: "discarded" } });
    expect((await rejection(discard(a, dropped.result.id))).details).toMatchObject({ reason: "not_draft", status: "discarded" });
    const thread = await a.getThread(`c_${customer}`);
    expect(thread.entries.map((entry) => entry.type === "reply" && entry.reply.id)).toEqual([kept.result.id]);
    expect(thread.preview).toBe("Kept draft");
    expect(thread.drafts).toBe(1);
  });

  it("refuses to approve a reply to a customer with only a phone, writing nothing", async () => {
    const phoneOnly = await contact(a, { displayName: "Tamsin Hale", phone: "+15555550123" });
    const drafted = await draft(a, phoneOnly, "Call me back?");
    const key = randomUUID();
    tick();
    const error = await rejection(a.approveReply(drafted.result.id, {}, key));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "no_email" } });
    expect(mapError(error).body.error.details).toEqual({ reason: "no_email" });
    expect(await replyRow(drafted.result.id)).toMatchObject({ status: "draft", approved_at: null });
    expect(await approvedEvents(drafted.result.id)).toHaveLength(0);
    const actions = await fixture.service((tx) => tx.query(
      "SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [fixture.a.tenantId, key]));
    expect(actions.rowCount).toBe(0);
    // The thread still shows the draft, and the summary names the customer by phone-less name.
    const thread = await a.getThread(`c_${phoneOnly}`);
    expect(thread).toMatchObject({ email: null, phone: "+15555550123", name: "Tamsin Hale", drafts: 1 });
  });

  it("staff draft and discard but cannot approve; a stranger is refused everything", async () => {
    const customer = (await website({ name: "Uma Rios", email: "uma@example.com", notes: "Hi" })).contactId!;
    const staffSession = sessionFor(staff.userId);
    const drafted = await draft(staffSession, customer, "Drafted by staff");
    expect(drafted.result.draftedBy).toEqual({ userId: staff.userId, email: staff.email });
    expect((await rejection(approve(staffSession, drafted.result.id))).code).toBe("TenantDenied");
    expect(await replyRow(drafted.result.id)).toMatchObject({ status: "draft" });
    await expect(staffSession.listThreads({})).resolves.toBeDefined();
    await expect(staffSession.getThread(`c_${customer}`)).resolves.toMatchObject({ drafts: 1 });
    const second = await draft(staffSession, customer, "Another one");
    expect((await discard(staffSession, second.result.id)).result.status).toBe("discarded");
    // The owner approves the staff draft.
    expect((await approve(a, drafted.result.id)).result.approvedBy?.userId).toBe(owner.userId);

    const stranger = sessionFor(randomUUID());
    const other = await draft(a, customer, "For the stranger to try");
    for (const attempt of [
      () => stranger.listThreads({}),
      () => stranger.getThread(`c_${customer}`),
      () => stranger.draftReply({ contactId: customer, body: "Hello" }, randomUUID()),
      () => stranger.approveReply(other.result.id, {}, randomUUID()),
      () => stranger.discardReply(other.result.id, {}, randomUUID()),
    ]) expect((await rejection(attempt())).code).toBe("TenantDenied");
    expect(await replyRow(other.result.id)).toMatchObject({ status: "draft" });
  });
});

describe("summaries (I-8)", () => {
  it("needsReply follows the latest request against the latest approval; drafts count waiting drafts", async () => {
    const request = await website({ name: "Vera Holm", email: "vera@example.com", notes: "First visit" });
    const customer = request.contactId!;
    const summary = async () => (await a.getThread(`c_${customer}`));
    expect(await summary()).toMatchObject({ needsReply: true, drafts: 0 });
    const one = await draft(a, customer, "Reply one");
    const two = await draft(a, customer, "Reply two");
    expect(await summary()).toMatchObject({ needsReply: true, drafts: 2, preview: "Reply two" });
    await approve(a, one.result.id);
    expect(await summary()).toMatchObject({ needsReply: false, drafts: 1 });
    await discard(a, two.result.id);
    expect(await summary()).toMatchObject({ needsReply: false, drafts: 0, preview: "Reply one" });
    // A newer request (from the same, now known, email) needs a reply again once linked.
    const again = await website({ name: "Vera Holm", email: "vera@example.com", notes: "Second visit" });
    expect(again.status).toBe("possible_match");
    expect(await summary()).toMatchObject({ needsReply: false });
    tick();
    await a.linkIntakeItem(again.itemId, { contactId: customer }, randomUUID());
    expect(await summary()).toMatchObject({ needsReply: true, preview: "Second visit" });
  });

  it("clips the preview to 140 characters", async () => {
    const customer = await contact(a, { displayName: "Wren Abara", email: "wren@example.com" });
    const body = "a".repeat(100) + "b".repeat(200);
    await draft(a, customer, body);
    const { preview } = await a.getThread(`c_${customer}`);
    expect(preview).toHaveLength(140);
    expect(preview).toBe(`${body.slice(0, 139)}…`);
    const exact = await contact(a, { displayName: "Exact Length", email: "exact@example.com" });
    await draft(a, exact, "c".repeat(140));
    expect((await a.getThread(`c_${exact}`)).preview).toBe("c".repeat(140));
  });

  it("lists latest activity first and pages by cursor without repeats", async () => {
    const fresh: string[] = [];
    for (let i = 0; i < 5; i += 1) fresh.push((await website({ name: `Paging ${i}`, email: `paging${i}@example.com` })).contactId!);
    const listed = await allThreads(a);
    expect(listed.length).toBeGreaterThan(10);
    const times = listed.map((thread) => thread.lastActivityAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(listed.slice(0, 5).map((thread) => thread.contactId)).toEqual([...fresh].reverse());
    // A new draft on the oldest of them moves its thread to the front.
    await draft(a, fresh[0]!, "Bumped");
    expect((await allThreads(a))[0]!.id).toBe(`c_${fresh[0]}`);

    const all = (await allThreads(a)).map((thread) => thread.id);
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await a.listThreads({ limit: 3, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map((thread) => thread.id));
      // A cursor page never offers an offset to continue from.
      if (cursor) expect(page.nextOffset).toBeNull();
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
    // Offsets page too; a cursor of another list is refused.
    const first = await a.listThreads({ limit: 2 });
    expect(first.nextOffset).toBe(2);
    expect((await a.listThreads({ limit: 2, offset: 2 })).items.map((t) => t.id)).toEqual(all.slice(2, 4));
    const deals = Buffer.from(JSON.stringify(["deals.recent", "1", randomUUID()])).toString("base64url");
    expect((await rejection(a.listThreads({ cursor: deals }))).code).toBe("ValidationFailed");
  });

  it("returns entries oldest first and at most the latest THREAD_ENTRY_LIMIT, flagging older ones", async () => {
    expect(THREAD_ENTRY_LIMIT).toBe(200);
    const customer = await contact(a, { displayName: "Xavier Long", email: "xavier@example.com" });
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    // 140 replies on even minutes and 60 requests on odd minutes: exactly the limit.
    await fixture.service(async (tx) => {
      await tx.query(
        `INSERT INTO inbox_replies (tenant_id,id,contact_id,subject,body,status,drafted_by,created_at)
         SELECT $1, gen_random_uuid(), $2, 'Bulk', 'reply ' || n, 'draft', $3, $4::timestamptz + (2 * n) * interval '1 minute'
           FROM generate_series(0, 139) n`,
        [fixture.a.tenantId, customer, owner.userId, new Date(base)],
      );
      await tx.query(
        `INSERT INTO intake_items (tenant_id,id,status,channel,page_id,submitted_name,submitted_email,notes,contact_id,created_at)
         SELECT $1, gen_random_uuid(), 'new_contact', 'booking_page', $2, 'Xavier Long', 'xavier@example.com',
                'request ' || n, $3, $4::timestamptz + (2 * n + 1) * interval '1 minute'
           FROM generate_series(0, 59) n`,
        [fixture.a.tenantId, pageId, customer, new Date(base)],
      );
    });
    const full = await a.getThread(`c_${customer}`);
    expect(full.entries).toHaveLength(200);
    expect(full.olderEntries).toBe(false);
    const ats = full.entries.map((entry) => entry.at);
    expect([...ats].sort()).toEqual(ats);
    expect(full.entries[0]).toMatchObject({ type: "reply", reply: { body: "reply 0" } });
    expect(full.entries[1]).toMatchObject({ type: "request", notes: "request 0" });

    // Three more entries: the three oldest drop out and older entries are flagged.
    await draft(a, customer, "Newest one");
    await draft(a, customer, "Newest two");
    await website({ name: "Xavier Long", email: "xavier@example.com", notes: "Newest request" });
    const items = await fixture.service((tx) => tx.query<{ id: string }>(
      "SELECT id FROM intake_items WHERE tenant_id=$1 AND notes='Newest request'", [fixture.a.tenantId]));
    tick();
    await a.linkIntakeItem(items.rows[0]!.id, { contactId: customer }, randomUUID());
    const capped = await a.getThread(`c_${customer}`);
    expect(capped.entries).toHaveLength(200);
    expect(capped.olderEntries).toBe(true);
    expect(capped.entries[0]).toMatchObject({ type: "request", notes: "request 1" });
    expect(capped.entries.slice(-3).map((entry) => entry.type === "reply" ? entry.reply.body : entry.notes))
      .toEqual(["Newest one", "Newest two", "Newest request"]);
  });
});

describe("two tenants (H-8)", () => {
  it("tenant B cannot list, read, draft for, approve or discard tenant A's threads and replies", async () => {
    const request = await website({ name: "Yara Pike", email: "yara@example.com", notes: "Tenant A only" });
    const customer = request.contactId!;
    const pending = await draft(a, customer, "Tenant A draft");
    const other = await draft(a, customer, "Tenant A second draft");
    const visitor = await website({ name: "Yara again", email: "yara@example.com", notes: "Visitor of A" });

    expect(JSON.stringify(await b.listThreads({ limit: 100 }))).not.toContain(customer);
    expect((await b.listThreads({ limit: 100 })).items.some((t) => t.contactId === customer || t.intakeItemId === visitor.itemId)).toBe(false);
    for (const id of [`c_${customer}`, `v_${visitor.itemId}`])
      expect((await rejection(b.getThread(id))).code).toBe("NotFound");
    expect((await rejection(b.draftReply({ contactId: customer, body: "From B" }, randomUUID()))).code).toBe("TenantDenied");
    expect((await rejection(b.approveReply(pending.result.id, {}, randomUUID()))).code).toBe("TenantDenied");
    expect((await rejection(b.discardReply(other.result.id, {}, randomUUID()))).code).toBe("TenantDenied");
    expect(await replyRow(pending.result.id)).toMatchObject({ status: "draft" });
    expect(await replyRow(other.result.id)).toMatchObject({ status: "draft" });

    // Under the runtime role directly: B's scope sees and changes none of A's replies.
    expect((await fixture.b.run((tx) => tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1", [fixture.a.tenantId]))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query(
      "UPDATE inbox_replies SET status='discarded', discarded_by=$2, discarded_at=$3 WHERE id=$1",
      [pending.result.id, ownerB.userId, new Date(now)]))).rowCount).toBe(0);
    await expect(fixture.b.run((tx) => tx.query(
      "INSERT INTO inbox_replies (tenant_id,id,contact_id,subject,body,drafted_by,created_at) VALUES ($1,$2,$3,'x','x',$4,$5)",
      [fixture.a.tenantId, randomUUID(), customer, ownerB.userId, new Date(now)]))).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.a.run((tx) => tx.query("SELECT 1 FROM inbox_replies WHERE id=$1", [pending.result.id]))).rowCount).toBe(1);
  });
});

describe("settleReplyDelivery (I-6, I-9)", () => {
  it("settles an approved reply once with the service role and refuses a draft", async () => {
    const customer = await contact(a, { displayName: "Zeno Marsh", email: "zeno@example.com" });
    const sent = await draft(a, customer, "Will be sent");
    const failed = await draft(a, customer, "Will fail");
    const waiting = await draft(a, customer, "Still a draft");
    await approve(a, sent.result.id);
    await approve(a, failed.result.id);
    const at = new Date(tick());
    const settle = (id: string, outcome: "sent" | "failed") =>
      fixture.service((tx) => settleReplyDelivery(tx, fixture.a.tenantId, id, outcome, at));
    expect(await settle(sent.result.id, "sent")).toBe(true);
    expect(await settle(sent.result.id, "sent")).toBe(false);
    expect(await settle(sent.result.id, "failed")).toBe(false);
    expect(await settle(failed.result.id, "failed")).toBe(true);
    expect(await settle(waiting.result.id, "sent")).toBe(false);
    // Another sender's message ID sharing the worker is a no-op, not an aborted transaction.
    expect(await fixture.service(async (tx) => {
      const settled = await settleReplyDelivery(tx, fixture.a.tenantId, "msg_not-a-uuid", "sent", at);
      await tx.query("SELECT 1");
      return settled;
    })).toBe(false);
    expect(await settle(randomUUID(), "sent")).toBe(false);
    expect(await replyRow(sent.result.id)).toEqual({ status: "sent", approved_at: expect.any(Date), settled_at: at });
    expect(await replyRow(failed.result.id)).toMatchObject({ status: "failed", settled_at: at });
    expect(await replyRow(waiting.result.id)).toMatchObject({ status: "draft", settled_at: null });
    await expect(fixture.service((tx) => settleReplyDelivery(tx, fixture.a.tenantId, waiting.result.id, "sent", new Date(Number.NaN))))
      .rejects.toMatchObject({ code: "ValidationFailed" });
    const thread = await a.getThread(`c_${customer}`);
    expect(thread.entries.map((entry) => entry.type === "reply" && [entry.reply.status, entry.reply.settledAt]))
      .toEqual([["sent", at.toISOString()], ["failed", at.toISOString()], ["draft", null]]);
    expect(thread.lastActivityAt).toBe(at.toISOString());
  });

  it("the runtime role cannot settle a reply or move it to sent", async () => {
    const customer = await contact(a, { displayName: "Ash Calder", email: "ash@example.com" });
    const approved = await draft(a, customer, "Approved, not sent");
    await approve(a, approved.result.id);
    await expect(fixture.a.run((tx) => settleReplyDelivery(tx, fixture.a.tenantId, approved.result.id, "sent", new Date(now))))
      .rejects.toMatchObject({ code: "42501" });
    // Without settled_at the status alone breaks the settle check (or the guard): still refused.
    const error = await fixture.a.run((tx) => tx.query(
      "UPDATE inbox_replies SET status='sent' WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, approved.result.id],
    )).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE inbox_replies SET body='changed' WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, approved.result.id],
    ))).rejects.toMatchObject({ code: "42501" });
    expect(await replyRow(approved.result.id)).toMatchObject({ status: "approved", settled_at: null });
  });
});

describe("sending through M3b approval records (I-6, approvals.md A-5..A-10)", () => {
  /** The proposals to send one reply, oldest first. */
  async function proposals(replyId: string) {
    return (await fixture.service((tx) => tx.query<{
      id: string; status: string; requested_by: string; decided_by: string | null; revoked_by: string | null; payload: unknown;
    }>(
      `SELECT id, status, requested_by, decided_by, revoked_by, payload FROM approvals
        WHERE tenant_id=$1 AND action_type='inbox.reply.send' AND target_type='inbox_reply' AND target_id=$2 ORDER BY requested_at, id`,
      [fixture.a.tenantId, replyId],
    ))).rows;
  }

  it("a draft proposes its send once; approving decides it and runs the send under that approval", async () => {
    const customer = await contact(a, { displayName: "Vera Moss", email: "vera@example.com" });
    const staffSession = sessionFor(staff.userId);
    const key = randomUUID();
    const drafted = await draft(staffSession, customer, "Your order is in.", key);
    expect(await draft(staffSession, customer, "Your order is in.", key)).toEqual(drafted);
    const [proposal, ...more] = await proposals(drafted.result.id);
    expect(more).toEqual([]);
    expect(proposal).toMatchObject({ status: "pending", requested_by: staff.userId, payload: { replyId: drafted.result.id } });
    // Staff see their own proposal through the M3b reads; only an owner decides it.
    expect((await staffSession.getApproval(proposal!.id)).summary).toBe(`Send the reply "${DEFAULT_SUBJECT}"`);
    expect((await rejection(staffSession.approveApproval(proposal!.id, {}, randomUUID()))).code).toBe("TenantDenied");

    tick();
    const approveKey = randomUUID();
    const sent = await a.approveReply(drafted.result.id, {}, approveKey);
    expect(sent.result).toMatchObject({ status: "approved", approvedBy: { userId: owner.userId } });
    expect(await proposals(drafted.result.id)).toEqual([expect.objectContaining({ id: proposal!.id, status: "approved", decided_by: owner.userId })]);
    // The delivery worker's re-check (A-10) finds the stored, approved record behind the send.
    const check = await fixture.service((tx) => approvalForAction(tx, fixture.a.tenantId, sent.actionId, new Date(now)));
    expect(check).toMatchObject({ kind: "stored", standing: "approved", approval: { id: proposal!.id, executedActionId: sent.actionId } });
    // The same key replays the result; a new key is a not_draft conflict; one event either way.
    expect(await a.approveReply(drafted.result.id, {}, approveKey)).toEqual(sent);
    expect((await rejection(a.approveReply(drafted.result.id, {}, randomUUID()))).details).toMatchObject({ reason: "not_draft" });
    expect(await approvedEvents(drafted.result.id)).toHaveLength(1);
  });

  it("reserves the inbox: key prefix for the server's own reply steps", async () => {
    const customer = await contact(a, { displayName: "Cass Dunn", email: "cass@example.com" });
    for (const key of ["inbox:propose:x", "INBOX:withdraw:y"])
      expect((await rejection(() => a.draftReply({ contactId: customer, body: "Hi" }, key))).code).toBe("ValidationFailed");
  });

  it("never runs the send directly from a member session, even an owner's", async () => {
    const customer = await contact(a, { displayName: "Wren Ash", email: "wren@example.com" });
    const drafted = await draft(a, customer, "Direct?");
    const key = randomUUID();
    const run = directDispatch(deps(), fixture.a.tenantId, owner.userId, memberAuthorize(fixture.a.tenantId, owner.userId));
    const error = await rejection(run({
      actionType: "inbox.reply.send", target: { tenantId: fixture.a.tenantId, type: "inbox_reply", id: drafted.result.id },
      payload: { replyId: drafted.result.id }, approvalReference: { tenantId: fixture.a.tenantId, id: randomUUID() }, idempotencyKey: key,
    }));
    expect(error.code).toBe("TenantDenied");
    expect(await replyRow(drafted.result.id)).toMatchObject({ status: "draft" });
    expect(await approvedEvents(drafted.result.id)).toHaveLength(0);
  });

  it("discarding withdraws the open proposal: staff their own, owners anyone's", async () => {
    const customer = await contact(a, { displayName: "Xan Bell", email: "xan@example.com" });
    const staffSession = sessionFor(staff.userId);
    const own = await draft(staffSession, customer, "Mine to drop");
    await discard(staffSession, own.result.id);
    expect(await proposals(own.result.id)).toEqual([expect.objectContaining({ status: "revoked", revoked_by: staff.userId })]);
    const theirs = await draft(staffSession, customer, "The owner drops this one");
    await discard(a, theirs.result.id);
    expect(await proposals(theirs.result.id)).toEqual([expect.objectContaining({ status: "revoked", revoked_by: owner.userId })]);
    // Staff discarding an owner's draft leave the owner's proposal alone (A-8); it can never run.
    const owners = await draft(a, customer, "Owner draft");
    await discard(staffSession, owners.result.id);
    expect(await proposals(owners.result.id)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect((await rejection(approve(a, owners.result.id))).details).toMatchObject({ reason: "not_draft", status: "discarded" });
  });

  it("proposes again when the proposal was withdrawn or expired, then approves the new one", async () => {
    const customer = await contact(a, { displayName: "Yara Penn", email: "yara@example.com" });
    const withdrawn = await draft(a, customer, "Withdrawn first");
    const [first] = await proposals(withdrawn.result.id);
    tick();
    await a.revokeApproval(first!.id, {}, randomUUID());
    await approve(a, withdrawn.result.id);
    expect((await proposals(withdrawn.result.id)).map((row) => row.status)).toEqual(["revoked", "approved"]);

    const stale = await draft(a, customer, "Waited too long");
    now += 7 * 24 * 60 * 60_000;
    await approve(a, stale.result.id);
    expect((await proposals(stale.result.id)).map((row) => row.status)).toEqual(["pending", "approved"]);
    expect(await approvedEvents(stale.result.id)).toHaveLength(1);
  });

  /** An owner approves through the approvals route while the customer has no address, so the run fails after the decision. */
  async function approvedButUnsent(session: Session, contactId: string, body: string) {
    const drafted = await draft(a, contactId, body);
    const [proposal] = await proposals(drafted.result.id);
    tick();
    const error = await rejection(session.approveApproval(proposal!.id, {}, randomUUID()));
    expect(error.details).toMatchObject({ reason: "no_email" });
    expect(await proposals(drafted.result.id)).toEqual([expect.objectContaining({ status: "approved" })]);
    return { replyId: drafted.result.id, approvalId: proposal!.id };
  }
  const giveEmail = (contactId: string, email: string) => fixture.service((tx) => tx.query(
    "UPDATE crm_contacts SET normalized_email=$3 WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, contactId, email]));

  it("a new call finishes a send whose run failed after approval, and a retry of that call replays", async () => {
    const customer = await contact(a, { displayName: "Abel Kerr", phone: "+15555550191" });
    const { replyId, approvalId } = await approvedButUnsent(a, customer, "Ready when you are.");
    await giveEmail(customer, "abel@example.com");
    tick();
    const key = randomUUID();
    const sent = await a.approveReply(replyId, {}, key);
    expect(sent.result).toMatchObject({ status: "approved", approvedBy: { userId: owner.userId } });
    const check = await fixture.service((tx) => approvalForAction(tx, fixture.a.tenantId, sent.actionId, new Date(now)));
    expect(check).toMatchObject({ kind: "stored", approval: { id: approvalId } });
    // The same key replays the send (I-6); a new key is not_draft; one event in all.
    expect(await a.approveReply(replyId, {}, key)).toEqual(sent);
    expect((await rejection(a.approveReply(replyId, {}, randomUUID()))).details).toMatchObject({ reason: "not_draft", status: "approved" });
    expect(await approvedEvents(replyId)).toHaveLength(1);
    // A key bound to one reply's send is refused for another reply's.
    const other = await approvedButUnsent(a, await contact(a, { displayName: "Abel's office", phone: "+15555550193" }), "A second note.");
    expect((await rejection(a.approveReply(other.replyId, {}, key))).code).toBe("Conflict");
    expect(await replyRow(other.replyId)).toMatchObject({ status: "draft" });
  });

  it("a proposal another owner approved is theirs to finish; the conflict names them", async () => {
    const second = await addMember(fixture.a.tenantId, "owner");
    const secondSession = sessionFor(second.userId);
    const customer = await contact(a, { displayName: "Bea Lowe", phone: "+15555550192" });
    const { replyId } = await approvedButUnsent(a, customer, "Your fitting is set.");
    await giveEmail(customer, "bea@example.com");
    const error = await rejection(approve(secondSession, replyId));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "approved_by_other", approvedBy: owner.userId } });
    expect(mapError(error).body.error.details).toEqual({ reason: "approved_by_other", approvedBy: owner.userId });
    expect(await replyRow(replyId)).toMatchObject({ status: "draft" });
    await approve(a, replyId);
    expect(await replyRow(replyId)).toMatchObject({ status: "approved" });
  });

  it("a reply with no address is refused before the decision, so its proposal stays pending", async () => {
    const phoneOnly = await contact(a, { displayName: "Zed Hart", phone: "+15555550188" });
    const drafted = await draft(a, phoneOnly, "No address");
    expect((await rejection(approve(a, drafted.result.id))).details).toMatchObject({ reason: "no_email" });
    expect(await proposals(drafted.result.id)).toEqual([expect.objectContaining({ status: "pending", decided_by: null })]);
  });
});
