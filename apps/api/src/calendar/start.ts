// Builds the calendar runner from a parsed environment: the service pool, the Google client and the
// worker. Shared by the Vercel cron function and the Node worker script, which own process.env and
// the clock.
import { createGoogleClient } from "@zs/core";
import { createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import type { CalendarRunnerEnv } from "./config.js";
import { createCalendarRunner, createCalendarWorkerFromPool, type CalendarRunner } from "./runner.js";

/** Operator events; synced and routine retries are left out. */
const NOTEWORTHY = new Set(["reauthorize", "disconnect_retry", "channel_failed", "push_failed", "step_failed", "sync_failed"]);

export function startCalendarRunner(env: CalendarRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): { runner: CalendarRunner; pool: Pool } {
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 2,
    applicationName: "zs-calendar",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Calendar pool error", summary),
  });
  const worker = createCalendarWorkerFromPool({
    pool,
    google: createGoogleClient({ config: env.client }),
    clock: deps.clock,
    generateId: deps.generateId,
    config: {
      privateKey: env.privateKey,
      channelSecret: env.channelSecret,
      ...(env.webhookUrl === undefined ? {} : { webhookUrl: env.webhookUrl }),
      ...(env.eventTitle === undefined ? {} : { eventTitle: env.eventTitle }),
    },
    report: (event) => {
      if (NOTEWORTHY.has(event.kind)) console.warn("Calendar worker", event);
    },
  });
  return { runner: createCalendarRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs }), pool };
}
