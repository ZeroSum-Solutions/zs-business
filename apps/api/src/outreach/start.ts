// Builds the outreach runner from a parsed environment: the service pool, the runtime pool for the bounce suppression,
// the Gmail adapter and the token client. Shared by the Vercel cron function; it owns neither process.env nor the clock.
import { createGmailClient, createGoogleClient } from "@zs/core";
import { assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import type { Pool } from "pg";
import type { OutreachRunnerEnv } from "./config.js";
import { createOutreachRunner, type OutreachRunner } from "./runner.js";

/** Operator events (OS-3, OS-13, OS-15, OS-16, OS-19, OS-20). They hold ids and our codes, never a token. */
const NOTEWORTHY = new Set([
  "outreach_mailbox_reauthorize", "outreach_history_reset", "outreach_gmail_daily_limit", "outreach_send_outcome_unknown",
  "outreach_bounce_rate", "outreach_campaign_paused", "outreach_lost_lease", "outreach_step_failed",
]);

export async function startOutreachRunner(env: OutreachRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): Promise<{ runner: OutreachRunner; servicePool: Pool; close(): Promise<void> }> {
  const ssl = env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } };
  const servicePool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl, max: 2, applicationName: "zs-outreach", ...ssl,
    onError: (summary) => console.error("Outreach pool error", summary),
  });
  const runtimePool = createRuntimePool({
    connectionString: env.runtimeDatabaseUrl, max: 1, applicationName: "zs-outreach-runtime", ...ssl,
    onError: (summary) => console.error("Outreach runtime pool error", summary),
  });
  const close = async () => { await Promise.all([servicePool.end(), runtimePool.end()]); };
  // The bounce suppression must run under RLS: refuse a privileged runtime login before any work.
  await assertRuntimeLogin(runtimePool).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  try {
    const google = createGoogleClient({ config: env.client });
    const runner = createOutreachRunner({
      servicePool,
      db: createScopedDatabase(runtimePool, {
        cancel: "none",
        onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
      }),
      gmail: createGmailClient({ config: env.gmailBaseUrl === undefined ? {} : { baseUrl: env.gmailBaseUrl } }),
      oauth: google,
      clock: deps.clock,
      generateId: deps.generateId,
      config: {
        privateKey: env.privateKey,
        tenants: [...env.tenants],
        sendEnabled: env.sendEnabled,
        mailboxDailyLimit: env.mailboxDailyLimit,
        sendsPerTick: env.sendsPerTick,
        minGapMs: env.minGapMs,
        probeDelayMs: env.probeDelayMs,
        runBudgetMs: env.budgetMs,
        unsubscribeBaseUrl: env.unsubscribe.baseUrl,
        unsubscribeSecret: env.unsubscribe.secret,
      },
      report: (event) => {
        if (NOTEWORTHY.has(event.kind)) console.warn("Outreach worker", event);
      },
    });
    return { runner, servicePool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
