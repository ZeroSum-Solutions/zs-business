// M6 agent edge (agents.md G-1, G-6, G-11). The agent runs as a server-built principal per
// tenant, like the public intake (public-intake.md P-3): no member, and only the agent actions.
import {
  followUpRunDetailSchema,
  followUpRunOutputSchema,
  idempotencyKeySchema,
  startFollowUpRunRequestSchema,
  TenantDenied,
  uuidSchema,
  ValidationFailed,
  type AgentKind,
  type FollowUpRun,
  type FollowUpRunDetail,
} from "@zs/contracts";
import { agentActorId } from "../agents/controls.js";
import { AGENT_COMMON_ACTIONS, AGENT_KIND_ACTIONS, STALL_RUN_ACTION } from "../agents/handlers.js";
import { assertKindModel } from "../agents/lanes.js";
import { FAKE_MODEL_PRICES, type ModelPrices } from "../agents/cost.js";
import type { FollowUpModel } from "../agents/model.js";
import { runFollowUps, type FollowUpRunReport, type RunTimers } from "../agents/runner.js";
import { scheduledRunKey } from "../agents/schedule.js";
import { derivedId } from "./ids.js";
import { requireMember } from "../members/access.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies, type Principal } from "./session.js";

/**
 * G-1, G-14: a kind's principal runs only that kind's actions and the two common ones (stall and
 * cost warning), and the common ones only for its own kind. The actor must be that kind's agent.
 */
export function agentAuthorizeFor(kind: AgentKind): Authorize {
  return async (_tx, binding) => {
    const common = AGENT_COMMON_ACTIONS.includes(binding.actionType);
    if (binding.actorId !== agentActorId(binding.tenantId, kind) || (!common && !AGENT_KIND_ACTIONS[kind].includes(binding.actionType)))
      throw new TenantDenied();
    if (common && (binding.payload as { agentKind?: unknown } | null)?.agentKind !== kind) throw new TenantDenied();
  };
}

/** G-1: the follow-up agent principal may run its own actions and nothing else. */
export const agentAuthorize: Authorize = agentAuthorizeFor("inquiry_followup");

export interface FollowUpAgentConfig {
  /** G-9: the model port; tests and the cloud use createFakeFollowUpModel. */
  readonly model: FollowUpModel;
  /** G-7: at most this many inquiries per run. */
  readonly maxCandidatesPerRun: number;
  readonly report?: (event: FollowUpRunReport) => void;
  /** G-15: the price table. The model must be on the kind's lane and in it, or the agent is not created. */
  readonly modelPrices?: ModelPrices;
  /** G-17: abort a model call after this long. */
  readonly modelTimeoutMs?: number;
  readonly timers?: RunTimers;
  /** Check the switches this often while a model call is out; unset, never. */
  readonly killPollMs?: number;
}

export function createFollowUpAgent(deps: EdgeDependencies, agent: FollowUpAgentConfig) {
  if (!Number.isInteger(agent.maxCandidatesPerRun) || agent.maxCandidatesPerRun < 1 || agent.maxCandidatesPerRun > 1000)
    throw new ValidationFailed("maxCandidatesPerRun must be an integer from 1 to 1000");
  const prices = agent.modelPrices ?? FAKE_MODEL_PRICES;
  assertKindModel("inquiry_followup", agent.model, prices);
  const run = (tenantId: string, key: string, requestedBy: string | null) => {
    const tenant = uuidSchema.parse(tenantId);
    return runFollowUps({
      db: deps.db,
      clock: deps.clock,
      model: agent.model,
      config: { maxCandidatesPerRun: agent.maxCandidatesPerRun },
      modelPrices: prices,
      ...(agent.modelTimeoutMs !== undefined ? { modelTimeoutMs: agent.modelTimeoutMs } : {}),
      ...(agent.timers ? { timers: agent.timers } : {}),
      ...(agent.killPollMs !== undefined ? { killPollMs: agent.killPollMs } : {}),
      dispatch: directDispatch(deps, tenant, agentActorId(tenant), agentAuthorize),
      ...(agent.report ? { report: agent.report } : {}),
    }, tenant, { key, requestedBy });
  };
  return {
    /**
     * G-16: close a run of this kind that stayed `running` too long, as the kind's own principal.
     * The key is per run, so a repeat returns the closed run.
     */
    async stallRun(tenantId: string, runId: string): Promise<FollowUpRun> {
      const tenant = uuidSchema.parse(tenantId);
      const id = uuidSchema.parse(runId);
      const result = await directDispatch(deps, tenant, agentActorId(tenant), agentAuthorize)({
        actionType: STALL_RUN_ACTION,
        idempotencyKey: `agent:inquiry_followup:stall:${id}`,
        target: { tenantId: tenant, type: "agent_run", id },
        approvalReference: { tenantId: tenant, id: derivedId(tenant, `agent:inquiry_followup:stall:${id}`, "approval") },
        payload: { runId: id, agentKind: "inquiry_followup" },
      });
      return parseInput(followUpRunOutputSchema, result, "result").result;
    },
    /**
     * A scheduled run (the hub or M5 calls this on a timer). `slot` names the run, for example
     * the hour it is for, so a repeated call for the same slot continues that run.
     */
    runScheduled: (tenantId: string, slot: string): Promise<FollowUpRunDetail> => run(tenantId, scheduledRunKey(slot), null),
    /** G-11: an owner runs the agent now. A retry with the same key continues the same run. */
    async runForMember(principal: Principal, body: unknown, rawKey: unknown): Promise<FollowUpRunDetail> {
      parseInput(startFollowUpRunRequestSchema, body);
      const key = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const tenantId = uuidSchema.parse(principal.tenantId);
      const actorId = uuidSchema.parse(principal.actorId);
      await deps.db.tenant(tenantId, (tx) => requireMember(tx, tenantId, actorId, "agents"));
      return parseInput(followUpRunDetailSchema, await run(tenantId, `member:${actorId}:${key}`, actorId), "result");
    },
  };
}
export type FollowUpAgent = ReturnType<typeof createFollowUpAgent>;
