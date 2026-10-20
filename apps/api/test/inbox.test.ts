import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  MESSAGE_SEND_REQUESTED,
  replyOutputSchema,
  threadDetailSchema,
  threadPageSchema,
  type ThreadSummary,
} from "@zs/contracts";
import {
  call,
  createApiHarness,
  KEY_SECRET,
  NOW,
  provisionPage,
  signedInMember,
  type ApiHarness,
  type MemberSetup,
  type PageSetup,
  type TenantSetup,
} from "./helpers.js";

// inbox-home.md I-1..I-8 over HTTP, as zs_runtime on a real database. The injected clock starts
// at the fixed test instant and only moves when a test ticks it, so entries get a known order.
let now = Date.parse(NOW);
const testClock = { now: () => new Date(now) };
/** Move the clock on; the harness tokens (issued at NOW, one hour) stay valid well past the ticks here. */
const tick = (seconds = 10) => { now += seconds * 1000; return new Date(now).toISOString(); };
let h: ApiHarness;
let page: PageSetup;
let calendarId: string;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness({
    clock: testClock,
    publicIntake: {
      keySecrets: { current: KEY_SECRET },
      clientIp: { header: "x-real-ip" },
      limits: {
        addressWrites: { limit: 1000, windowMs: 600_000 },
        addressReads: { limit: 1000, windowMs: 600_000 },
        tenantWrites: { limit: 1000, windowMs: 3_600_000 },
      },
    },
  });
  // An all-week calendar of hour slots, so every request below gets its own free slot.
  calendarId = randomUUID();
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [h.a.tenantId, calendarId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })))],
  ));
  page = await provisionPage(h, h.a, { resourceIds: [calendarId] });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

let slot = 0;
/** The next free hour after the test clock, one per website request. */
const nextSlot = () => new Date(Date.parse(NOW) + (++slot) * 3_600_000).toISOString();
let address = 0;

/** A website visitor's request on tenant A's page, as the hosted widget sends it. */
async function websiteRequest(over: Record<string, unknown> = {}) {
  const body = {
    resourceId: calendarId,
    startsAt: nextSlot(),
    name: "Mira Rowe",
    email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`,
    phone: null,
    notes: null,
    consent: { email: false, sms: false },
    disclosureVersion: "v1",
    channel: "widget",
    website: "",
    ...over,
  };
  const response = await call(h.app, "POST", `/public/v1/pages/${page.key}/requests`, {
    body, key: randomUUID(), headers: { "X-Real-IP": `203.0.113.${(++address % 250) + 1}` },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const item = (await h.fixture.service((tx) => tx.query<{ contact_id: string | null; status: string }>(
    "SELECT contact_id, status FROM intake_items WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, response.body.requestId],
  ))).rows[0]!;
  return { requestId: response.body.requestId as string, contactId: item.contact_id, status: item.status, body, reply: response.body };
}

const get = (path: string, token = h.a.token) => call(h.app, "GET", path, { token });
const draft = (body: unknown, token = h.a.token, key: string = randomUUID()) =>
  call(h.app, "POST", "/v1/inbox/replies", { token, key, body });
const step = (replyId: string, action: "approve" | "discard", token = h.a.token, key: string = randomUUID()) =>
  call(h.app, "POST", `/v1/inbox/replies/${replyId}/${action}`, { token, key, body: {} });
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;

async function allThreads(token = h.a.token): Promise<ThreadSummary[]> {
  const response = await get("/v1/inbox/threads?limit=100", token);
  expect(response.status).toBe(200);
  return threadPageSchema.parse(response.body).items;
}
const outbox = (tenant: TenantSetup) => h.fixture.service(async (tx) => (await tx.query<{ event_type: string; payload: unknown }>(
  "SELECT event_type, payload FROM outbox WHERE tenant_id=$1 AND event_type=$2 ORDER BY created_at, id", [tenant.tenantId, MESSAGE_SEND_REQUESTED],
)).rows);
async function ownerContact(token: string, body: Record<string, unknown>) {
  const response = await call(h.app, "POST", "/v1/crm/contacts", { token, key: randomUUID(), body });
  expect(response.status).toBeLessThan(300);
  return response.body.result.contact.id as string;
}

describe("threads from website requests (I-1..I-3, I-8)", () => {
  it("shows a new visitor's request, with its notes and booking, in that customer's thread", async () => {
    const requestedAt = tick();
    const request = await websiteRequest({ name: "Ines Marchetti", notes: "Resizing my grandmother's ring, size 6 to 7?" });
    expect(request.status).toBe("new_contact");
    const contactId = request.contactId!;
    const threadId = `c_${contactId}`;
    const summary = (await allThreads()).find((thread) => thread.id === threadId);
    expect(summary).toEqual({
      id: threadId, kind: "customer", contactId, intakeItemId: null, name: "Ines Marchetti",
      email: request.body.email, preview: "Resizing my grandmother's ring, size 6 to 7?", lastActivityAt: requestedAt,
      needsReply: true, needsReview: false, drafts: 0,
    });
    const thread = await get(`/v1/inbox/threads/${threadId}`);
    expect(thread.status).toBe(200);
    expect(threadDetailSchema.parse(thread.body)).toEqual({
      ...summary, phone: null, olderEntries: false,
      entries: [{
        type: "request", id: request.requestId, at: requestedAt, channel: "widget", status: "new_contact", name: "Ines Marchetti",
        notes: "Resizing my grandmother's ring, size 6 to 7?",
        booking: { id: expect.any(String), resourceId: calendarId, startsAt: request.reply.startsAt, endsAt: request.reply.endsAt },
      }],
    });
    // Thread IDs are case-insensitive UUIDs (I-2).
    expect((await get(`/v1/inbox/threads/${threadId.toUpperCase().replace("C_", "c_")}`)).body).toEqual(thread.body);
  });

  it("keeps a request that matches an existing customer in a visitor thread until the owner links it", async () => {
    const email = `noor.${randomUUID().slice(0, 8)}@example.com`;
    const existing = await ownerContact(h.a.token, { displayName: "Noor Halvorsen", email });
    const request = await websiteRequest({ name: "Noor H", email, notes: "Is the pearl strand ready?" });
    expect(request).toMatchObject({ status: "possible_match", contactId: null });
    const visitorId = `v_${request.requestId}`;
    expect((await allThreads()).find((thread) => thread.id === visitorId)).toMatchObject({
      kind: "visitor", contactId: null, intakeItemId: request.requestId, name: "Noor H", needsReview: true, needsReply: false,
    });
    // The customer has no thread yet: the visitor's message is not in it.
    expect((await get(`/v1/inbox/threads/c_${existing}`)).status).toBe(404);
    // A visitor thread takes no replies; linking moves the request into the customer's thread.
    const linked = await call(h.app, "POST", `/v1/intake/items/${request.requestId}/link`, {
      token: h.a.token, key: randomUUID(), body: { contactId: existing },
    });
    expect(linked.status).toBe(200);
    expect((await get(`/v1/inbox/threads/${visitorId}`)).status).toBe(404);
    const thread = threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${existing}`)).body);
    expect(thread).toMatchObject({ kind: "customer", name: "Noor Halvorsen", preview: "Is the pearl strand ready?", needsReply: true });
    expect(thread.entries.map((entry) => entry.type === "request" && entry.status)).toEqual(["linked"]);
  });

  it("pages threads by cursor without repeats", async () => {
    await websiteRequest();
    await websiteRequest();
    const all = (await allThreads()).map((thread) => thread.id);
    const first = threadPageSchema.parse((await get("/v1/inbox/threads?limit=2")).body);
    expect(first.items.map((thread) => thread.id)).toEqual(all.slice(0, 2));
    const next = threadPageSchema.parse((await get(`/v1/inbox/threads?limit=2&cursor=${first.nextCursor}`)).body);
    expect(next.items.map((thread) => thread.id)).toEqual(all.slice(2, 4));
    expect((await get("/v1/inbox/threads?limit=0")).status).toBe(400);
  });

  it("answers a malformed thread ID with 400 and an unknown one with 404", async () => {
    for (const bad of ["nope", `x_${randomUUID()}`, `c_${randomUUID()}x`, randomUUID(), "c_"]) {
      const response = await get(`/v1/inbox/threads/${bad}`);
      expect(response.status, bad).toBe(400);
      expect(errorOf(response).code).toBe("ValidationFailed");
    }
    for (const unknown of [`c_${randomUUID()}`, `v_${randomUUID()}`]) {
      const response = await get(`/v1/inbox/threads/${unknown}`);
      expect(response.status).toBe(404);
      expect(errorOf(response)).toEqual({ code: "NotFound", message: "Not found", details: {} });
    }
  });
});

describe("replies (I-4..I-7)", () => {
  it("drafts, then approves as the owner: the reply is fixed and one send request reaches the outbox", async () => {
    const { contactId } = await websiteRequest({ name: "Lucia Fenwick", notes: "Do you restring pearls?" });
    const before = await outbox(h.a);
    const draftedAt = tick();
    const key = randomUUID();
    const body = { contactId: contactId!, subject: "  Your pearl strand  ", body: "  Yes, we restring pearls on site. Bring it in any weekday.  " };
    const drafted = await draft(body, h.a.token, key);
    expect(drafted.status).toBe(201);
    const reply = replyOutputSchema.parse(drafted.body).result;
    expect(reply).toEqual({
      id: reply.id, tenantId: h.a.tenantId, contactId, channel: "email", subject: "Your pearl strand",
      body: "Yes, we restring pearls on site. Bring it in any weekday.", status: "draft",
      draftedBy: { userId: h.a.actorId, email: h.a.email }, createdAt: draftedAt,
      approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null,
    });
    // A replay is the same draft; a draft writes no outbox event.
    expect(await draft(body, h.a.token, key)).toMatchObject({ status: 201, body: drafted.body });
    expect(await outbox(h.a)).toEqual(before);
    const waiting = threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body);
    expect(waiting).toMatchObject({ drafts: 1, needsReply: true, preview: reply.body });
    expect(waiting.entries.map((entry) => entry.type)).toEqual(["request", "reply"]);

    const approvedAt = tick();
    const approveKey = randomUUID();
    const approved = await step(reply.id, "approve", h.a.token, approveKey);
    expect(approved.status).toBe(200);
    expect(replyOutputSchema.parse(approved.body).result).toEqual({
      ...reply, status: "approved", approvedBy: { userId: h.a.actorId, email: h.a.email }, approvedAt,
    });
    expect(await step(reply.id, "approve", h.a.token, approveKey)).toMatchObject({ status: 200, body: approved.body });
    expect(await outbox(h.a)).toEqual([...before, {
      event_type: MESSAGE_SEND_REQUESTED,
      payload: {
        messageId: reply.id, contactId, channel: "email", purpose: "transactional",
        subject: "Your pearl strand", body: "Yes, we restring pearls on site. Bring it in any weekday.",
      },
    }]);
    const answered = threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body);
    expect(answered).toMatchObject({ drafts: 0, needsReply: false });

    // An approved reply is no longer a draft: neither a second approval nor a discard applies.
    for (const action of ["approve", "discard"] as const) {
      const again = await step(reply.id, action);
      expect(again.status).toBe(409);
      expect(errorOf(again)).toMatchObject({ code: "Conflict", details: { reason: "not_draft", status: "approved" } });
    }
    expect(await outbox(h.a)).toHaveLength(before.length + 1);
  });

  it("writes the default subject when none is given", async () => {
    const { contactId } = await websiteRequest();
    const drafted = await draft({ contactId, body: "Thanks for booking." });
    expect(replyOutputSchema.parse(drafted.body).result.subject).toBe("Message from Tenant A");
  });

  it("discards a draft: it leaves the thread and writes nothing to the outbox", async () => {
    const { contactId } = await websiteRequest({ notes: "Can I change my time?" });
    const before = await outbox(h.a);
    tick();
    const reply = replyOutputSchema.parse((await draft({ contactId, body: "Of course, which day suits?" })).body).result;
    const discardedAt = tick();
    const discarded = await step(reply.id, "discard");
    expect(discarded.status).toBe(200);
    expect(replyOutputSchema.parse(discarded.body).result).toMatchObject({ status: "discarded", discardedAt, approvedAt: null });
    const thread = threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body);
    expect(thread).toMatchObject({ drafts: 0, preview: "Can I change my time?" });
    expect(thread.entries.map((entry) => entry.type)).toEqual(["request"]);
    const late = await step(reply.id, "approve");
    expect(errorOf(late)).toMatchObject({ code: "Conflict", details: { reason: "not_draft", status: "discarded" } });
    expect(await outbox(h.a)).toEqual(before);
  });

  it("refuses to approve a reply to a customer without an email address", async () => {
    const contactId = await ownerContact(h.a.token, { displayName: "Desmond Lyle", phone: "+12025550104" });
    const reply = replyOutputSchema.parse((await draft({ contactId, body: "Your repair is ready." })).body).result;
    const refused = await step(reply.id, "approve");
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toEqual({ code: "Conflict", message: "Request conflicts with the current state", details: { reason: "no_email" } });
    expect(threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body)).toMatchObject({ drafts: 1, email: null });
  });

  it("lets staff read and draft, and refuses them approval with 403 (H-6)", async () => {
    const { contactId } = await websiteRequest({ notes: "Staff can see this" });
    expect((await allThreads(staff.token)).some((thread) => thread.id === `c_${contactId}`)).toBe(true);
    expect((await get(`/v1/inbox/threads/c_${contactId}`, staff.token)).status).toBe(200);
    const drafted = await draft({ contactId, body: "We will be in touch." }, staff.token);
    expect(drafted.status).toBe(201);
    const reply = replyOutputSchema.parse(drafted.body).result;
    expect(reply.draftedBy).toEqual({ userId: staff.actorId, email: staff.email });
    const before = await outbox(h.a);
    const refused = await step(reply.id, "approve", staff.token);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("Forbidden");
    expect(await outbox(h.a)).toEqual(before);
    // Still a draft the owner can approve; staff may discard their own drafts.
    expect(threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body).drafts).toBe(1);
    const second = replyOutputSchema.parse((await draft({ contactId, body: "Second thought." }, staff.token)).body).result;
    expect((await step(second.id, "discard", staff.token)).status).toBe(200);
    expect((await step(reply.id, "approve")).status).toBe(200);
  });

  it("validates bodies, IDs and the idempotency key", async () => {
    const { contactId } = await websiteRequest();
    for (const body of [
      { contactId, body: "   " },
      { contactId, body: "x".repeat(5001) },
      { contactId, body: "ok", subject: "two\nlines" },
      { contactId, body: "ok", subject: "x".repeat(201) },
      { contactId: "nope", body: "ok" },
      { contactId, body: "ok", tenantId: h.b.tenantId },
    ]) {
      const response = await draft(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(errorOf(response).code).toBe("ValidationFailed");
    }
    expect((await call(h.app, "POST", "/v1/inbox/replies", { token: h.a.token, body: { contactId, body: "ok" } })).status).toBe(400);
    const reply = replyOutputSchema.parse((await draft({ contactId, body: "ok" })).body).result;
    expect((await step("nope", "approve")).status).toBe(400);
    expect((await call(h.app, "POST", `/v1/inbox/replies/${reply.id}/approve`, {
      token: h.a.token, key: randomUUID(), body: { note: "x" },
    })).status).toBe(400);
    expect((await call(h.app, "POST", `/v1/inbox/replies/${reply.id}/discard`, { token: h.a.token, body: {} })).status).toBe(400);
    // An unknown reply is refused like another tenant's.
    expect((await step(randomUUID(), "approve")).status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("shows another tenant nothing and refuses its writes on this tenant's customers and replies", async () => {
    const { contactId } = await websiteRequest({ notes: "Private to tenant A" });
    const reply = replyOutputSchema.parse((await draft({ contactId, body: "Tenant A only" })).body).result;
    const theirs = await allThreads(h.b.token);
    expect(theirs).toEqual([]);
    const hidden = await get(`/v1/inbox/threads/c_${contactId}`, h.b.token);
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden).code).toBe("NotFound");
    const foreignDraft = await draft({ contactId, body: "From tenant B" }, h.b.token);
    expect(foreignDraft.status).toBe(403);
    for (const action of ["approve", "discard"] as const) {
      const response = await step(reply.id, action, h.b.token);
      expect(response.status, action).toBe(403);
      expect(errorOf(response).code).toBe("Forbidden");
    }
    expect(await outbox(h.b)).toEqual([]);
    const thread = threadDetailSchema.parse((await get(`/v1/inbox/threads/c_${contactId}`)).body);
    expect(thread.entries.flatMap((entry) => (entry.type === "reply" ? [entry.reply] : []))).toEqual([reply]);
    // A signed-in user whose token claims tenant A but who is no member of it reads nothing.
    const claimsA = await signedInMember(h.database, h.fixture, h.a.tenantId, "owner", { membership: false });
    expect((await get("/v1/inbox/threads", claimsA.token)).status).toBe(403);
  });
});
