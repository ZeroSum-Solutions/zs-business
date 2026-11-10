import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  approvalOutputSchema,
  approvalPageSchema,
  approvalRecordSchema,
  bookingPageSchema,
  followUpRunPageSchema,
  followUpStatusOutputSchema,
  followUpStatusSchema,
  homeResultsSchema,
  MESSAGE_SEND_REQUESTED,
  replyOutputSchema,
  setDealDetailsOutputSchema,
  threadDetailSchema,
  threadPageSchema,
  contactPageSchema,
  contactRecordSchema,
  cancelBookingOutputSchema,
  createBookingOutputSchema,
  createDealOutputSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  observeSourceOutputSchema,
  pipelineSummarySchema,
  stageOutputSchema,
  resourceSummarySchema,
  slotsResponseSchema,
  sourceListSchema,
} from "@zs/contracts";
import {
  createTestDatabase,
  createTwoTenantFixture,
  endAuthSession,
  startAuthSession,
  upsertAuthUser,
  type TestDatabase,
  type TwoTenantFixture,
} from "@zs/db/testing";
import { createHs256Verifier, createLocalStubSessionCheck, createSession, generateSealKeyPair, parseSealPublicKey, sealRefreshToken, type TokenVerifier } from "@zs/core";
import { createMcpServer, type AccessTokenSource } from "../src/server.js";

const NOW = "2026-10-19T08:00:00.000Z";
/** Synthetic HS256 key, built at runtime so secret scanners do not flag a literal. */
const SECRET = ["mcp", "test", "secret", "x".repeat(32)].join("-");
const clock = { now: () => new Date(NOW) };
let database: TestDatabase;
/** The member `client` acts as, for owner steps no MCP tool offers (approvals.md A-6). */
let ownerId: string;
let fixture: TwoTenantFixture;
let client: Client;
let other: Client;
const tenant = { resourceId: randomUUID(), pipelineId: randomUUID(), stages: [randomUUID(), randomUUID()] as const };

interface Member {
  tenantId: string;
  actorId: string;
  sessionId: string;
  memberId: string;
  token: string;
}

/** A Supabase-shaped access token, as Supabase Auth issues it (one hour by default). */
async function sign(
  member: Pick<Member, "tenantId" | "actorId" | "sessionId">,
  { secret = SECRET, at = clock, ttlSeconds = 3600 }: { secret?: string; at?: { now(): Date }; ttlSeconds?: number } = {},
): Promise<string> {
  const issuedAt = Math.floor(at.now().getTime() / 1000);
  return new SignJWT({ role: "authenticated", session_id: member.sessionId, app_metadata: { tenant_id: member.tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(member.actorId)
    .setAudience("authenticated")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

/** An auth user with a live session and, unless role is null, a membership row; plus their token. */
async function signedInMember(tenantId: string, role: "owner" | "staff" | null): Promise<Member> {
  const memberId = randomUUID();
  const email = `${role ?? "outsider"}-${memberId.slice(0, 8)}@example.com`;
  const actorId = await upsertAuthUser(database.pool, { email, appMetadata: { tenant_id: tenantId } });
  const sessionId = await startAuthSession(database.pool, actorId);
  if (role)
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [tenantId, memberId, email, actorId, role, NOW],
    ));
  const member = { tenantId, actorId, sessionId, memberId };
  return { ...member, token: await sign(member) };
}

/** A server acting with `accessToken`, verified like the API does, over an in-memory transport. */
async function serve(
  accessToken: AccessTokenSource,
  { at = clock, verifier = createHs256Verifier(SECRET, { clock: at }), outreach }: { at?: { now(): Date }; verifier?: TokenVerifier; outreach?: { tenants: readonly string[] } } = {},
): Promise<Client> {
  const server = createMcpServer({
    db: database.db, clock: at, generateId: randomUUID, verifier, sessionCheck: createLocalStubSessionCheck(database.db, at), accessToken,
    ...(outreach ? { outreach } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connected = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

/** A signed-in member of the tenant and a server acting with their token. */
async function connect(tenantId: string, role: "owner" | "staff" | null = "owner"): Promise<Client> {
  return serve((await signedInMember(tenantId, role)).token);
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'Showroom','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
      [fixture.a.tenantId, tenant.resourceId, JSON.stringify([{ weekday: 1, windows: [{ startMinute: 540, endMinute: 1020 }] }])],
    );
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [fixture.a.tenantId, tenant.pipelineId]);
    await tx.query(
      `INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome)
       VALUES ($1,$2,$3,'New',0,'open'),($1,$4,$3,'Won',1,'won')`,
      [fixture.a.tenantId, tenant.stages[0], tenant.pipelineId, tenant.stages[1]],
    );
  });
  const owner = await signedInMember(fixture.a.tenantId, "owner");
  ownerId = owner.actorId;
  client = await serve(owner.token);
  other = await connect(fixture.b.tenantId);
});
afterAll(async () => {
  await Promise.all([client?.close(), other?.close()]);
  await database?.close();
});

async function callTool(target: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await target.callTool({ name, arguments: args }) as CallToolResult;
  const text = response.content[0]?.type === "text" ? response.content[0].text : "null";
  const value = JSON.parse(text) as unknown;
  // Success and error alike carry one object, as JSON text and as structuredContent.
  expect(response.structuredContent).toEqual(value);
  return { isError: response.isError === true, value, raw: response };
}

describe("MCP tools over an in-memory transport", () => {
  let contactId = "";
  let dealId = "";

  it("lists every write and read tool", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "archive_stage", "cancel_booking", "create_booking", "create_deal", "create_stage", "discard_reply", "draft_reply", "find_slots", "get_approval", "get_contact",
      "get_followup_agent", "get_followup_run", "get_thread", "home_results", "list_approvals", "list_bookings", "list_contacts",
      "list_deals", "list_followup_runs", "list_pipelines", "list_resources", "list_sources", "list_threads", "move_deal_stage",
      "observe_source", "rename_stage", "reorder_stages", "request_approval", "restore_stage", "set_deal_details", "stop_followup_agent", "upsert_contact",
    ]);
    // Only an owner turns the agent on, resumes it or runs it (agents.md G-11).
    expect(names.filter((name) => /resume|settings|run_followup/.test(name))).toEqual([]);
    // Deciding stays with the owner in the dashboard or API: an agent cannot approve its own proposal.
    expect(names.filter((name) => /approve|reject|revoke/.test(name))).toEqual([]);
  });

  it("upsert_contact creates, then matches by email", async () => {
    const first = await callTool(client, "upsert_contact", { idempotencyKey: "c-1", displayName: "Maren", email: "maren@example.com" });
    const again = await callTool(client, "upsert_contact", { idempotencyKey: "c-2", email: "MAREN@example.com" });
    const created = createOrFindContactOutputSchema.parse(first.value).result;
    expect(created.created).toBe(true);
    expect(createOrFindContactOutputSchema.parse(again.value).result).toMatchObject({ created: false, contact: { id: created.contact.id } });
    contactId = created.contact.id;
  });

  it("create_deal and move_deal_stage go through the action path", async () => {
    const created = createDealOutputSchema.parse((await callTool(client, "create_deal", {
      idempotencyKey: "d-1", contactId, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], title: "Ring",
    })).value).result;
    dealId = created.id;
    const moved = await callTool(client, "move_deal_stage", {
      idempotencyKey: "m-1", dealId, pipelineId: tenant.pipelineId, stageId: tenant.stages[1], expectedRevision: 1,
    });
    expect(moveDealStageOutputSchema.parse(moved.value).result).toMatchObject({ stageId: tenant.stages[1], revision: 2 });
    const stale = await callTool(client, "move_deal_stage", {
      idempotencyKey: "m-2", dealId, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], expectedRevision: 1,
    });
    expect(stale.isError).toBe(true);
    expect(apiErrorBodySchema.parse(stale.value).error).toMatchObject({ code: "Conflict", details: { reason: "stale_revision" } });
  });

  it("find_slots and create_booking; a replayed key returns the same booking", async () => {
    const slots = slotsResponseSchema.parse((await callTool(client, "find_slots", {
      resourceId: tenant.resourceId, from: "2026-10-19T09:00:00.000Z", to: "2026-10-19T12:00:00.000Z",
    })).value);
    expect(slots.slots.map((slot) => slot.startsAt)).toEqual([
      "2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z", "2026-10-19T11:00:00.000Z",
    ]);
    const args = { idempotencyKey: "b-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T09:00:00.000Z" };
    const first = await callTool(client, "create_booking", args);
    const replay = await callTool(client, "create_booking", args);
    expect(createBookingOutputSchema.parse(first.value).result.status).toBe("confirmed");
    expect(replay.value).toEqual(first.value);
    const taken = await callTool(client, "create_booking", { ...args, idempotencyKey: "b-2" });
    expect(apiErrorBodySchema.parse(taken.value).error.code).toBe("Conflict");
  });

  it("list tools return only the configured tenant's rows", async () => {
    const contacts = contactPageSchema.parse((await callTool(client, "list_contacts", { limit: 10 })).value);
    const deals = dealPageSchema.parse((await callTool(client, "list_deals")).value);
    const bookings = bookingPageSchema.parse((await callTool(client, "list_bookings")).value);
    expect(contacts.items.map((item) => item.id)).toEqual([contactId]);
    expect(deals.items.map((item) => item.id)).toEqual([dealId]);
    expect(bookings.items).toHaveLength(1);
    const pipelines = ((await callTool(client, "list_pipelines")).value as { items: unknown[] }).items;
    expect(pipelines.map((item) => pipelineSummarySchema.parse(item))).toEqual([{ id: tenant.pipelineId, name: "Sales", stages: [
      { id: tenant.stages[0], name: "New", position: 0, outcome: "open" }, { id: tenant.stages[1], name: "Won", position: 1, outcome: "won" },
    ], archivedStages: [] }]);
    const resources = ((await callTool(client, "list_resources")).value as { items: unknown[] }).items;
    expect(resources.map((item) => resourceSummarySchema.parse(item))).toEqual([
      { id: tenant.resourceId, name: "Showroom", timeZone: "UTC", slotLengthMinutes: 60 },
    ]);
    for (const tool of ["list_contacts", "list_deals", "list_bookings", "list_pipelines", "list_resources"])
      expect(((await callTool(other, tool)).value as { items: unknown[] }).items).toEqual([]);
  });

  it("get_contact and the read filters answer from SQL, for this tenant only", async () => {
    const one = await callTool(client, "get_contact", { contactId });
    expect(contactRecordSchema.parse(one.value)).toMatchObject({ id: contactId, displayName: "Maren" });
    const hidden = await callTool(other, "get_contact", { contactId });
    expect(apiErrorBodySchema.parse(hidden.value).error.code).toBe("NotFound");
    const search = (args: Record<string, unknown>) => callTool(client, "list_contacts", args)
      .then((response) => contactPageSchema.parse(response.value).items.map((item) => item.id));
    expect(await search({ search: "AREN" })).toEqual([contactId]);
    expect(await search({ search: "nobody" })).toEqual([]);
    expect(await search({ ids: contactId, sort: "name" })).toEqual([contactId]);
    const deals = dealPageSchema.parse((await callTool(client, "list_deals", { contactId })).value);
    expect(deals.items).toEqual([{
      id: dealId, tenantId: fixture.a.tenantId, contactId, pipelineId: tenant.pipelineId, stageId: tenant.stages[1], title: "Ring",
      revision: 2, createdAt: NOW, updatedAt: NOW, value: null, leadSource: null, wonAt: NOW,
    }]);
    const range = (from: string, to: string) => callTool(client, "list_bookings", { from, to })
      .then((response) => bookingPageSchema.parse(response.value).items.length);
    expect(await range("2026-10-19T09:30:00.000Z", "2026-10-19T09:31:00.000Z")).toBe(1);
    expect(await range("2026-10-19T10:00:00.000Z", "2026-10-20T00:00:00.000Z")).toBe(0);
  });

  it("request_approval creates a pending approval as the token's member; list_approvals and get_approval read it", async () => {
    const staff = await signedInMember(fixture.a.tenantId, "staff");
    const mcp = await serve(staff.token);
    try {
      const bookingId = randomUUID();
      const action = {
        actionType: "booking.create", target: { type: "booking", id: bookingId },
        payload: { bookingId, resourceId: tenant.resourceId, startsAt: "2026-10-19T13:00:00.000Z" },
      };
      const args = { idempotencyKey: "ap-1", action, summary: "Book the showroom at 13:00" };
      const requested = await callTool(mcp, "request_approval", args);
      expect(requested.isError, JSON.stringify(requested.value)).toBe(false);
      const approval = approvalOutputSchema.parse(requested.value).result;
      expect(approval).toMatchObject({
        tenantId: fixture.a.tenantId, actionType: "booking.create", target: { tenantId: fixture.a.tenantId, ...action.target },
        payload: action.payload, summary: args.summary, status: "pending", standing: "pending", requestedBy: staff.actorId,
        decidedBy: null, executedActionId: null,
      });
      // Seven days by default; nothing was booked.
      expect(approval.expiresAt).toBe("2026-10-26T08:00:00.000Z");
      expect((await callTool(mcp, "request_approval", args)).value).toEqual(requested.value);
      expect(bookingPageSchema.parse((await callTool(client, "list_bookings", { from: "2026-10-19T13:00:00.000Z", to: "2026-10-19T14:00:00.000Z" })).value).items).toEqual([]);

      const mine = approvalPageSchema.parse((await callTool(mcp, "list_approvals", { status: "pending" })).value);
      expect(mine.items.map((item) => item.id)).toEqual([approval.id]);
      const owners = approvalPageSchema.parse((await callTool(client, "list_approvals")).value);
      expect(owners.items.map((item) => item.id)).toContain(approval.id);
      expect(approvalRecordSchema.parse((await callTool(mcp, "get_approval", { approvalId: approval.id })).value)).toEqual(approval);

      expect(approvalPageSchema.parse((await callTool(other, "list_approvals")).value).items).toEqual([]);
      expect(apiErrorBodySchema.parse((await callTool(other, "get_approval", { approvalId: approval.id })).value).error.code).toBe("NotFound");
      const rows = await fixture.service((tx) => tx.query<{ action_type: string }>(
        "SELECT action_type FROM actions WHERE tenant_id=$1 AND actor_id=$2", [staff.tenantId, staff.actorId],
      ));
      expect(rows.rows.map((row) => row.action_type)).toEqual(["approval.request"]);
      // approvals.md A-7: the run key approval:<id> is the server's, never a tool's.
      const reserved = await callTool(mcp, "upsert_contact", { idempotencyKey: `approval:${approval.id}`, displayName: "Ada" });
      expect(reserved.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("observe_source and list_sources round-trip for a contact, for this tenant only", async () => {
    const observed = await callTool(client, "observe_source", {
      idempotencyKey: "src-1", subject: { type: "contact", id: contactId }, source: "website",
      sourceRef: "form/contact", observedAt: "2026-10-19T07:00:00.000Z", freshForMinutes: 120,
    });
    expect(observed.isError, JSON.stringify(observed.value)).toBe(false);
    const { record, applied } = observeSourceOutputSchema.parse(observed.value).result;
    expect(applied).toBe(true);
    expect(record).toMatchObject({
      tenantId: fixture.a.tenantId, subject: { type: "contact", id: contactId }, source: "website", sourceRef: "form/contact",
      observedAt: "2026-10-19T07:00:00.000Z", freshUntil: "2026-10-19T09:00:00.000Z", fresh: true, revision: 1,
    });
    const listed = sourceListSchema.parse((await callTool(client, "list_sources", { subjectType: "contact", subjectId: contactId })).value);
    expect(listed.items).toEqual([record]);
    const hidden = await callTool(other, "list_sources", { subjectType: "contact", subjectId: contactId });
    expect(apiErrorBodySchema.parse(hidden.value).error.code).toBe("NotFound");
  });

  it("another tenant's server cannot move this tenant's deal", async () => {
    const denied = await callTool(other, "move_deal_stage", {
      idempotencyKey: "x-1", dealId, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], expectedRevision: 2,
    });
    expect(apiErrorBodySchema.parse(denied.value).error.code).toBe("Forbidden");
  });

  it("refuses a signed-in user who is not a member of the token's tenant", async () => {
    const stranger = await connect(fixture.a.tenantId, null);
    try {
      for (const [name, args] of [["list_contacts", {}], ["upsert_contact", { idempotencyKey: "s-1", email: "s@example.com" }]] as const) {
        const denied = await callTool(stranger, name, args);
        expect(denied.isError).toBe(true);
        expect(apiErrorBodySchema.parse(denied.value).error.code).toBe("Forbidden");
      }
    } finally {
      await stranger.close();
    }
  });

  it("rejects tenant or actor fields in tool input with the shared error body", async () => {
    const response = await callTool(client, "upsert_contact", {
      idempotencyKey: "t-1", email: "x@example.com", tenantId: fixture.b.tenantId,
    });
    expect(response.isError).toBe(true);
    const body = apiErrorBodySchema.parse(response.raw.structuredContent);
    expect(body).toEqual(response.value);
    expect(body.error.code).toBe("ValidationFailed");
    expect(JSON.stringify(body.error.details)).toContain("tenantId");
    expect(contactPageSchema.parse((await callTool(other, "list_contacts")).value).items).toEqual([]);
  });

  it.each([
    ["upsert_contact", { idempotencyKey: "v-1", email: "bad" }, "email"],
    ["upsert_contact", { email: "x@example.com" }, "idempotencyKey"],
    ["create_booking", { idempotencyKey: "v-2", resourceId: "not-a-uuid", start: "soon" }, "resourceId"],
    ["list_contacts", { limit: "many" }, "limit"],
    ["list_pipelines", { extra: true }, "extra"],
    ["request_approval", { idempotencyKey: "v-3", summary: "x", action: { actionType: "booking.create" } }, "target"],
    ["observe_source", { idempotencyKey: "v-4", subject: { type: "contact", id: randomUUID() }, source: "Not A Name" }, "source"],
    ["list_sources", { subjectType: "planet", subjectId: randomUUID() }, "subjectType"],
  ])("normalizes malformed %s arguments into ValidationFailed", async (name, args, field) => {
    const response = await callTool(client, name, args);
    expect(response.isError).toBe(true);
    const body = apiErrorBodySchema.parse(response.raw.structuredContent);
    expect(body).toEqual(response.value);
    expect(body.error.code).toBe("ValidationFailed");
    expect(JSON.stringify(body.error.details)).toContain(field);
  });

  it("still advertises each tool's real input schema", async () => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "upsert_contact");
    expect(tool?.inputSchema.required).toContain("idempotencyKey");
    expect(tool?.inputSchema.properties).toHaveProperty("email");
    expect(tool?.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it("reports an unknown tool as a protocol error", async () => {
    await expect(client.callTool({ name: "drop_tables", arguments: {} })).rejects.toThrow(/-32602.*drop_tables not found/);
  });

  it("set_deal_details sets value and lead source with the deal's revision", async () => {
    const value = { amountMinor: 480_000, currency: "USD" };
    const set = await callTool(client, "set_deal_details", { idempotencyKey: "dd-1", dealId, expectedRevision: 2, value, leadSource: "referral" });
    expect(setDealDetailsOutputSchema.parse(set.value).result).toMatchObject({ id: dealId, revision: 3, value, leadSource: "referral", wonAt: NOW });
    const stale = await callTool(client, "set_deal_details", { idempotencyKey: "dd-2", dealId, expectedRevision: 2, value: null, leadSource: null });
    expect(apiErrorBodySchema.parse(stale.value).error).toMatchObject({
      code: "Conflict", details: { reason: "stale_revision", currentRevision: 3 },
    });
    const foreign = await callTool(other, "set_deal_details", { idempotencyKey: "dd-3", dealId, expectedRevision: 3, value: null, leadSource: null });
    expect(apiErrorBodySchema.parse(foreign.value).error.code).toBe("Forbidden");
  });

  it("edits a pipeline's stages: create, rename, reorder, archive, restore; a foreign tenant is refused", async () => {
    const pipelineId = randomUUID();
    const first = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Lessons')", [fixture.a.tenantId, pipelineId]);
      await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'Enquiry',0)", [fixture.a.tenantId, first, pipelineId]);
    });
    const created = await callTool(client, "create_stage", { idempotencyKey: "st-1", pipelineId, name: "Trial lesson" });
    const board = stageOutputSchema.parse(created.value).result;
    expect(board.stages.map((stage) => stage.name)).toEqual(["Enquiry", "Trial lesson"]);
    const trial = board.stages[1]!.id;
    const renamed = stageOutputSchema.parse((await callTool(client, "rename_stage", { idempotencyKey: "st-2", stageId: trial, name: "Trial" })).value).result;
    expect(renamed.stages[1]!.name).toBe("Trial");
    const reordered = stageOutputSchema.parse((await callTool(client, "reorder_stages", { idempotencyKey: "st-3", pipelineId, stageIds: [trial, first] })).value).result;
    expect(reordered.stages.map((stage) => stage.name)).toEqual(["Trial", "Enquiry"]);
    const archived = stageOutputSchema.parse((await callTool(client, "archive_stage", { idempotencyKey: "st-4", stageId: first })).value).result;
    expect(archived.archivedStages.map((stage) => stage.name)).toEqual(["Enquiry"]);
    const restored = stageOutputSchema.parse((await callTool(client, "restore_stage", { idempotencyKey: "st-5", stageId: first })).value).result;
    expect(restored.stages.map((stage) => stage.name)).toEqual(["Trial", "Enquiry"]);
    const foreign = await callTool(other, "archive_stage", { idempotencyKey: "st-6", stageId: first });
    expect(apiErrorBodySchema.parse(foreign.value).error.code).toBe("Forbidden");
  });

  it("draft_reply proposes the send; once an owner approves, one send request reaches the outbox", async () => {
    const drafted = await callTool(client, "draft_reply", { idempotencyKey: "r-1", contactId, subject: "Your ring", body: "Your ring is ready." });
    const reply = replyOutputSchema.parse(drafted.value).result;
    expect(reply).toMatchObject({ contactId, subject: "Your ring", body: "Your ring is ready.", status: "draft" });
    const threads = threadPageSchema.parse((await callTool(client, "list_threads")).value);
    expect(threads.items).toEqual([{
      id: `c_${contactId}`, kind: "customer", contactId, intakeItemId: null, name: "Maren", email: "maren@example.com",
      preview: "Your ring is ready.", lastActivityAt: NOW, needsReply: false, needsReview: false, drafts: 1,
    }]);
    const thread = threadDetailSchema.parse((await callTool(client, "get_thread", { threadId: `c_${contactId}` })).value);
    expect(thread.entries).toEqual([{ type: "reply", at: NOW, reply }]);
    // The draft waits as a pending approval; no MCP tool decides one (approvals.md A-6).
    const pending = approvalPageSchema.parse((await callTool(client, "list_approvals", { status: "pending" })).value).items
      .filter((approval) => approval.actionType === "inbox.reply.send");
    expect(pending).toEqual([expect.objectContaining({
      target: { tenantId: fixture.a.tenantId, type: "inbox_reply", id: reply.id }, payload: { replyId: reply.id },
    })]);
    const owner = createSession({ db: database.db, clock, generateId: randomUUID }, { tenantId: fixture.a.tenantId, actorId: ownerId });
    const approved = await owner.approveReply(reply.id, {}, "ra-1");
    expect(approved.result).toMatchObject({ id: reply.id, status: "approved", approvedAt: NOW });
    const again = await callTool(client, "discard_reply", { idempotencyKey: "rd-1", replyId: reply.id });
    expect(apiErrorBodySchema.parse(again.value).error).toMatchObject({ code: "Conflict", details: { reason: "not_draft", status: "approved" } });
    const events = await fixture.service((tx) => tx.query<{ payload: unknown }>(
      "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type=$2", [fixture.a.tenantId, MESSAGE_SEND_REQUESTED]));
    expect(events.rows).toEqual([{ payload: {
      messageId: reply.id, contactId, channel: "email", purpose: "transactional", subject: "Your ring", body: "Your ring is ready.",
    } }]);

    const second = replyOutputSchema.parse((await callTool(client, "draft_reply", { idempotencyKey: "r-2", contactId, body: "Never mind." })).value).result;
    expect(second.subject).toBe("Message from Tenant A");
    expect(replyOutputSchema.parse((await callTool(client, "discard_reply", { idempotencyKey: "rd-2", replyId: second.id })).value).result.status)
      .toBe("discarded");

    // Another tenant sees no thread and cannot draft to, approve or discard this tenant's replies.
    expect(threadPageSchema.parse((await callTool(other, "list_threads")).value).items).toEqual([]);
    expect(apiErrorBodySchema.parse((await callTool(other, "get_thread", { threadId: `c_${contactId}` })).value).error.code).toBe("NotFound");
    expect(apiErrorBodySchema.parse((await callTool(other, "draft_reply", { idempotencyKey: "x-r", contactId, body: "Hi" })).value).error.code)
      .toBe("Forbidden");
    const third = replyOutputSchema.parse((await callTool(client, "draft_reply", { idempotencyKey: "r-3", contactId, body: "Hello again." })).value).result;
    expect(apiErrorBodySchema.parse((await callTool(other, "discard_reply", { idempotencyKey: "x-discard", replyId: third.id })).value).error.code)
      .toBe("Forbidden");
    const bad = await callTool(client, "get_thread", { threadId: "nope" });
    expect(apiErrorBodySchema.parse(bad.value).error.code).toBe("ValidationFailed");
  });

  it("home_results counts this week against last week from the injected clock", async () => {
    const results = homeResultsSchema.parse((await callTool(client, "home_results", { zone: "UTC" })).value);
    expect(results).toEqual({
      zone: "UTC", weekStart: "monday",
      thisWeek: { from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" },
      lastWeek: { from: "2026-10-12T00:00:00.000Z", to: "2026-10-12T08:00:00.000Z" },
      leads: { thisWeek: 1, lastWeek: 0, bySource: [
        { source: "website", thisWeek: 0, lastWeek: 0 }, { source: "manual", thisWeek: 1, lastWeek: 0 },
      ] },
      bookings: { thisWeek: 1, lastWeek: 0, bySource: [
        { source: "website", thisWeek: 0, lastWeek: 0 }, { source: "owner", thisWeek: 1, lastWeek: 0 },
      ] },
      wonDeals: { thisWeek: 1, lastWeek: 0 },
      revenue: [{ currency: "USD", thisWeek: 480_000, lastWeek: 0, bySource: [{ source: "referral", thisWeek: 480_000, lastWeek: 0 }] }],
    });
    const bad = await callTool(client, "home_results", { weekStart: "friday" });
    expect(apiErrorBodySchema.parse(bad.value).error.code).toBe("ValidationFailed");
  });
});

describe("authorization on every tool call, like the HTTP API", () => {
  /** The error code of a failed call; fails the test if the call succeeded. */
  async function errorCode(target: Client, name: string, args: Record<string, unknown> = {}) {
    const response = await callTool(target, name, args);
    expect(response.isError).toBe(true);
    return apiErrorBodySchema.parse(response.value).error.code;
  }
  async function succeeds(target: Client, name: string, args: Record<string, unknown> = {}) {
    const response = await callTool(target, name, args);
    expect(response.isError, JSON.stringify(response.value)).toBe(false);
    return response.value;
  }
  async function using<T>(target: Client, work: (target: Client) => Promise<T>): Promise<T> {
    try {
      return await work(target);
    } finally {
      await target.close();
    }
  }

  it("refuses the next call once the member signs out mid-process", async () => {
    const member = await signedInMember(fixture.a.tenantId, "owner");
    await using(await serve(member.token), async (mcp) => {
      await succeeds(mcp, "list_contacts");
      await endAuthSession(database.pool, member.sessionId);
      expect(await errorCode(mcp, "list_contacts")).toBe("Unauthorized");
      expect(await errorCode(mcp, "upsert_contact", { idempotencyKey: "out-1", email: "out@example.com" })).toBe("Unauthorized");
    });
  });

  it("refuses the next call once the member is removed from the tenant", async () => {
    const member = await signedInMember(fixture.a.tenantId, "staff");
    await using(await serve(member.token), async (mcp) => {
      await succeeds(mcp, "list_resources");
      await fixture.service((tx) => tx.query("DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2", [member.tenantId, member.memberId]));
      expect(await errorCode(mcp, "list_resources")).toBe("Forbidden");
      expect(await errorCode(mcp, "create_booking", {
        idempotencyKey: "rm-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T15:00:00.000Z",
      })).toBe("Forbidden");
    });
  });

  it("stops accepting the token once the injected clock passes its exp", async () => {
    let now = Date.parse(NOW);
    const at = { now: () => new Date(now) };
    const member = await signedInMember(fixture.a.tenantId, "owner");
    await using(await serve(await sign(member, { at, ttlSeconds: 600 }), { at }), async (mcp) => {
      await succeeds(mcp, "list_pipelines");
      now += 599_000;
      await succeeds(mcp, "list_pipelines");
      now += 2_000;
      expect(await errorCode(mcp, "list_pipelines")).toBe("Unauthorized");
    });
  });

  it("reads a function token source on every call", async () => {
    const member = await signedInMember(fixture.a.tenantId, "owner");
    let current = member.token;
    await using(await serve(() => current), async (mcp) => {
      await succeeds(mcp, "list_contacts");
      current = "not-a-token";
      expect(await errorCode(mcp, "list_contacts")).toBe("Unauthorized");
      current = await sign(member, { ttlSeconds: 1800 });
      await succeeds(mcp, "list_contacts");
    });
  });

  it("refuses a forged token (another key) and a malformed one", async () => {
    const member = await signedInMember(fixture.a.tenantId, "owner");
    const forged = await sign(member, { secret: "forged-".padEnd(32, "x") });
    for (const token of [forged, "", "Bearer x", `${member.token.split(".").slice(0, 2).join(".")}.`]) {
      await using(await serve(token), async (mcp) => {
        expect(await errorCode(mcp, "list_contacts")).toBe("Unauthorized");
        expect(await errorCode(mcp, "upsert_contact", { idempotencyKey: "f-1", email: "f@example.com" })).toBe("Unauthorized");
      });
    }
  });

  it("authenticates before parsing input, so an unauthenticated call learns nothing", async () => {
    await using(await serve("garbage"), async (mcp) => {
      expect(await errorCode(mcp, "upsert_contact", { email: "bad" })).toBe("Unauthorized");
    });
  });

  it("runs as the token's staff member: calendar and customer tools work, actions record that actor", async () => {
    const staff = await signedInMember(fixture.a.tenantId, "staff");
    await using(await serve(staff.token), async (mcp) => {
      const booked = createBookingOutputSchema.parse(await succeeds(mcp, "create_booking", {
        idempotencyKey: "staff-b-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T14:00:00.000Z",
      }));
      expect(booked.result.status).toBe("confirmed");
      await succeeds(mcp, "upsert_contact", { idempotencyKey: "staff-c-1", email: "staff-contact@example.com" });
      const actions = await fixture.service((tx) => tx.query<{ action_type: string }>(
        "SELECT action_type FROM actions WHERE tenant_id=$1 AND actor_id=$2 ORDER BY action_type", [staff.tenantId, staff.actorId],
      ));
      expect(actions.rows.map((row) => row.action_type)).toEqual(["booking.create", "crm.contact.create-or-find"]);
    });
  });

  it("lets staff draft replies, proposing each send, but refuses them home_results", async () => {
    const staff = await signedInMember(fixture.a.tenantId, "staff");
    await using(await serve(staff.token), async (mcp) => {
      const contact = createOrFindContactOutputSchema.parse(await succeeds(mcp, "upsert_contact", {
        idempotencyKey: "staff-c-2", displayName: "Tobias", email: "tobias@example.com",
      })).result.contact;
      const reply = replyOutputSchema.parse(await succeeds(mcp, "draft_reply", {
        idempotencyKey: "staff-r-1", contactId: contact.id, body: "We have your bands ready.",
      })).result;
      expect(reply.draftedBy.userId).toBe(staff.actorId);
      await succeeds(mcp, "list_threads");
      const mine = approvalPageSchema.parse(await succeeds(mcp, "list_approvals", { status: "pending" })).items;
      expect(mine.filter((approval) => approval.target.id === reply.id)).toEqual([expect.objectContaining({ requestedBy: staff.actorId })]);
      expect(await errorCode(mcp, "home_results")).toBe("Forbidden");
      await succeeds(mcp, "discard_reply", { idempotencyKey: "staff-rd-1", replyId: reply.id });
      // Discarding withdrew the staff member's own pending proposal (approvals.md A-8).
      expect(approvalPageSchema.parse(await succeeds(mcp, "list_approvals", {})).items
        .find((approval) => approval.target.id === reply.id)).toMatchObject({ status: "revoked" });
    });
  });

  it("lets staff read and stop the follow-up agent, for their own tenant only", async () => {
    const staff = await signedInMember(fixture.a.tenantId, "staff");
    await using(await serve(staff.token), async (mcp) => {
      expect(followUpStatusSchema.parse(await succeeds(mcp, "get_followup_agent"))).toMatchObject({ killed: null, canDraft: false });
      const stopped = followUpStatusOutputSchema.parse(await succeeds(mcp, "stop_followup_agent", { idempotencyKey: "staff-kill-1", note: "Pause" })).result;
      expect(stopped).toMatchObject({ killed: { by: staff.actorId, note: "Pause" }, canDraft: false });
      expect(followUpRunPageSchema.parse(await succeeds(mcp, "list_followup_runs")).items).toEqual([]);
      expect(await errorCode(mcp, "get_followup_run", { runId: randomUUID() })).toBe("NotFound");
      expect(await errorCode(mcp, "stop_followup_agent", { idempotencyKey: "agent:start:x" })).toBe("ValidationFailed");
    });
    expect(followUpStatusSchema.parse((await callTool(other, "get_followup_agent")).value).killed).toBeNull();
  });

  it("refuses a signed-in non-member even for calendar work", async () => {
    await using(await connect(fixture.a.tenantId, null), async (mcp) => {
      expect(await errorCode(mcp, "create_booking", {
        idempotencyKey: "nm-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T16:00:00.000Z",
      })).toBe("Forbidden");
    });
  });

  it("takes the tenant from the token: a tenant B member cannot touch tenant A rows", async () => {
    const memberB = await signedInMember(fixture.b.tenantId, "owner");
    await using(await serve(memberB.token), async (mcp) => {
      expect(await errorCode(mcp, "create_booking", {
        idempotencyKey: "xb-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T16:00:00.000Z",
      })).toBe("Forbidden");
      expect(((await succeeds(mcp, "list_bookings")) as { items: unknown[] }).items).toEqual([]);
      expect(((await succeeds(mcp, "list_resources")) as { items: unknown[] }).items).toEqual([]);
      // A token claiming tenant A for this tenant B member is refused: membership is per tenant.
      const claimsA = await sign({ ...memberB, tenantId: fixture.a.tenantId });
      await using(await serve(claimsA), async (forgedTenant) => {
        expect(await errorCode(forgedTenant, "list_contacts")).toBe("Forbidden");
      });
    });
    const slots = slotsResponseSchema.parse(await succeeds(client, "find_slots", {
      resourceId: tenant.resourceId, from: "2026-10-19T16:00:00.000Z", to: "2026-10-19T17:00:00.000Z",
    }));
    expect(slots.slots.map((slot) => slot.startsAt)).toEqual(["2026-10-19T16:00:00.000Z"]);
  });
});

describe("outreach tools (outreach-sequencer.md OS-22)", () => {
  const seal = parseSealPublicKey(generateSealKeyPair().publicKey);
  let allowed: Client;
  let staff: Client;
  let outsider: Client;
  let bare: Client;
  let mailboxId: string;
  let campaignId = "";

  beforeAll(async () => {
    mailboxId = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query(
        `UPDATE business_profiles SET time_zone='America/Los_Angeles', legal_name='Zero Sum Solutions LLC',
           postal_address='{"line1":"1 Market St","city":"San Francisco","region":"CA","postalCode":"94105","country":"US"}'::jsonb WHERE tenant_id=$1`, [fixture.a.tenantId]);
      await tx.query(
        `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,granted_scopes,daily_limit,created_at,updated_at)
         VALUES ($1,$2,'devin@zerosum-solutions.com','Sam Sender','active',$3,'{}',20,now(),now())`,
        [fixture.a.tenantId, mailboxId, sealRefreshToken(seal, { tenantId: fixture.a.tenantId, connectionId: mailboxId }, "fake-refresh")]);
    });
    const tokens = { owner: await signedInMember(fixture.a.tenantId, "owner"), staff: await signedInMember(fixture.a.tenantId, "staff"), out: await signedInMember(fixture.b.tenantId, "owner") };
    const outreach = { tenants: [fixture.a.tenantId] };
    allowed = await serve(tokens.owner.token, { outreach });
    staff = await serve(tokens.staff.token, { outreach });
    outsider = await serve(tokens.out.token, { outreach });
    bare = await serve(tokens.owner.token);
  });
  afterAll(async () => { await Promise.all([allowed?.close(), staff?.close(), outsider?.close(), bare?.close()]); });

  const campaign = () => ({
    idempotencyKey: `oc-${randomUUID()}`, name: "MCP campaign",
    steps: [{ subject: "Idea for {{company}}", body: "Hi {{first_name}}, a quick idea.", delayBusinessDays: 0 }],
    window: { start: "08:00", end: "10:30" }, dailyCapPerMailbox: 5, mailboxIds: [mailboxId],
  });

  it("is absent without an allowlist, and has no approve tool", async () => {
    const names = (await bare.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /outreach/.test(name))).toEqual([]);
    const withOutreach = (await allowed.listTools()).tools.map((tool) => tool.name).filter((name) => /outreach/.test(name)).sort();
    expect(withOutreach).toEqual([
      "create_outreach_campaign", "get_outreach_campaign", "import_outreach_prospects", "list_outreach_campaigns",
      "pause_outreach_campaign", "request_outreach_activation", "stop_outreach_prospect",
    ]);
    expect(withOutreach.filter((name) => /approve|reject|revoke|send/.test(name))).toEqual([]);
  });

  it("creates, imports, asks for activation, reads, stops a prospect and pauses", async () => {
    const created = await callTool(allowed, "create_outreach_campaign", campaign());
    expect(created.isError).toBe(false);
    campaignId = (created.value as { result: { id: string; status: string } }).result.id;
    expect((created.value as { result: { status: string } }).result.status).toBe("draft");

    const imported = await callTool(allowed, "import_outreach_prospects", {
      idempotencyKey: "oi-1", campaignId,
      prospects: [{ email: "pat@acme.example", firstName: "Pat", company: "Acme", opener: "Read your note on boilers." }, { email: "bad", firstName: "X", company: "Y" }],
    });
    expect(imported.value).toMatchObject({ result: { imported: 1, rejected: [{ index: 1, reason: "invalid_email" }] } });

    const asked = await callTool(allowed, "request_outreach_activation", { idempotencyKey: "oa-1", campaignId });
    expect(asked.isError).toBe(false);
    expect(typeof (asked.value as { approvalId: unknown }).approvalId).toBe("string");

    const detail = await callTool(allowed, "get_outreach_campaign", { campaignId });
    expect(detail.value).toMatchObject({ campaign: { id: campaignId, status: "draft" }, prospectCounts: { pending: 1 } });
    const list = await callTool(allowed, "list_outreach_campaigns");
    expect((list.value as { items: { id: string }[] }).items.map((item) => item.id)).toContain(campaignId);

    const paused = await callTool(allowed, "pause_outreach_campaign", { idempotencyKey: "op-1", campaignId });
    expect(paused.isError).toBe(false);
    // A draft has nothing to pause: the answer is the campaign as it is.
    expect(paused.value).toMatchObject({ result: { id: campaignId, status: "draft" } });
  });

  it("stops one prospect", async () => {
    const fresh = (await callTool(allowed, "create_outreach_campaign", campaign())).value as { result: { id: string } };
    await callTool(allowed, "import_outreach_prospects", { idempotencyKey: "oi-2", campaignId: fresh.result.id, prospects: [{ email: "lee@globex.example", firstName: "Lee", company: "Globex" }] });
    const rows = await fixture.service(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2", [fixture.a.tenantId, fresh.result.id])).rows);
    const stopped = await callTool(allowed, "stop_outreach_prospect", { idempotencyKey: "os-1", prospectId: rows[0]!.id });
    expect(stopped.value).toMatchObject({ result: { status: "stopped" } });
  });

  it("rejects a missing key, staff, and another tenant's campaign", async () => {
    const { idempotencyKey: _key, ...noKey } = campaign();
    expect((await callTool(allowed, "create_outreach_campaign", noKey)).isError).toBe(true);

    const denied = await callTool(staff, "list_outreach_campaigns");
    expect(denied.isError).toBe(true);
    expect(apiErrorBodySchema.parse(denied.value).error.code).toBe("Forbidden");

    const hidden = await callTool(outsider, "get_outreach_campaign", { campaignId });
    expect(hidden.isError).toBe(true);
    expect(apiErrorBodySchema.parse(hidden.value).error.code).toBe("NotFound");
    expect((await callTool(outsider, "pause_outreach_campaign", { idempotencyKey: "op-x", campaignId })).isError).toBe(true);
  });

  // Last: it creates bookings, and home_results above counts the bookings taken this week.
  it("cancel_booking frees the slot; a replayed key returns the same result and a foreign ID is not found", async () => {
    const args = { idempotencyKey: "cx-1", resourceId: tenant.resourceId, startsAt: "2026-10-19T12:00:00.000Z" };
    const booking = createBookingOutputSchema.parse((await callTool(client, "create_booking", args)).value).result;
    const cancelArgs = { idempotencyKey: "cx-2", bookingId: booking.id, reason: "Customer called" };
    const first = await callTool(client, "cancel_booking", cancelArgs);
    expect(cancelBookingOutputSchema.parse(first.value).result).toMatchObject({
      booking: { id: booking.id, status: "cancelled" }, reason: "Customer called", customerNotice: "no_customer",
    });
    expect((await callTool(client, "cancel_booking", cancelArgs)).value).toEqual(first.value);
    const rebooked = await callTool(client, "create_booking", { ...args, idempotencyKey: "cx-3" });
    const again = createBookingOutputSchema.parse(rebooked.value).result;
    expect(again.status).toBe("confirmed");
    // Leave no confirmed booking behind: later tests count the calendar.
    await callTool(client, "cancel_booking", { idempotencyKey: "cx-6", bookingId: again.id });
    const missing = await callTool(client, "cancel_booking", { idempotencyKey: "cx-4", bookingId: randomUUID() });
    expect(apiErrorBodySchema.parse(missing.value).error.code).toBe("NotFound");
    const bad = await callTool(client, "cancel_booking", { idempotencyKey: "cx-5", bookingId: booking.id, reason: "x".repeat(501) });
    expect(bad.isError).toBe(true);
  });
});
