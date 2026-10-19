import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  bookingPageSchema,
  contactPageSchema,
  createBookingOutputSchema,
  createDealOutputSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
  resourceSummarySchema,
  slotsResponseSchema,
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
import { createHs256Verifier, createLocalStubSessionCheck, type TokenVerifier } from "@zs/core";
import { createMcpServer, type AccessTokenSource } from "../src/server.js";

const NOW = "2026-10-19T08:00:00.000Z";
/** Synthetic HS256 key, built at runtime so secret scanners do not flag a literal. */
const SECRET = ["mcp", "test", "secret", "x".repeat(32)].join("-");
const clock = { now: () => new Date(NOW) };
let database: TestDatabase;
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
  { at = clock, verifier = createHs256Verifier(SECRET, { clock: at }) }: { at?: { now(): Date }; verifier?: TokenVerifier } = {},
): Promise<Client> {
  const server = createMcpServer({
    db: database.db, clock: at, generateId: randomUUID, verifier, sessionCheck: createLocalStubSessionCheck(database.db, at), accessToken,
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
      "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0),($1,$4,$3,'Won',1)",
      [fixture.a.tenantId, tenant.stages[0], tenant.pipelineId, tenant.stages[1]],
    );
  });
  client = await connect(fixture.a.tenantId);
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
      "create_booking", "create_deal", "find_slots", "list_bookings", "list_contacts",
      "list_deals", "list_pipelines", "list_resources", "move_deal_stage", "upsert_contact",
    ]);
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
    expect(pipelines.map((item) => pipelineSummarySchema.parse(item).id)).toEqual([tenant.pipelineId]);
    const resources = ((await callTool(client, "list_resources")).value as { items: unknown[] }).items;
    expect(resources.map((item) => resourceSummarySchema.parse(item))).toEqual([
      { id: tenant.resourceId, name: "Showroom", timeZone: "UTC", slotLengthMinutes: 60 },
    ]);
    for (const tool of ["list_contacts", "list_deals", "list_bookings", "list_pipelines", "list_resources"])
      expect(((await callTool(other, tool)).value as { items: unknown[] }).items).toEqual([]);
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
