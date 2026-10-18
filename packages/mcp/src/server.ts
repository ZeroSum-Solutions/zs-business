// Thin MCP adapter over @zs/core. Every tool parses with the contracts schemas and calls the
// same edge session the HTTP API uses. Tenant and actor come only from injected config.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createBookingRequestSchema,
  createDealRequestSchema,
  idempotencyKeySchema,
  listBookingsQuerySchema,
  listDealsQuerySchema,
  moveDealStageRequestSchema,
  pageQuerySchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  uuidSchema,
} from "@zs/contracts";
import { createSession, mapError, type EdgeDependencies, type Principal } from "@zs/core";

export interface McpDependencies extends EdgeDependencies {
  /** The tenant and actor this server acts for; tool input can never change them. */
  readonly principal: Principal;
  readonly name?: string;
  readonly version?: string;
}

const keyed = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject({ idempotencyKey: idempotencyKeySchema, ...shape });

function result(value: unknown): CallToolResult {
  const structured = { result: value } as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: structured };
}
async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await work());
  } catch (error) {
    const { body } = mapError(error);
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  }
}

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const read = { readOnlyHint: true, openWorldHint: false };

export function createMcpServer(deps: McpDependencies): McpServer {
  const session = createSession(deps, deps.principal);
  const server = new McpServer({ name: deps.name ?? "zs-business", version: deps.version ?? "0.0.0" });

  server.registerTool("create_booking", {
    description: "Book a slot on a booking resource. Fails with Conflict if the slot is taken. Reuse the idempotencyKey to retry safely.",
    inputSchema: keyed(createBookingRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => run(() => session.createBooking(body, idempotencyKey)));

  server.registerTool("upsert_contact", {
    description: "Create a contact, or return the existing one that has the same email or phone.",
    inputSchema: keyed(upsertContactRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => run(() => session.upsertContact(body, idempotencyKey)));

  server.registerTool("create_deal", {
    description: "Create a deal for a contact in a pipeline stage.",
    inputSchema: keyed(createDealRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => run(() => session.createDeal(body, idempotencyKey)));

  server.registerTool("move_deal_stage", {
    description: "Move a deal to another stage of its pipeline. expectedRevision must match the deal's current revision.",
    inputSchema: keyed({ dealId: uuidSchema, ...moveDealStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, dealId, ...body }) => run(() => session.moveDealStage(dealId, body, idempotencyKey)));

  server.registerTool("list_contacts", {
    description: "List contacts, newest first.", inputSchema: pageQuerySchema, annotations: read,
  }, (query) => run(() => session.listContacts(query)));

  server.registerTool("list_deals", {
    description: "List deals, most recently updated first; optionally one pipeline.",
    inputSchema: listDealsQuerySchema, annotations: read,
  }, (query) => run(() => session.listDeals(query)));

  server.registerTool("list_pipelines", {
    description: "List pipelines with their ordered stages.", inputSchema: z.strictObject({}), annotations: read,
  }, () => run(() => session.listPipelines()));

  server.registerTool("list_bookings", {
    description: "List bookings by start time; optionally one resource.",
    inputSchema: listBookingsQuerySchema, annotations: read,
  }, (query) => run(() => session.listBookings(query)));

  server.registerTool("list_resources", {
    description: "List bookable resources (calendars).", inputSchema: z.strictObject({}), annotations: read,
  }, () => run(() => session.listResources()));

  server.registerTool("find_slots", {
    description: "Find free slots on a resource between two UTC instants (at most 31 days).",
    inputSchema: slotsQuerySchema, annotations: read,
  }, (query) => run(() => session.findSlots(query)));

  return server;
}
