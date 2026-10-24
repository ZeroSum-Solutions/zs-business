// Builds the scheduled follow-up runner from a parsed environment: a runtime pool for the agent's
// actions, a service pool for the due-tenant read, and the model behind the port. Shared by the
// Vercel cron function and the Node worker script, which own process.env and the clock.
import {
  createFollowUpModel,
  createFakeFollowUpModel,
  createFollowUpAgent,
  modelForLane,
  VENDOR_MODEL_PRICES,
  type FetchLike,
  type FollowUpModel,
} from "@zs/core";
import { asService, assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import type { FollowUpRunnerEnv } from "./config.js";
import { createScheduledFollowUps, type ScheduledFollowUps } from "./runner.js";

/** G-18: the follow-up kind's model, from the personal-data lane. `fetch` is the vendor transport. */
export function followUpModelFor(env: Pick<FollowUpRunnerEnv, "personalData">, fetch: FetchLike): FollowUpModel {
  const choice = env.personalData;
  if (choice.provider === "fake") return createFakeFollowUpModel();
  return createFollowUpModel(modelForLane("personal_data", { provider: "cerebras", apiKey: choice.apiKey, model: choice.model, fetch }));
}

export async function startFollowUpRunner(env: FollowUpRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** The vendor transport; unset, the platform's fetch. */
  readonly fetch?: FetchLike;
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
  // G-18: a model on the wrong lane, or without a price, makes this throw before any tenant is run.
  let agent: ReturnType<typeof createFollowUpAgent>;
  try {
    agent = createFollowUpAgent({ db, clock: deps.clock, generateId: deps.generateId }, {
      model: followUpModelFor(env, deps.fetch ?? ((url, init) => fetch(url, init))),
      maxCandidatesPerRun: env.maxCandidatesPerRun,
      modelPrices: VENDOR_MODEL_PRICES,
      modelTimeoutMs: env.modelTimeoutMs,
      killPollMs: 1_000,
        report: (event) => console.warn("Follow-up agent", event),
    });
  } catch (error) {
    await close();
    throw error;
  }
  const runner = createScheduledFollowUps({
    service: (work) => asService(servicePool, work),
    agent,
    clock: deps.clock,
    slotMinutes: env.slotMinutes,
    budgetMs: env.budgetMs,
    stallAfterMs: env.stallAfterMs,
    perTenantMs: env.maxCandidatesPerRun * env.modelTimeoutMs,
    report: (event) => console.error("Follow-up tenant run failed", event),
  });
  return { runner, close };
}
