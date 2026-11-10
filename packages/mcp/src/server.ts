// Thin MCP adapter over @zs/core. Every tool call authenticates exactly like an HTTP request
// (@zs/core authenticate: verify the member's access token against the injected clock, require
// a live Supabase session and a membership), then parses with the contracts schemas and calls
// the same edge session the HTTP API uses, which checks the role per read or action. Tenant and
// actor come only from the verified token, never from tool input. An agent may propose an
// action for approval and read approvals, but there is deliberately no approve, reject or
// revoke tool: deciding stays with the owner in the dashboard or API, so an agent token
// cannot approve its own proposal.
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  archiveStageRequestSchema,
  cancelBookingRequestSchema,
  createStageRequestSchema,
  createBookingRequestSchema,
  createDealRequestSchema,
  createOutreachCampaignRequestSchema,
  draftReplyRequestSchema,
  importOutreachProspectsRequestSchema,
  idempotencyKeySchema,
  killFollowUpRequestSchema,
  listApprovalsQuerySchema,
  listFollowUpRunsQuerySchema,
  listBookingsQuerySchema,
  listContactsQuerySchema,
  listDealsQuerySchema,
  listSourcesQuerySchema,
  listThreadsQuerySchema,
  moveDealStageRequestSchema,
  renameStageRequestSchema,
  reorderStagesRequestSchema,
  observeSourceRequestSchema,
  requestApprovalRequestSchema,
  resultsQuerySchema,
  setDealDetailsRequestSchema,
  slotsQuerySchema,
  threadIdSchema,
  upsertContactRequestSchema,
  uuidSchema,
} from "@zs/contracts";
import { authenticate, createOutreachSession, mapError, parseInput, type EdgeDependencies, type Session, type SessionCheck, type TokenVerifier } from "@zs/core";

/** The member's Supabase access token, or a function returning the current one (read per call). */
export type AccessTokenSource = string | (() => string | Promise<string>);

export interface McpDependencies extends EdgeDependencies {
  /** The same verifier the HTTP API uses, checking times against `clock`. */
  readonly verifier: TokenVerifier;
  /** The same session check the HTTP API uses (Supabase Auth in production). */
  readonly sessionCheck: SessionCheck;
  /** Whose token this server acts with; the tenant and actor come only from it. */
  readonly accessToken: AccessTokenSource;
  readonly name?: string;
  readonly version?: string;
}

const keyed = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject({ idempotencyKey: idempotencyKeySchema, ...shape });

type ToolOutput = Record<string, unknown>;

/** The same object goes in `structuredContent` and, as JSON, in `content[0].text`. */
function result(value: ToolOutput, isError = false): CallToolResult {
  return { ...(isError ? { isError } : {}), content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
async function run(work: () => Promise<ToolOutput>): Promise<CallToolResult> {
  try {
    return result(await work());
  } catch (error) {
    return result(mapError(error).body, true);
  }
}

const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** An irreversible change: a cancelled booking cannot be reopened (booking.md B-30). */
const destructive = { ...write, destructiveHint: true };
const read = { readOnlyHint: true, openWorldHint: false };

type ToolConfig<Input extends z.ZodObject> = {
  readonly description: string;
  readonly inputSchema: Input;
  readonly annotations: typeof write | typeof read;
};

export function createMcpServer(deps: McpDependencies): McpServer {
  const edge: EdgeDependencies = { db: deps.db, clock: deps.clock, generateId: deps.generateId, ...(deps.outreach ? { outreach: deps.outreach } : {}) };
  const token = deps.accessToken;
  /** Authenticate on every call, so a signed-out, expired or removed member stops at once. */
  const authenticated = async (): Promise<Session> =>
    authenticate(edge, deps.verifier, deps.sessionCheck, typeof token === "string" ? token : await token());
  const server = new McpServer({ name: deps.name ?? "zs-business", version: deps.version ?? "0.0.0" });
  const calls = new Map<string, (args: unknown) => Promise<CallToolResult>>();

  // The SDK lists each tool with its real JSON schema, but its own argument check would answer
  // a malformed call with bare "MCP error -32602" text. Calls are therefore dispatched below,
  // parsing with the same strict contracts schema so failures carry the ValidationFailed body.
  // Authentication runs before the arguments are parsed, so an unauthenticated caller learns
  // nothing about the input schema beyond what tools/list already advertises.
  function tool<Input extends z.ZodObject>(
    name: string,
    config: ToolConfig<Input>,
    handler: (args: z.output<Input>, session: Session) => Promise<ToolOutput>,
  ): void {
    const call = (args: unknown) => run(async () => {
      const session = await authenticated();
      return handler(parseInput(config.inputSchema, args ?? {}, `arguments for ${name}`), session);
    });
    // Not reached while the dispatcher below owns tools/call; kept equivalent for safety.
    server.registerTool(name, config, ((args: unknown) => call(args)) as ToolCallback<Input>);
    calls.set(name, call);
  }

  tool("create_booking", {
    description: "Book a slot on a booking resource. Fails with Conflict if the slot is taken. Reuse the idempotencyKey to retry safely.",
    inputSchema: keyed(createBookingRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.createBooking(body, idempotencyKey));

  tool("cancel_booking", {
    description: "Cancel a booking and free its slot. The customer gets a cancellation email unless notifyCustomer is false. A booking that already ended cannot be cancelled. Reuse the idempotencyKey to retry safely.",
    inputSchema: keyed({ bookingId: uuidSchema, ...cancelBookingRequestSchema.shape }),
    annotations: destructive,
  }, ({ idempotencyKey, bookingId, ...body }, session) => session.cancelBooking(bookingId, body, idempotencyKey));

  tool("upsert_contact", {
    description: "Create a contact, or return the existing one that has the same email or phone.",
    inputSchema: keyed(upsertContactRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.upsertContact(body, idempotencyKey));

  tool("create_deal", {
    description: "Create a deal for a contact in a pipeline stage.",
    inputSchema: keyed(createDealRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.createDeal(body, idempotencyKey));

  tool("move_deal_stage", {
    description: "Move a deal to another stage of its pipeline. expectedRevision must match the deal's current revision.",
    inputSchema: keyed({ dealId: uuidSchema, ...moveDealStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, dealId, ...body }, session) => session.moveDealStage(dealId, body, idempotencyKey));

  tool("set_deal_details", {
    description: "Set a deal's value (minor units with an ISO 4217 currency, or null) and lead source (or null). expectedRevision must match the deal's current revision.",
    inputSchema: keyed({ dealId: uuidSchema, ...setDealDetailsRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, dealId, ...body }, session) => session.setDealDetails(dealId, body, idempotencyKey));

  tool("create_stage", {
    description: "Add a stage at the end of a pipeline (name up to 100 characters; outcome open, won or lost, default open). A pipeline holds at most 30 live stages. Answers with the whole pipeline.",
    inputSchema: keyed({ pipelineId: uuidSchema, ...createStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, pipelineId, ...body }, session) => session.createStage(pipelineId, body, idempotencyKey));

  tool("rename_stage", {
    description: "Rename a live stage. Two live stages of one pipeline cannot share a name. Answers with the whole pipeline.",
    inputSchema: keyed({ stageId: uuidSchema, ...renameStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, stageId, ...body }, session) => session.renameStage(stageId, body, idempotencyKey));

  tool("reorder_stages", {
    description: "Set the order of a pipeline's live stages: stageIds lists every live stage once, first to last. If the pipeline changed meanwhile the call fails with stage_set_changed; read list_pipelines and retry.",
    inputSchema: keyed({ pipelineId: uuidSchema, ...reorderStagesRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, pipelineId, ...body }, session) => session.reorderStages(pipelineId, body, idempotencyKey));

  tool("archive_stage", {
    description: "Archive a stage: it leaves the board and takes no new deals, and it can be restored. A stage that holds deals needs moveDealsTo (another live stage of the pipeline), and the deals move with it. The last live stage cannot be archived.",
    inputSchema: keyed({ stageId: uuidSchema, ...archiveStageRequestSchema.shape }),
    annotations: write,
  }, ({ idempotencyKey, stageId, ...body }, session) => session.archiveStage(stageId, body, idempotencyKey));

  tool("restore_stage", {
    description: "Bring an archived stage back, at the end of its pipeline.",
    inputSchema: keyed({ stageId: uuidSchema }),
    annotations: write,
  }, ({ idempotencyKey, stageId }, session) => session.restoreStage(stageId, idempotencyKey));

  tool("draft_reply", {
    description: "Draft an email reply to a customer (contactId, body, optional one-line subject; without one the server writes \"Message from <business name>\"). Nothing is sent: the draft waits as a pending approval (inbox.reply.send) until an owner approves it in the dashboard or API.",
    inputSchema: keyed(draftReplyRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.draftReply(body, idempotencyKey));

  tool("discard_reply", {
    description: "Discard a drafted reply that has not been approved; its pending approval is withdrawn where you may.",
    inputSchema: keyed({ replyId: uuidSchema }),
    annotations: write,
  }, ({ idempotencyKey, replyId }, session) => session.discardReply(replyId, {}, idempotencyKey));

  tool("list_threads", {
    description: "List inbox threads (one per customer, plus website requests not yet linked to one), latest activity first.",
    inputSchema: listThreadsQuerySchema, annotations: read,
  }, (query, session) => session.listThreads(query));

  tool("get_thread", {
    description: "Read one inbox thread (c_<contactId> or v_<intakeItemId>) with its requests and replies, oldest first.",
    inputSchema: z.strictObject({ threadId: threadIdSchema }), annotations: read,
  }, ({ threadId }, session) => session.getThread(threadId));

  tool("home_results", {
    description: "Leads, bookings and won revenue by source, this week so far against the same span of last week, in an IANA zone. Owners only.",
    inputSchema: resultsQuerySchema, annotations: read,
  }, (query, session) => session.homeResults(query));

  tool("list_contacts", {
    description: "List contacts, newest first or by name; optionally only those matching a search (name, email or phone) or a list of IDs.",
    inputSchema: listContactsQuerySchema, annotations: read,
  }, (query, session) => session.listContacts(query));

  tool("get_contact", {
    description: "Read one contact with its marketing consent.",
    inputSchema: z.strictObject({ contactId: uuidSchema }), annotations: read,
  }, ({ contactId }, session) => session.getContact(contactId));

  tool("list_deals", {
    description: "List deals, most recently updated first; optionally one pipeline or one contact.",
    inputSchema: listDealsQuerySchema, annotations: read,
  }, (query, session) => session.listDeals(query));

  tool("list_pipelines", {
    description: "List pipelines with their ordered stages.", inputSchema: z.strictObject({}), annotations: read,
  }, async (_args, session) => ({ items: await session.listPipelines() }));

  tool("list_bookings", {
    description: "List bookings by start time; optionally one resource, and only those overlapping [from, to).",
    inputSchema: listBookingsQuerySchema, annotations: read,
  }, (query, session) => session.listBookings(query));

  tool("list_resources", {
    description: "List bookable resources (calendars).", inputSchema: z.strictObject({}), annotations: read,
  }, async (_args, session) => ({ items: await session.listResources() }));

  tool("find_slots", {
    description: "Find free slots on a resource between two UTC instants (at most 31 days).",
    inputSchema: slotsQuerySchema, annotations: read,
  }, (query, session) => session.findSlots(query));

  tool("request_approval", {
    description: "Propose one exact action (actionType, target, payload) for an owner to approve. It does not run now: "
      + "an owner must approve it before it runs, and it expires after expiresInMinutes (default 7 days). Returns the pending approval.",
    inputSchema: keyed(requestApprovalRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.requestApproval(body, idempotencyKey));

  tool("list_approvals", {
    description: "List approvals, newest first; optionally only one status. Owners see every approval, other members the ones they requested.",
    inputSchema: listApprovalsQuerySchema, annotations: read,
  }, (query, session) => session.listApprovals(query));

  tool("get_approval", {
    description: "Read one approval with its standing (pending, approved, rejected, revoked or expired) and, once run, the action it ran.",
    inputSchema: z.strictObject({ approvalId: uuidSchema }), annotations: read,
  }, ({ approvalId }, session) => session.getApproval(approvalId));

  tool("observe_source", {
    description: "Record where a fact about a contact, deal, booking, resource or intake item came from, and how long it stays fresh. "
      + "An observation older than the stored one is not applied.",
    inputSchema: keyed(observeSourceRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.observeSource(body, idempotencyKey));

  tool("list_sources", {
    description: "List the source records of one subject (contact, deal, booking, booking_resource or intake_item), each with whether it is still fresh.",
    inputSchema: listSourcesQuerySchema, annotations: read,
  }, (query, session) => session.listSources(query));

  // agents.md G-11: the follow-up agent's state and runs, and its stop switch. Settings, resume
  // and running it stay with an owner in the dashboard or API.
  tool("get_followup_agent", {
    description: "Read the inquiry follow-up agent's settings, whether it is stopped (per business or globally) and why it cannot draft now.",
    inputSchema: z.strictObject({}), annotations: read,
  }, (_args, session) => session.getFollowUpStatus());

  tool("stop_followup_agent", {
    description: "Stop the inquiry follow-up agent for this business at once (optional note). No new drafts are written until an owner resumes it.",
    inputSchema: keyed(killFollowUpRequestSchema.shape),
    annotations: write,
  }, ({ idempotencyKey, ...body }, session) => session.killFollowUp(body, idempotencyKey));

  tool("list_followup_runs", {
    description: "List the follow-up agent's runs, newest first, with how many inquiries each drafted or skipped.",
    inputSchema: listFollowUpRunsQuerySchema, annotations: read,
  }, (query, session) => session.listFollowUpRuns(query));

  tool("get_followup_run", {
    description: "Read one follow-up agent run with every decision it made: the drafted reply and its pending approval, or why it skipped.",
    inputSchema: z.strictObject({ runId: uuidSchema }), annotations: read,
  }, ({ runId }, session) => session.getFollowUpRun(runId));

  // outreach-sequencer.md OS-22: only with an OUTREACH_TENANTS allowlist, like the HTTP routes. There is deliberately no
  // approve tool: the owner approves an activation at /v1/approvals/:id/approve, so an agent token cannot start sending.
  if (deps.outreach) {
    const outreach = (session: Session) => createOutreachSession(edge, session.principal);
    tool("create_outreach_campaign", {
      description: "Create a draft cold-email campaign: 1 to 5 steps, a sending window and the mailboxes to send from. Nothing sends until an owner approves its activation.",
      inputSchema: keyed(createOutreachCampaignRequestSchema.shape),
      annotations: write,
    }, ({ idempotencyKey, ...body }, session) => outreach(session).createCampaign(body, idempotencyKey));

    tool("import_outreach_prospects", {
      description: "Add prospects to a draft or paused campaign. The answer lists each rejected row and why.",
      inputSchema: keyed({ campaignId: uuidSchema, ...importOutreachProspectsRequestSchema.shape }),
      annotations: write,
    }, ({ idempotencyKey, campaignId, ...body }, session) => outreach(session).importProspects(campaignId, body, idempotencyKey));

    tool("request_outreach_activation", {
      description: "Ask an owner to approve starting a campaign. Returns the pending approvalId; it does not start anything.",
      inputSchema: keyed({ campaignId: uuidSchema }),
      annotations: write,
    }, ({ idempotencyKey, campaignId }, session) => outreach(session).requestActivation(campaignId, idempotencyKey));

    tool("pause_outreach_campaign", {
      description: "Stop a campaign from sending at once. Only an owner can start it again.",
      inputSchema: keyed({ campaignId: uuidSchema }),
      annotations: write,
    }, ({ idempotencyKey, campaignId }, session) => outreach(session).pauseCampaign(campaignId, idempotencyKey));

    tool("stop_outreach_prospect", {
      description: "Stop one prospect: no further steps are sent to them.",
      inputSchema: keyed({ prospectId: uuidSchema }),
      annotations: write,
    }, ({ idempotencyKey, prospectId }, session) => outreach(session).stopProspect(prospectId, idempotencyKey));

    tool("list_outreach_campaigns", {
      description: "List outreach campaigns, newest first.", inputSchema: z.strictObject({}), annotations: read,
    }, (_args, session) => outreach(session).listCampaigns());

    tool("get_outreach_campaign", {
      description: "Read one campaign: its settings, steps, prospect counts by status and today's sends per mailbox.",
      inputSchema: z.strictObject({ campaignId: uuidSchema }), annotations: read,
    }, ({ campaignId }, session) => outreach(session).getCampaign(campaignId));
  }

  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const call = calls.get(request.params.name);
    if (!call) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    return call(request.params.arguments);
  });
  return server;
}
