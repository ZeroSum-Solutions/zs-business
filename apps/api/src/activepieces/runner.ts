// The process that runs the Activepieces webhook worker (docs/requirements/activepieces.md W-14).
// One run ingests new business events and works through due deliveries until nothing is due or its
// time budget is spent. Time, ids, the transport and the database come in as dependencies.
import {
  createNodeWebhookTransport,
  createWebhookWorker,
  type WebhookReport,
  type WebhookStepResult,
  type WebhookTransport,
  type WebhookWorker,
} from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import type { ActivepiecesRunnerEnv } from "./config.js";

export interface ActivepiecesRunnerDeps {
  readonly env: ActivepiecesRunnerEnv;
  /** A pool whose login may SET ROLE service_role. */
  readonly pool: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Defaults to the guarded Node transport (no redirects, private addresses refused). */
  readonly transport?: WebhookTransport;
  readonly report?: (event: WebhookReport) => void;
}

export interface ActivepiecesRunSummary {
  readonly passes: number;
  readonly ingested: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
  readonly errors: number;
  /** True when the budget ran out while work was still due. */
  readonly budgetSpent: boolean;
}

export function createWebhookWorkerFromEnv(deps: ActivepiecesRunnerDeps): WebhookWorker {
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.pool, work);
  return createWebhookWorker({
    service,
    transport: deps.transport ?? createNodeWebhookTransport({ allowLoopback: deps.env.allowLoopback }),
    keys: deps.env.keySecrets,
    clock: deps.clock,
    generateId: deps.generateId,
    ...(deps.report ? { report: deps.report } : {}),
    config: {
      workerId: deps.env.workerId,
      requestTimeoutMs: deps.env.requestTimeoutMs,
      leaseMs: Math.max(60_000, deps.env.requestTimeoutMs * 4),
      maxAttempts: deps.env.maxAttempts,
      allowLoopback: deps.env.allowLoopback,
    },
  });
}

/**
 * Runs passes until one claims fewer deliveries than the limit, or until starting another pass
 * could outlast the budget (each claimed delivery may wait one request timeout).
 */
export function createActivepiecesRunner(input: {
  readonly worker: WebhookWorker;
  readonly clock: { now(): Date };
  readonly budgetMs: number;
  readonly claimLimit: number;
}) {
  const { worker, clock, budgetMs, claimLimit } = input;
  const perPassMs = claimLimit * worker.config.requestTimeoutMs;
  return {
    async run(): Promise<ActivepiecesRunSummary> {
      const started = clock.now().getTime();
      const totals = { passes: 0, ingested: 0, claimed: 0, delivered: 0, retried: 0, dead: 0, errors: 0, budgetSpent: false };
      const count = (result: WebhookStepResult) => {
        if (result.outcome === "delivered") totals.delivered += 1;
        else if (result.outcome === "retry") totals.retried += 1;
        else if (result.outcome === "dead") totals.dead += 1;
        else if (result.outcome === "error") totals.errors += 1;
      };
      for (;;) {
        if (clock.now().getTime() - started + perPassMs > budgetMs) {
          totals.budgetSpent = true;
          break;
        }
        const pass = await worker.runOnce({ claimLimit });
        totals.passes += 1;
        totals.ingested += pass.ingested;
        totals.claimed += pass.claimed;
        pass.results.forEach(count);
        if (pass.claimed < claimLimit) break;
      }
      return totals;
    },
  };
}
export type ActivepiecesRunner = ReturnType<typeof createActivepiecesRunner>;
