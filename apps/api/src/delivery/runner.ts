// The process that runs the M3d delivery worker (docs/requirements/resend.md R-9). One run ingests
// new send events and works through due deliveries until nothing is due or its time budget is
// spent. Wiring is production's: M3b's approval records behind the approvals port, M3c's reply
// settle hook, Resend for email. Time, ids, fetch and the database come in as dependencies.
import {
  approvalForAction,
  approvalsFromRecords,
  createDeliveryWorker,
  createResendProvider,
  settleReplyDelivery,
  type DeliveryProvider,
  type DeliveryReport,
  type DeliveryWorker,
  type StepResult,
} from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import { deliveryPassEstimateMs, type DeliveryRunnerEnv } from "./config.js";

/** No SMS provider is wired yet (Twilio comes later in M5); nothing produces SMS in v1. */
export const smsNotConfigured: DeliveryProvider = {
  name: "sms-not-configured",
  dedupeWindowMs: 24 * 60 * 60 * 1000,
  send: async () => ({ status: "rejected", code: "sms_provider_not_configured" }),
};

export interface DeliveryRunnerDeps {
  readonly env: DeliveryRunnerEnv;
  /** A pool whose login may SET ROLE service_role. */
  readonly pool: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly report?: (event: DeliveryReport) => void;
}

export interface RunSummary {
  readonly passes: number;
  readonly ingested: number;
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly blocked: number;
  readonly dead: number;
  readonly errors: number;
  /** True when the budget ran out while work was still due. */
  readonly budgetSpent: boolean;
}

export function createDeliveryWorkerFromEnv(deps: DeliveryRunnerDeps): DeliveryWorker {
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.pool, work);
  return createDeliveryWorker({
    service,
    providers: {
      email: createResendProvider({ config: deps.env.resend, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
      sms: smsNotConfigured,
    },
    approvals: approvalsFromRecords(approvalForAction, deps.clock),
    onSettled: async (tx, tenantId, messageId, outcome, at) => { await settleReplyDelivery(tx, tenantId, messageId, outcome, at); },
    clock: deps.clock,
    generateId: deps.generateId,
    ...(deps.report ? { report: deps.report } : {}),
    config: {
      workerId: deps.env.workerId,
      providerTimeoutMs: deps.env.providerTimeoutMs,
      leaseMs: Math.max(60_000, deps.env.providerTimeoutMs * 4),
      pricing: deps.env.pricing,
      unsubscribe: deps.env.unsubscribe,
    },
  });
}

/**
 * Runs passes until one claims fewer deliveries than the limit, or until starting another pass
 * could outlast the budget. A pass is assumed to take its estimate (each claimed delivery may
 * wait one provider timeout, plus database time) or as long as the last pass took, if longer.
 */
export function createDeliveryRunner(input: {
  readonly worker: DeliveryWorker;
  readonly clock: { now(): Date };
  readonly budgetMs: number;
  readonly claimLimit: number;
}) {
  const { worker, clock, budgetMs, claimLimit } = input;
  const estimateMs = deliveryPassEstimateMs(claimLimit, worker.config.providerTimeoutMs);
  return {
    async run(): Promise<RunSummary> {
      const started = clock.now().getTime();
      const totals = { passes: 0, ingested: 0, claimed: 0, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 0, budgetSpent: false };
      const count = (result: StepResult) => {
        if (result.outcome === "sent") totals.sent += 1;
        else if (result.outcome === "retry") totals.retried += 1;
        else if (result.outcome === "blocked") totals.blocked += 1;
        else if (result.outcome === "dead") totals.dead += 1;
        else if (result.outcome === "error") totals.errors += 1;
      };
      let lastPassMs = 0;
      for (;;) {
        const passStarted = clock.now().getTime();
        if (passStarted - started + Math.max(estimateMs, lastPassMs) > budgetMs) {
          totals.budgetSpent = true;
          break;
        }
        const pass = await worker.runOnce({ claimLimit });
        lastPassMs = clock.now().getTime() - passStarted;
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
export type DeliveryRunner = ReturnType<typeof createDeliveryRunner>;
