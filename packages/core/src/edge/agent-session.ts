// M6 agent edge (agents.md G-1, G-6, G-11). The agent runs as a server-built principal per
// tenant, like the public intake (public-intake.md P-3): no member, and only the agent actions.
import {
  followUpRunDetailSchema,
  idempotencyKeySchema,
  startFollowUpRunRequestSchema,
  TenantDenied,
  uuidSchema,
  type FollowUpRunDetail,
} from "@zs/contracts";
import { agentActorId } from "../agents/controls.js";
import { AGENT_ACTIONS } from "../agents/handlers.js";
import type { FollowUpModel } from "../agents/model.js";
import { runFollowUps, type FollowUpRunReport } from "../agents/runner.js";
import { requireMember } from "../members/access.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies, type Principal } from "./session.js";

/** G-1: the agent principal may run the agent actions and nothing else. */
export const agentAuthorize: Authorize = async (_tx, binding) => {
  if (!AGENT_ACTIONS.includes(binding.actionType)) throw new TenantDenied();
};

export interface FollowUpAgentConfig {
  /** G-9: the model port; tests and the cloud use createFakeFollowUpModel. */
  readonly model: FollowUpModel;
  /** G-7: at most this many inquiries per run. */
  readonly maxCandidatesPerRun: number;
  readonly report?: (event: FollowUpRunReport) => void;
}

export function createFollowUpAgent(deps: EdgeDependencies, agent: FollowUpAgentConfig) {
  const run = (tenantId: string, key: string, requestedBy: string | null) => {
    const tenant = uuidSchema.parse(tenantId);
    return runFollowUps({
      db: deps.db,
      clock: deps.clock,
      model: agent.model,
      config: { maxCandidatesPerRun: agent.maxCandidatesPerRun },
      dispatch: directDispatch(deps, tenant, agentActorId(tenant), agentAuthorize),
      ...(agent.report ? { report: agent.report } : {}),
    }, tenant, { key, requestedBy });
  };
  return {
    /**
     * A scheduled run (the hub or M5 calls this on a timer). `slot` names the run, for example
     * the hour it is for, so a repeated call for the same slot continues that run.
     */
    runScheduled: (tenantId: string, slot: string): Promise<FollowUpRunDetail> => run(tenantId, `schedule:${slot}`, null),
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
