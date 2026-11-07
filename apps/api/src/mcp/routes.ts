// hub-access.md H-5, H-7, H-8: `POST /mcp`, the remote MCP endpoint for an automation token.
// Stateless Streamable HTTP with JSON answers: every request builds its own server and transport
// and disposes both when the answer is out; no session ID is issued or accepted. HTTP-level
// answers come before MCP handling, in this order: 405 (not POST), 413 (body over 64 KiB), 401
// (tag checked against the server key before any database query, then the token row), 429 (two
// fixed-window buckets charged in one statement), 404 (a session ID), 400 (a batch or bad JSON).
// Original code.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  apiErrorBody,
  createAutomationInbound,
  createTokenReads,
  mapError,
  parseInput,
  recordTokenUsage,
  type AutomationKeySecrets,
  type EdgeDependencies,
} from "@zs/core";
import type { AppEnv } from "../app.js";
import type { RateLimit, RateLimiter } from "../public/limiter.js";
import { MCP_INSTRUCTIONS, toolsFor, type ToolDefinition } from "./tools.js";

export const MCP_PATH = "/mcp";
/** H-7: units per token, counted one per authenticated request. */
export const MCP_MINUTE_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };
export const MCP_HOUR_LIMIT: RateLimit = { limit: 2_000, windowMs: 3_600_000 };
const BODY_LIMIT_BYTES = 64 * 1024;
const SERVER_INFO = { name: "zs-business", version: "0.1.0" } as const;

export interface McpEdgeDependencies {
  readonly keySecrets: AutomationKeySecrets;
  /** The shared Postgres limiter (H-7), so every API instance charges the same buckets. */
  readonly limiter: RateLimiter;
  /** Receives a failed usage increment (H-8); it never fails the request. */
  readonly report?: (error: unknown) => void;
}

/** A JSON-RPC error answer for a request the HTTP layer refuses before MCP handling. */
const rpcError = (c: Context, status: 400 | 404 | 405, code: number, message: string, headers: Record<string, string> = {}) =>
  c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);

const toolResult = (value: Record<string, unknown>, isError = false): CallToolResult => ({
  ...(isError ? { isError } : {}), content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
});

/** What one request did, for the usage record (H-8). */
interface Outcome { reads: number; proposals: number; refused: boolean }

/**
 * The server for one request. Only the tools the token's scopes allow are listed; calling any
 * other tool is -32601 and does not reveal whether it exists (H-5). A domain error is a tool
 * result with `isError`; an outage, a revoked token or a fault is kept in `fatal` so the HTTP
 * layer answers 503, 401 or 500 after the SDK has finished with the exchange.
 */
function buildServer(tools: readonly ToolDefinition[], run: (tool: ToolDefinition, args: unknown) => Promise<Record<string, unknown>>,
  outcome: Outcome, fail: (error: unknown) => void): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: MCP_INSTRUCTIONS });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools)
    // The SDK lists each tool with its JSON schema. Calls are dispatched below, so a malformed
    // call carries the ValidationFailed body of the contracts schema, not bare "-32602" text.
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      (() => toolResult({}, true)) as never);
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      outcome.refused = true;
      throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    }
    try {
      const output = await run(tool, request.params.arguments);
      if (tool.kind === "proposal") outcome.proposals += 1; else outcome.reads += 1;
      return toolResult(output);
    } catch (error) {
      const mapped = mapError(error);
      outcome.refused = true;
      if (mapped.status >= 500 || mapped.status === 401) {
        fail(error);
        return toolResult(mapped.body as unknown as Record<string, unknown>, true);
      }
      return toolResult(mapped.body as unknown as Record<string, unknown>, true);
    }
  });
  return server;
}

export function mcpRoutes(config: McpEdgeDependencies, requestEdge: (c: Context<AppEnv>) => EdgeDependencies) {
  const tooLarge = (c: Context) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413);
  const noStore = { "Cache-Control": "no-store" };

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .post("/", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: tooLarge }), async (c) => {
      const edge = requestEdge(c);
      const principal = await createAutomationInbound(edge, config).authenticate(c.req.header("Authorization"));

      // H-8: one row increment per authenticated request, whatever it ends as. A failure is logged.
      const outcome: Outcome = { reads: 0, proposals: 0, refused: false };
      const record = async (refused: boolean) => {
        try {
          await recordTokenUsage(edge, principal, {
            requests: 1, reads: outcome.reads, proposals: outcome.proposals, refusals: refused || outcome.refused ? 1 : 0,
          });
        } catch (error) {
          config.report?.(error);
        }
      };

      // H-7: both buckets are charged in one statement, before the request is handled.
      const taken = await config.limiter.take([
        { key: `mcp-minute:${principal.tokenId}`, rule: MCP_MINUTE_LIMIT },
        { key: `mcp-hour:${principal.tokenId}`, rule: MCP_HOUR_LIMIT },
      ], { signal: c.var.signal, remainingMs: edge.timeLeft ?? (() => Infinity) });
      if (!taken.ok) {
        await record(true);
        return c.json(apiErrorBody("RateLimited", "Too many requests"), 429, { "Retry-After": String(taken.retryAfterSeconds) });
      }

      const refuse = async (response: Response) => {
        await record(true);
        return response;
      };
      if (c.req.header("Mcp-Session-Id") !== undefined)
        return refuse(rpcError(c, 404, -32001, "Session not found: this endpoint keeps no sessions"));
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refuse(rpcError(c, 400, -32700, "Parse error: the body is not valid JSON"));
      }
      if (Array.isArray(body)) return refuse(rpcError(c, 400, -32600, "Batch requests are not supported"));

      const inbound = createAutomationInbound(edge, config);
      const reads = createTokenReads(edge);
      let fatal: unknown;
      const server = buildServer(toolsFor(principal.scopes), (tool, args) =>
        tool.run(parseInput(tool.inputSchema, args ?? {}, `arguments for ${tool.name}`) as never, { principal, inbound, reads }),
      outcome, (error) => { fatal ??= error; });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      let response: Response;
      try {
        await server.connect(transport);
        response = await transport.handleRequest(c.req.raw, { parsedBody: body });
      } finally {
        await server.close().catch(() => undefined);
      }
      await record(response.status >= 400 || (fatal !== undefined && mapError(fatal).status === 401));
      if (fatal !== undefined) throw fatal;
      return response;
    })
    // H-5: the endpoint answers POST only; there is no server-initiated stream to open or end.
    .all("/", (c) => rpcError(c, 405, -32000, "Method not allowed", { Allow: "POST", ...noStore }));
}
