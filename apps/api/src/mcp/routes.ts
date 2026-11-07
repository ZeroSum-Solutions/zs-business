// hub-access.md H-5, H-7, H-8: `POST /mcp`, the remote MCP endpoint for an automation token.
// Stateless Streamable HTTP with JSON answers: every request builds its own server and transport
// and disposes both when the answer is out; no session ID is issued or accepted. The checks run in
// the contract's order and the first to fail answers: 405 (not POST), 401 (the tag, pure CPU),
// 413 (body over 64 KiB, counted on the stream), 429 (two buckets charged in one statement on the
// tag's tenant and token, before the token row is read), 401 (the token row), 404 (a session ID),
// 400 (bad JSON, a batch, or JSON that is no JSON-RPC request). From the quota on, every exit
// builds one outcome and records it once (H-8), off the request deadline. Original code.
import { Hono, type Context } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  apiErrorBody,
  createAutomationInbound,
  createConnectionsTools,
  createTokenReads,
  mapError,
  parseInput,
  pruneTokenUsage,
  recordTokenUsage,
  type AutomationKeySecrets,
  type EdgeDependencies,
} from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import type { AppEnv } from "../app.js";
import type { RateLimit, RateLimiter } from "../public/limiter.js";
import { MCP_INSTRUCTIONS, ToolFailure, toolsFor, type ToolDefinition } from "./tools.js";

export const MCP_PATH = "/mcp";
/** H-7: units per token, counted one per request whose tag is valid. */
export const MCP_MINUTE_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };
export const MCP_HOUR_LIMIT: RateLimit = { limit: 2_000, windowMs: 3_600_000 };
const BODY_LIMIT_BYTES = 64 * 1024;
/** H-8 retention: each API instance prunes old usage rows on its first usage write, then at most hourly. */
export const USAGE_PRUNE_EVERY_MS = 3_600_000;
const USAGE_PRUNE_TIMEOUT_MS = 5_000;
/** H-8: the usage write has its own short budget; a slow write never holds a response for long. */
export const USAGE_WRITE_TIMEOUT_MS = 1_500;
const SERVER_INFO = { name: "zs-business", version: "0.1.0" } as const;

export interface McpEdgeDependencies {
  readonly keySecrets: AutomationKeySecrets;
  /** The shared Postgres limiter (H-7), so every API instance charges the same buckets. */
  readonly limiter: RateLimiter;
  /**
   * The usage write (H-8): the raw database and clock, not the request's deadline-bound edge, so a
   * request that ran out of time or lost its caller is still counted and a slow write cannot change
   * its answer. `timeoutMs` is the write's own budget.
   */
  readonly usage: { readonly db: ScopedDatabase; readonly clock: { now(): Date }; readonly timeoutMs?: number; readonly pruneEveryMs?: number };
  /** Receives a failed usage write (H-8); it never fails the request. */
  readonly report?: (error: unknown) => void;
}

/** A JSON-RPC error answer for a request the HTTP layer refuses before MCP handling. */
const rpcError = (c: Context, status: 400 | 404 | 405, code: number, message: string, headers: Record<string, string> = {}) =>
  c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status, headers);

const toolResult = (value: Record<string, unknown>, isError = false): CallToolResult => ({
  ...(isError ? { isError } : {}), content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
});

/** What the tools of one request did; the HTTP status and the response body complete the outcome. */
interface ToolOutcome { reads: number; proposals: number; refused: boolean }

/**
 * H-5 step 3: the body, counted on the stream. A declared length over the limit is refused without
 * reading; a missing or false one cannot get past, because the bytes actually read are counted.
 * Returns null when the body is too large.
 */
async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** A JSON-RPC request or notification: an object naming a method. */
const isRpcCall = (body: unknown): boolean =>
  typeof body === "object" && body !== null && !Array.isArray(body)
  && (body as { jsonrpc?: unknown }).jsonrpc === "2.0" && typeof (body as { method?: unknown }).method === "string";

/** Does the JSON-RPC answer carry an `error`? The SDK makes some itself (-32600, -32601, -32602). */
async function answerHasError(response: Response): Promise<boolean> {
  if (!response.headers.get("content-type")?.includes("json")) return false;
  try {
    const json: unknown = await response.clone().json();
    return typeof json === "object" && json !== null && "error" in json;
  } catch {
    return false;
  }
}

/**
 * The server for one request. Only the tools the token's scopes allow are listed (with their JSON
 * Schema computed once at module load); calling any other tool is -32601 and does not reveal
 * whether it exists (H-5). A domain error is a tool result with `isError`; an outage, a revoked
 * token or a fault is kept in `fail` so the HTTP layer answers 503, 401 or 500 after the SDK has
 * finished with the exchange.
 */
function buildServer(tools: readonly ToolDefinition[], run: (tool: ToolDefinition, args: unknown) => Promise<Record<string, unknown>>,
  outcome: ToolOutcome, fail: (error: unknown) => void): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed: Tool[] = tools.map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.jsonSchema as Tool["inputSchema"], annotations: { ...tool.annotations },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  // Calls are dispatched here, so a malformed call carries the ValidationFailed body of the
  // contracts schema, not bare "-32602" text.
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, "Method not found");
    try {
      const output = await run(tool, request.params.arguments);
      if (tool.kind === "proposal") outcome.proposals += 1; else outcome.reads += 1;
      return toolResult(output);
    } catch (error) {
      // C-10: a connection tool's domain error is its own result shape, never provider text.
      if (error instanceof ToolFailure) {
        if (error.refusal) outcome.refused = true;
        return toolResult(error.value, true);
      }
      const mapped = mapError(error);
      if (mapped.status >= 500 || mapped.status === 401) fail(error);
      else outcome.refused = true;
      return toolResult(mapped.body as unknown as Record<string, unknown>, true);
    }
  });
  return server;
}

export function mcpRoutes(config: McpEdgeDependencies, requestEdge: (c: Context<AppEnv>) => EdgeDependencies) {
  const tooLarge = (c: Context) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413);
  const noStore = { "Cache-Control": "no-store" };
  const usageTimeoutMs = config.usage.timeoutMs ?? USAGE_WRITE_TIMEOUT_MS;

  /**
   * H-8 retention: /mcp is the writer of usage rows, so it also keeps them in bounds. The prune
   * needs no service credential (it is a runtime-role function with a fixed 30 day floor), so it
   * runs whenever /mcp is on, whether or not the Activepieces webhook worker is.
   */
  let lastPrune = 0;
  let pruning = false;
  const pruneEveryMs = config.usage.pruneEveryMs ?? USAGE_PRUNE_EVERY_MS;
  const maybePrune = async () => {
    const started = Date.now();
    if (pruning || started - lastPrune < pruneEveryMs) return;
    pruning = true;
    lastPrune = started;
    try {
      await pruneTokenUsage({ db: config.usage.db, clock: config.usage.clock }, {
        signal: AbortSignal.timeout(USAGE_PRUNE_TIMEOUT_MS), remainingMs: () => USAGE_PRUNE_TIMEOUT_MS - (Date.now() - started),
      });
    } catch (error) {
      config.report?.(error);
    } finally {
      pruning = false;
    }
  };

  /** H-8: one increment, on the raw database with its own budget. A failure is reported, never raised. */
  const writeUsage = async (ref: { tenantId: string; tokenId: string }, delta: Parameters<typeof recordTokenUsage>[2]) => {
    const started = Date.now();
    try {
      await recordTokenUsage({ db: config.usage.db, clock: config.usage.clock }, ref, delta, {
        signal: AbortSignal.timeout(usageTimeoutMs), remainingMs: () => usageTimeoutMs - (Date.now() - started),
      });
    } catch (error) {
      config.report?.(error);
      return;
    }
    await maybePrune();
  };

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .post("/", async (c) => {
      const edge = requestEdge(c);
      const inbound = createAutomationInbound(edge, config);
      // 401 (tag): pure CPU, before any body or database work.
      const ref = inbound.verifyTag(c.req.header("Authorization"));
      // 413: the stream's own byte count.
      const text = await readBody(c.req.raw, BODY_LIMIT_BYTES);
      if (text === null) return tooLarge(c);

      // From here on every exit is one outcome, recorded once (H-8).
      const tools: ToolOutcome = { reads: 0, proposals: 0, refused: false };
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await handle(c, edge, inbound, ref, text, tools, (error) => { failure ??= error; });
        if (failure !== undefined) throw failure;
        return response;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await finish();
      }

      async function finish() {
        // The final status: what the client gets. A thrown error is what onError maps it to.
        const status = failure !== undefined ? mapError(failure).status : response!.status;
        // A token revoked during the request answers 401 and is not recorded (H-8).
        if (status === 401) return;
        const refused = status === 429 || (status >= 400 && status < 500) || tools.refused
          || (failure === undefined && response !== undefined && await answerHasError(response));
        await writeUsage(ref, { requests: 1, reads: tools.reads, proposals: tools.proposals, refusals: refused ? 1 : 0 });
      }
    })
    // H-5: the endpoint answers POST only; there is no server-initiated stream to open or end.
    .all("/", (c) => rpcError(c, 405, -32000, "Method not allowed", { Allow: "POST", ...noStore }));

  /** H-5 steps 4 to 7, then the SDK. Returns the response; a thrown error ends the request. */
  async function handle(
    c: Context<AppEnv>, edge: EdgeDependencies, inbound: ReturnType<typeof createAutomationInbound>,
    ref: { tenantId: string; tokenId: string }, text: string, tools: ToolOutcome, fail: (error: unknown) => void,
  ): Promise<Response> {
    // 429: charged on the tag's tenant and token before the token row is read. The limiter takes
    // both units or neither, so a refused request charges nothing.
    const taken = await config.limiter.take([
      { key: `mcp-minute:${ref.tenantId}:${ref.tokenId}`, rule: MCP_MINUTE_LIMIT },
      { key: `mcp-hour:${ref.tenantId}:${ref.tokenId}`, rule: MCP_HOUR_LIMIT },
    ], { signal: c.var.signal, remainingMs: edge.timeLeft ?? (() => Infinity) });
    if (!taken.ok)
      return c.json(apiErrorBody("RateLimited", "Too many requests"), 429, { "Retry-After": String(taken.retryAfterSeconds) });
    // 401: the token row.
    const principal = await inbound.principalFor(ref);
    // 404, 400.
    if (c.req.header("Mcp-Session-Id") !== undefined)
      return rpcError(c, 404, -32001, "Session not found: this endpoint keeps no sessions");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcError(c, 400, -32700, "Parse error: the body is not valid JSON");
    }
    if (Array.isArray(body)) return rpcError(c, 400, -32600, "Batch requests are not supported");
    if (!isRpcCall(body)) return rpcError(c, 400, -32600, "Invalid Request: the body is not a JSON-RPC request");

    const reads = createTokenReads(edge);
    // C-10: the connections tools exist only with the connections config.
    const connections = edge.connections ? createConnectionsTools(edge, principal.tenantId) : null;
    const server = buildServer(toolsFor(principal.scopes, { connections: connections !== null }), (tool, args) =>
      tool.run(parseInput(tool.inputSchema, args ?? {}, `arguments for ${tool.name}`) as never,
        { principal, inbound, reads, connections, signal: c.var.signal }),
    tools, fail);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } finally {
      await server.close().catch(() => undefined);
    }
  }
}
