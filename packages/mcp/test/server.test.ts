import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createMcpServer } from "../src/server.js";

const NOW = "2026-10-19T08:00:00.000Z";
let database: TestDatabase;
let fixture: TwoTenantFixture;
let client: Client;
let other: Client;
const tenant = { resourceId: randomUUID(), pipelineId: randomUUID(), stages: [randomUUID(), randomUUID()] as const };

async function connect(tenantId: string): Promise<Client> {
  const server = createMcpServer({
    db: database.db,
    clock: { now: () => new Date(NOW) },
    generateId: randomUUID,
    principal: { tenantId, actorId: randomUUID() },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const connected = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
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
