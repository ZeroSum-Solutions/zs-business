// The outreach runner as the cron route calls it (outreach-sequencer.md OS-13): one worker run per call. The worker
// leases its own mailboxes and stops itself at its budget, so there is no multi-pass loop here. Time, ids, the pools and
// Gmail come in as dependencies.
import {
  createOutreachWorker,
  type GmailPort,
  type OutreachReport,
  type OutreachRunCounts,
  type OutreachWorkerConfig,
} from "@zs/core";
import { asService, type ScopedDatabase, type Transaction } from "@zs/db";
import type { Pool } from "pg";

export interface OutreachRunSummary {
  readonly counts: OutreachRunCounts;
}
export interface OutreachRunner {
  run(): Promise<OutreachRunSummary>;
}

export function createOutreachRunner(deps: {
  /** A pool whose login may SET ROLE service_role. */
  readonly servicePool: Pool;
  /** The runtime-role database the bounce suppression goes through. */
  readonly db: ScopedDatabase;
  readonly gmail: GmailPort;
  readonly oauth: {
    refreshAccessToken(refreshToken: string, options?: { readonly signal?: AbortSignal }): Promise<{ accessToken: string; expiresInSeconds: number }>;
    revoke(token: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  };
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: OutreachWorkerConfig;
  readonly report?: (event: OutreachReport) => void;
}): OutreachRunner {
  const worker = createOutreachWorker({
    service: <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.servicePool, work),
    db: deps.db,
    gmail: deps.gmail,
    oauth: deps.oauth,
    clock: deps.clock,
    generateId: deps.generateId,
    config: deps.config,
    ...(deps.report ? { report: deps.report } : {}),
  });
  return { run: async () => ({ counts: await worker.runOnce() }) };
}
