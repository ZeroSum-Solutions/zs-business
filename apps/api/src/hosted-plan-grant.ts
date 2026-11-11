// The hosted plan-grant flow behind src/scripts/hosted-plan-grant.ts: the same planGrant and
// runPlanGrant as the local step, with the guards of db:hosted-provision-owner (project-bound
// service URL, exactly one mode, a receipt reserved first, a recent project-bound backup before
// the apply). It needs no Supabase Auth key: a grant lives in the database only.
import { resolve } from "node:path";
import type { Pool } from "pg";
import { assertHostedDatabaseUrl, describeHosted, type HostedDatabaseTarget } from "./hosted.js";
import { parsePlanGrantFlags, planGrant, readGrantFacts, runPlanGrant, type PlanGrantFlags, type PlanGrantSummary } from "./plan-grant.js";

export interface HostedPlanGrantConfig extends PlanGrantFlags {
  /** SERVICE_DATABASE_URL, checked: postgres.<ref> on a Supabase pooler. */
  readonly target: HostedDatabaseTarget;
}

/**
 * Arguments and environment, validated before anything connects (see parsePlanGrantFlags), with
 * ZS_TARGET_REF and SERVICE_DATABASE_URL. --apply needs --backup and --receipt.
 */
export function parseHostedPlanGrantArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): HostedPlanGrantConfig {
  const flags = parsePlanGrantFlags(argv, { hosted: true, resolve });
  const projectRef = env.ZS_TARGET_REF ?? "";
  const target = assertHostedDatabaseUrl(env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
  return { ...flags, target };
}

export interface HostedPlanGrantDeps {
  readonly service: Pool;
  readonly checkBackup: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export function runHostedPlanGrant(config: HostedPlanGrantConfig, deps: HostedPlanGrantDeps): Promise<PlanGrantSummary> {
  return runPlanGrant(config.mode, {
    input: { tenantId: config.tenantId, request: config.request },
    target: describeHosted(config.target),
    grant: (input) => planGrant({ service: deps.service, clock: deps.clock }, input),
    readGrant: (tenantId) => readGrantFacts(deps.service, tenantId),
    checkBackup: deps.checkBackup,
    clock: deps.clock,
    log: deps.log,
    logError: deps.logError,
  });
}
