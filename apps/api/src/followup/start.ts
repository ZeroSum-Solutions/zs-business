// Builds the scheduled follow-up runner from a parsed environment: a runtime pool for the agent's
// actions, a service pool for the due-tenant read, and the model behind the port. Shared by the
// Vercel cron function and the Node worker script, which own process.env and the clock.
import { createFakeFollowUpModel, createFollowUpAgent, type FollowUpModel } from "@zs/core";
import { asService, assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import type { FollowUpRunnerEnv } from "./config.js";
import { createScheduledFollowUps, withModelTimeout, type ScheduledFollowUps } from "./runner.js";

/** G-9: the only model there is today. A real provider plugs in here, behind FOLLOWUP_MODEL. */
export function followUpModelFor(env: Pick<FollowUpRunnerEnv, "model">): FollowUpModel {
  switch (env.model) {
    case "fake": return createFakeFollowUpModel();
  }
}

export async function startFollowUpRunner(env: FollowUpRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): Promise<{ runner: ScheduledFollowUps; close(): Promise<void> }> {
  const ssl = env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } };
  const runtimePool = createRuntimePool({
    connectionString: env.runtimeDatabaseUrl, max: 2, applicationName: "zs-followup", ...ssl,
    onError: (summary) => console.error("Follow-up pool error", summary),
  });
  const servicePool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl, max: 1, applicationName: "zs-followup-service", ...ssl,
    onError: (summary) => console.error("Follow-up service pool error", summary),
  });
  const close = async () => { await Promise.all([runtimePool.end(), servicePool.end()]); };
  // The agent's actions must run under RLS: refuse a privileged runtime login before any work.
  await assertRuntimeLogin(runtimePool).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  const db = createScopedDatabase(runtimePool, {
    cancel: "none",
    onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
  });
  const agent = createFollowUpAgent({ db, clock: deps.clock, generateId: deps.generateId }, {
    model: withModelTimeout(followUpModelFor(env), env.modelTimeoutMs),
    maxCandidatesPerRun: env.maxCandidatesPerRun,
    report: (event) => console.warn("Follow-up agent", event),
  });
  const runner = createScheduledFollowUps({
    service: (work) => asService(servicePool, work),
    agent,
    clock: deps.clock,
    slotMinutes: env.slotMinutes,
    budgetMs: env.budgetMs,
    perTenantMs: env.maxCandidatesPerRun * env.modelTimeoutMs,
    report: (event) => console.error("Follow-up tenant run failed", event),
  });
  return { runner, close };
}
