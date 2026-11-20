// Builds the intake sweep from a parsed environment: a runtime pool for the platform transaction the sweep reads and
// marks jobs through, a service pool only for the cron alerts, and the R2 store. Shared by the Vercel cron function.
import type { SiteObjectStore } from "@zs/contracts";
import { createDocumentIntakeSession } from "@zs/core";
import { assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import type { Pool } from "pg";
import { createR2SiteStore } from "../sites/r2-s3.js";
import type { IntakeSweepRunnerEnv } from "./config.js";
import { createIntakeSweepRunner, type IntakeSweepRunner } from "./runner.js";
import { createIntakeFileStore } from "./store.js";

export async function startIntakeSweep(env: IntakeSweepRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Test seam: the object store; unset, R2. */
  readonly objects?: SiteObjectStore;
}): Promise<{ runner: IntakeSweepRunner; /** The service-login pool the cron alerts use. */ servicePool: Pool; close(): Promise<void> }> {
  const ssl = env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } };
  const runtimePool = createRuntimePool({
    connectionString: env.runtimeDatabaseUrl, max: 1, applicationName: "zs-intake-sweep", ...ssl,
    onError: (summary) => console.error("Intake sweep pool error", summary),
  });
  const servicePool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl, max: 1, applicationName: "zs-intake-sweep-service", ...ssl,
    onError: (summary) => console.error("Intake sweep service pool error", summary),
  });
  const close = async () => { await Promise.all([runtimePool.end(), servicePool.end()]); };
  // The sweep must run under RLS: refuse a privileged runtime login before any work.
  await assertRuntimeLogin(runtimePool).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  try {
    const objects = deps.objects ?? createR2SiteStore(env.r2, { fetch: globalThis.fetch, clock: deps.clock });
    const session = createDocumentIntakeSession({
      db: createScopedDatabase(runtimePool, {
        cancel: "none",
        onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
      }),
      clock: deps.clock,
      generateId: deps.generateId,
    }, { store: createIntakeFileStore(objects) });
    return { runner: createIntakeSweepRunner({ sweep: session, batch: env.batch, budgetMs: env.runBudgetMs, now: () => deps.clock.now().getTime() }), servicePool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
