// Edge of the templated agent kinds and their message templates (agents.md G-19, G-20, approvals.md
// A-15). Original code. A member writes a revision; an owner approves it with a standing approval;
// the kind's own principal queues the messages. Each piece builds its commands from the caller's
// key, so a retry replays.
import {
  Conflict,
  NotFound,
  TEMPLATE_REVISION_CREATE_ACTION,
  TEMPLATE_STANDING_GRANT_ACTION,
  approveTemplateRequestSchema,
  createTemplateRevisionRequestSchema,
  followUpRunOutputSchema,
  idempotencyKeySchema,
  startFollowUpRunRequestSchema,
  suggestTemplateRequestSchema,
  templateStateOutputSchema,
  templatedKindSchema,
  uuidSchema,
  ValidationFailed,
  type ApproveApprovalResponse,
  type FollowUpRun,
  type TemplateState,
  type TemplateSuggestion,
  type TemplatedKind,
} from "@zs/contracts";
import { agentActorId } from "../agents/controls.js";
import { FAKE_MODEL_PRICES, priceFor, type ModelPrices } from "../agents/cost.js";
import { STALL_RUN_ACTION } from "../agents/handlers.js";
import type { TextModel } from "../agents/model.js";
import { scheduledKindRunKey } from "../agents/schedule.js";
import { requireMember } from "../members/access.js";
import { runTemplatedKind, type TemplatedRunDeps } from "../templates/runner.js";
import type { BookingLinkProvider, KindRunDetail } from "../templates/send.js";
import { suggestTemplate, TEMPLATE_SUGGESTION_LANE } from "../templates/suggest.js";
import { loadTemplateState, templateIdFor } from "../templates/store.js";
import { readClock } from "../booking/slots.js";
import { derivedId } from "./ids.js";
import { agentAuthorizeFor } from "./agent-session.js";
import {
  createSession, directDispatch, memberDispatch, parseInput,
  type EdgeDependencies, type Principal,
} from "./session.js";

const kindOf = (raw: unknown): TemplatedKind => {
  const parsed = templatedKindSchema.safeParse(raw);
  if (!parsed.success) throw new NotFound();
  return parsed.data;
};

/** G-19, A-15: a member's reads and writes of one kind's template. */
export function createTemplateSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = memberDispatch(deps, { tenantId, actorId });
  const keyOf = (rawKey: unknown) => parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
  return {
    /** The template with its newest revisions, each with its standing approval. */
    getTemplate(rawKind: unknown): Promise<TemplateState> {
      const kind = kindOf(rawKind);
      const now = new Date(readClock(deps.clock));
      return deps.db.tenant(tenantId, async (tx) => {
        await requireMember(tx, tenantId, actorId, "agents");
        return loadTemplateState(tx, tenantId, kind, now);
      });
    },
    /** Write the next revision; it becomes current and the previous revision's grants end (A-15). */
    async createRevision(rawKind: unknown, body: unknown, rawKey: unknown): Promise<TemplateState> {
      const kind = kindOf(rawKind);
      const request = parseInput(createTemplateRevisionRequestSchema, body);
      const key = keyOf(rawKey);
      const templateId = templateIdFor(tenantId, kind);
      const result = await run({
        actionType: TEMPLATE_REVISION_CREATE_ACTION,
        idempotencyKey: key,
        target: { tenantId, type: "message_template", id: templateId },
        approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
        payload: { templateId, revisionId: derivedId(tenantId, key, "template-revision"), agentKind: kind, ...request },
      });
      return parseInput(templateStateOutputSchema, result, "result").result;
    },
    /**
     * A-15: an owner approves one revision as it reads now. Requests the grant, approves it and
     * runs it. The digest must be the revision's, so an approval never covers wording the owner
     * did not see.
     */
    async approveTemplate(rawKind: unknown, body: unknown, rawKey: unknown): Promise<ApproveApprovalResponse> {
      const kind = kindOf(rawKind);
      const request = parseInput(approveTemplateRequestSchema, body);
      const key = keyOf(rawKey);
      const now = new Date(readClock(deps.clock));
      const state = await deps.db.tenant(tenantId, async (tx) => {
        await requireMember(tx, tenantId, actorId, "agents");
        return loadTemplateState(tx, tenantId, kind, now);
      });
      const revision = state.revisions.find((candidate) => candidate.revision === request.revision);
      if (!revision) throw new NotFound("That revision does not exist");
      if (revision.contentDigest !== request.contentDigest)
        throw new Conflict("The template changed since it was approved", { reason: "template_changed" });
      if (!revision.current)
        throw new Conflict("The revision is no longer the template's current one", { reason: "template_superseded" });
      const session = createSession(deps, principal);
      const pending = await session.requestApproval({
        action: {
          actionType: TEMPLATE_STANDING_GRANT_ACTION,
          target: { type: "message_template_revision", id: revision.id },
          payload: { templateId: state.templateId, revision: revision.revision, contentDigest: revision.contentDigest },
        },
        summary: `Send the ${kind === "appointment_reminder" ? "appointment reminder" : "review request"} wording, revision ${revision.revision}`,
        ...(request.expiresInMinutes !== undefined ? { expiresInMinutes: request.expiresInMinutes } : {}),
      }, key);
      return session.approveApproval(pending.result.id, {}, `tpl-approve-${derivedId(tenantId, key, "template-approve")}`);
    },
  };
}
export type TemplateSession = ReturnType<typeof createTemplateSession>;

export interface TemplatedAgentsConfig {
  /** G-7: at most this many bookings per run. */
  readonly maxCandidatesPerRun: number;
  /** The tenant's public booking link for `{booking_link}`; unset, the reminder kind skips for `no_link`. */
  readonly bookingLink?: BookingLinkProvider;
  readonly report?: TemplatedRunDeps["report"];
  /**
   * G-19: the wording suggestions' model. It must be on the `no_personal_data` lane and priced, or
   * the agents are not created. Unset, `POST .../template-suggestion` is off.
   */
  readonly suggestion?: {
    readonly model: TextModel<typeof TEMPLATE_SUGGESTION_LANE>;
    readonly prices?: ModelPrices;
    readonly timeoutMs?: number;
    readonly report?: (event: { tenantId: string; error: unknown }) => void;
  };
}

export function createTemplatedAgents(deps: EdgeDependencies, agents: TemplatedAgentsConfig) {
  if (!Number.isInteger(agents.maxCandidatesPerRun) || agents.maxCandidatesPerRun < 1 || agents.maxCandidatesPerRun > 1000)
    throw new ValidationFailed("maxCandidatesPerRun must be an integer from 1 to 1000");
  const suggestion = agents.suggestion;
  const prices = suggestion?.prices ?? FAKE_MODEL_PRICES;
  if (suggestion) {
    if (suggestion.model.lane !== TEMPLATE_SUGGESTION_LANE)
      throw new ValidationFailed("Template suggestions use the no_personal_data lane");
    priceFor(prices, suggestion.model.model);
  }
  const principalFor = (tenantId: string, kind: TemplatedKind) =>
    directDispatch(deps, tenantId, agentActorId(tenantId, kind), agentAuthorizeFor(kind), {
      ...(agents.bookingLink ? { bookingLink: agents.bookingLink } : {}),
    });
  const runKind = (kind: TemplatedKind, tenantId: string, key: string, requestedBy: string | null): Promise<KindRunDetail> =>
    runTemplatedKind({
      db: deps.db,
      clock: deps.clock,
      maxCandidatesPerRun: agents.maxCandidatesPerRun,
      ...(agents.bookingLink ? { bookingLink: agents.bookingLink } : {}),
      ...(agents.report ? { report: agents.report } : {}),
      dispatch: principalFor(tenantId, kind),
    }, tenantId, { kind, key, requestedBy });
  return {
    /** A scheduled run of one kind for the slot; a repeat continues it (G-13). */
    runScheduled: (kind: TemplatedKind, tenantId: string, slot: string): Promise<KindRunDetail> =>
      runKind(kind, uuidSchema.parse(tenantId), scheduledKindRunKey(kind, slot), null),
    /** G-11: an owner runs the kind now. A retry with the same key continues the same run. */
    async runForMember(principal: Principal, rawKind: unknown, body: unknown, rawKey: unknown): Promise<KindRunDetail> {
      const kind = kindOf(rawKind);
      parseInput(startFollowUpRunRequestSchema, body);
      const key = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const tenantId = uuidSchema.parse(principal.tenantId);
      const actorId = uuidSchema.parse(principal.actorId);
      await deps.db.tenant(tenantId, (tx) => requireMember(tx, tenantId, actorId, "agents"));
      return runKind(kind, tenantId, `member:${actorId}:${key}`, actorId);
    },
    /** G-16: close a run of this kind that stayed `running` too long, as the kind's own principal. */
    async stallRun(kind: TemplatedKind, tenantId: string, runId: string): Promise<FollowUpRun> {
      const tenant = uuidSchema.parse(tenantId);
      const id = uuidSchema.parse(runId);
      const result = await principalFor(tenant, kind)({
        actionType: STALL_RUN_ACTION,
        idempotencyKey: `agent:${kind}:stall:${id}`,
        target: { tenantId: tenant, type: "agent_run", id },
        approvalReference: { tenantId: tenant, id: derivedId(tenant, `agent:${kind}:stall:${id}`, "approval") },
        payload: { runId: id, agentKind: kind },
      });
      return parseInput(followUpRunOutputSchema, result, "result").result;
    },
    /** Whether `POST .../template-suggestion` is on. */
    suggestionsOn: suggestion !== undefined,
    /** G-19: a wording suggestion on the no-personal-data lane, counted against the kind's daily cost cap. */
    async suggest(principal: Principal, rawKind: unknown, body: unknown, rawKey: unknown): Promise<TemplateSuggestion> {
      if (!suggestion) throw new NotFound();
      const kind = kindOf(rawKind);
      const request = parseInput(suggestTemplateRequestSchema, body);
      const key = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const tenantId = uuidSchema.parse(principal.tenantId);
      const actorId = uuidSchema.parse(principal.actorId);
      await deps.db.tenant(tenantId, (tx) => requireMember(tx, tenantId, actorId, "agents"));
      return suggestTemplate({
        db: deps.db,
        clock: deps.clock,
        model: suggestion.model,
        prices,
        ...(suggestion.timeoutMs !== undefined ? { timeoutMs: suggestion.timeoutMs } : {}),
        dispatch: principalFor(tenantId, kind),
        ...(suggestion.report ? { report: suggestion.report } : {}),
      }, tenantId, { kind, channel: request.channel, key: `member:${actorId}:${key}` });
    },
  };
}
export type TemplatedAgents = ReturnType<typeof createTemplatedAgents>;
