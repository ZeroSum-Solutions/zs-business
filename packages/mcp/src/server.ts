// Thin MCP adapter over @zs/core. Every tool parses with the contracts schemas and calls the
// same edge session the HTTP API uses. Tenant and actor come only from injected config.
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import { createSession, mapError, parseInput, type EdgeDependencies, type Principal } from "@zs/core";

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

type ToolConfig<Input extends z.ZodObject> = {
  readonly description: string;
  readonly inputSchema: Input;
  readonly annotations: typeof write | typeof read;
};

export function createMcpServer(deps: McpDependencies): McpServer {
  const session = createSession(deps, deps.principal);
  const server = new McpServer({ name: deps.name ?? "zs-business", version: deps.version ?? "0.0.0" });
  const calls = new Map<string, (args: unknown) => Promise<CallToolResult>>();

  // The SDK lists each tool with its real JSON schema, but its own argument check would answer
  // a malformed call with bare "MCP error -32602" text. Calls are therefore dispatched below,
  // parsing with the same strict contracts schema so failures carry the ValidationFailed body.
  function tool<Input extends z.ZodObject>(name: string, config: ToolConfig<Input>, handler: (args: z.output<Input>) => Promise<unknown>): void {
    const call = (args: unknown) => run(() => handler(parseInput(config.inputSchema, args ?? {}, `arguments for ${name}`)));
    // Not reached while the dispatcher below owns tools/call; kept equivalent for safety.
    server.registerTool(name, config, ((args: unknown) => call(args)) as ToolCallback<Input>);
    calls.set(name, call);
  }

  tool("create_booking", {
    description: "Book a slot on a booking resource. Fails with Conflict if the slot is taken. Reuse the idempotencyKey to retry safely.",
    inputSchema: keyed(createBookingRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => session.createBooking(body, idempotencyKey));

  tool("upsert_contact", {
    description: "Create a contact, or return the existing one that has the same email or phone.",
    inputSchema: keyed(upsertContactRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => session.upsertContact(body, idempotencyKey));

  tool("create_deal", {
    description: "Create a deal for a contact in a pipeline stage.",
    inputSchema: keyed(createDealRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }) => session.createDeal(body, idempotencyKey));

  tool("move_deal_stage", {
    description: "Move a deal to another stage of its pipeline. expectedRevision must match the deal's current revision.",
    inputSchema: keyed({ dealId: uuidSchema, ...moveDealStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, dealId, ...body }) => session.moveDealStage(dealId, body, idempotencyKey));

  tool("list_contacts", {
    description: "List contacts, newest first.", inputSchema: pageQuerySchema, annotations: read,
  }, (query) => session.listContacts(query));

  tool("list_deals", {
    description: "List deals, most recently updated first; optionally one pipeline.",
    inputSchema: listDealsQuerySchema, annotations: read,
  }, (query) => session.listDeals(query));

  tool("list_pipelines", {
    description: "List pipelines with their ordered stages.", inputSchema: z.strictObject({}), annotations: read,
  }, () => session.listPipelines());

  tool("list_bookings", {
    description: "List bookings by start time; optionally one resource.",
    inputSchema: listBookingsQuerySchema, annotations: read,
  }, (query) => session.listBookings(query));

  tool("list_resources", {
    description: "List bookable resources (calendars).", inputSchema: z.strictObject({}), annotations: read,
  }, () => session.listResources());

  tool("find_slots", {
    description: "Find free slots on a resource between two UTC instants (at most 31 days).",
    inputSchema: slotsQuerySchema, annotations: read,
  }, (query) => session.findSlots(query));

  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const call = calls.get(request.params.name);
    if (!call) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    return call(request.params.arguments);
  });
  return server;
}
