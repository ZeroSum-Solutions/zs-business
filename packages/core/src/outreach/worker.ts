// The outreach worker (outreach-sequencer.md OS-13): one `runOnce()` leases mailboxes of allowlisted tenants and, per
// mailbox, opens the sealed token, mints an access token, settles open attempts, polls replies and bounces, sends when
// `sendEnabled`, and releases the lease. It runs under the service role and never calls an action, except the bounce
// suppression, which goes through the shared path (worker-inbound.ts). Nothing here reads the environment or the clock.
import type { Transaction } from "@zs/db";
import { openRefreshToken } from "../calendar/seal.js";
import {
  emptyCounts,
  errorCode,
  LostLease,
  needsReauthorization,
  OutOfTime,
  outreachWorkerConfigSchema,
  reportText,
  type Box,
  type Ctx,
  type OutreachReport,
  type OutreachRunCounts,
  type OutreachWorkerConfig,
  type OutreachWorkerDeps,
} from "./worker-kit.js";
import { checkMailboxCampaigns, pollInbound } from "./worker-inbound.js";
import { sendFromMailbox } from "./worker-send.js";
import { settleOpenAttempts } from "./worker-settle.js";

interface LeasedRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly sealed_refresh_token: string | null;
  readonly daily_limit: number;
  readonly paused_until: Date | null;
  readonly history_id: string | null;
}

export interface OutreachWorker {
  runOnce(): Promise<OutreachRunCounts>;
}

export function createOutreachWorker(deps: OutreachWorkerDeps): OutreachWorker {
  const cfg = outreachWorkerConfigSchema.parse(deps.config as OutreachWorkerConfig);

  return {
    async runOnce() {
      const counts = emptyCounts();
      const startedAt = deps.clock.now().getTime();
      const deadline = startedAt + cfg.runBudgetMs;
      const report = (event: OutreachReport) => {
        try { deps.report?.(event); } catch { /* a failing reporter never stops a run */ }
      };
      const now = () => deps.clock.now();
      const timeLeft = () => deadline - now().getTime();
      const tenants = cfg.tenants;
      if (tenants.length === 0) return counts;

      const leaseToken = deps.generateId();
      const leased = (await deps.service((tx) => tx.query<LeasedRow>(
        `UPDATE outreach_mailboxes SET lease_token=$1, lease_expires_at=$2, last_attempt_at=$3, updated_at=$3
          WHERE (tenant_id, id) IN (
            SELECT tenant_id, id FROM outreach_mailboxes
             WHERE status='active' AND tenant_id = ANY($4::uuid[]) AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
             ORDER BY last_attempt_at NULLS FIRST, tenant_id, id LIMIT $5 FOR UPDATE SKIP LOCKED)
          RETURNING tenant_id, id, email, display_name, sealed_refresh_token, daily_limit, paused_until, history_id`,
        [leaseToken, new Date(now().getTime() + cfg.leaseMs), now(), tenants, cfg.mailboxesPerRun]))).rows;

      for (const row of leased) {
        const box: Box = {
          tenantId: row.tenant_id, id: row.id, email: row.email, displayName: row.display_name, leaseToken,
          dailyLimit: row.daily_limit, pausedUntil: row.paused_until, historyId: row.history_id, accessToken: "",
        };
        const ctx: Ctx = {
          cfg, deps, gmail: deps.gmail, counts, now, timeLeft, report,
          async leased<T>(target: Box, work: (tx: Transaction) => Promise<T>): Promise<T> {
            return deps.service(async (tx) => {
              const held = await tx.query(
                "SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND lease_expires_at > $4 AND status='active' FOR UPDATE",
                [target.tenantId, target.id, target.leaseToken, now()]);
              if (held.rowCount !== 1) throw new LostLease();
              return work(tx);
            });
          },
          async call<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = cfg.requestTimeoutMs): Promise<T> {
            const left = timeLeft();
            if (left <= 0) throw new OutOfTime();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, left)));
            try { return await work(controller.signal); } finally { clearTimeout(timer); }
          },
        };
        counts.mailboxes += 1;
        try {
          if (timeLeft() <= 0) {
            counts.deadlineStops += 1;
            report({ kind: "outreach_deadline_reached", tenantId: box.tenantId, mailboxId: box.id });
          } else if (row.sealed_refresh_token === null) {
            report({ kind: "outreach_step_failed", step: "open_token", tenantId: box.tenantId, mailboxId: box.id, error: "no_sealed_token" });
            counts.stepsFailed += 1;
          } else {
            await runMailbox(ctx, box, row.sealed_refresh_token);
          }
        } catch (error) {
          if (error instanceof LostLease) {
            counts.lostLeases += 1;
            report({ kind: "outreach_lost_lease", tenantId: box.tenantId, mailboxId: box.id });
          } else if (error instanceof OutOfTime) {
            counts.deadlineStops += 1;
            report({ kind: "outreach_deadline_reached", tenantId: box.tenantId, mailboxId: box.id });
          } else if (needsReauthorization(error)) {
            await markReauthorize(ctx, box, errorCode(error));
          } else {
            counts.stepsFailed += 1;
            report({ kind: "outreach_step_failed", step: "mailbox", tenantId: box.tenantId, mailboxId: box.id, error: reportText(errorCode(error)) });
          }
        } finally {
          // Release by token only: an expired lease of ours is still ours to clear.
          await deps.service((tx) => tx.query(
            "UPDATE outreach_mailboxes SET lease_token=NULL, lease_expires_at=NULL WHERE tenant_id=$1 AND id=$2 AND lease_token=$3",
            [box.tenantId, box.id, leaseToken])).catch(() => undefined);
        }
      }

      // OS-13: a campaign with no pending or active prospect left is completed.
      const done = await deps.service((tx) => tx.query<{ tenant_id: string; id: string }>(
        `UPDATE outreach_campaigns c SET status='completed', updated_at=$2
          WHERE c.tenant_id = ANY($1::uuid[]) AND c.status='active'
            AND NOT EXISTS (SELECT 1 FROM outreach_prospects p WHERE p.tenant_id=c.tenant_id AND p.campaign_id=c.id AND p.status IN ('pending','active'))
          RETURNING c.tenant_id, c.id`, [tenants, now()]));
      counts.campaignsCompleted += done.rowCount ?? 0;
      return counts;
    },
  };
}

/** OS-13 order for one leased mailbox. */
async function runMailbox(ctx: Ctx, box: Box, sealed: string): Promise<void> {
  const refreshToken = openRefreshToken(ctx.cfg.privateKey, { tenantId: box.tenantId, connectionId: box.id }, sealed);
  if (refreshToken === null) {
    ctx.counts.stepsFailed += 1;
    ctx.report({ kind: "outreach_step_failed", step: "open_token", tenantId: box.tenantId, mailboxId: box.id, error: "token_not_opened" });
    return;
  }
  const minted = await ctx.call((signal) => ctx.deps.oauth.refreshAccessToken(refreshToken, { signal }));
  box.accessToken = minted.accessToken;
  // OS-13: a mailbox sends only when this run settled its open attempts and read all of its new mail (a reply or a bounce
  // that is not read yet must stop its prospect first).
  const settled = await step(ctx, box, "settle", () => settleOpenAttempts(ctx, box));
  const caughtUp = await step(ctx, box, "inbound", () => pollInbound(ctx, box));
  if (ctx.cfg.sendEnabled && settled && caughtUp) await step(ctx, box, "send", async () => { await sendFromMailbox(ctx, box); return true; });
  // OS-20: every path that marks a send sent, or a prospect bounced, is covered by one check per run.
  await step(ctx, box, "bounce_rate", () => checkMailboxCampaigns(ctx, box));
}

/**
 * A step that fails for its own reasons does not stop the next one; lease, budget and sign-in problems do. True when the
 * step ran to its end and reported success (a step returning false, or throwing, did not).
 */
async function step(ctx: Ctx, box: Box, name: string, work: () => Promise<boolean | void>): Promise<boolean> {
  try {
    const ok = (await work()) !== false;
    if (ok) ctx.counts.stepsSucceeded += 1;
    return ok;
  } catch (error) {
    if (error instanceof LostLease || error instanceof OutOfTime || needsReauthorization(error)) throw error;
    ctx.counts.stepsFailed += 1;
    ctx.report({ kind: "outreach_step_failed", step: name, tenantId: box.tenantId, mailboxId: box.id, error: reportText(errorCode(error)) });
    return false;
  }
}

async function markReauthorize(ctx: Ctx, box: Box, code: string): Promise<void> {
  try {
    await ctx.leased(box, (tx) => tx.query(
      "UPDATE outreach_mailboxes SET status='reauthorize', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'", [box.tenantId, box.id, ctx.now()]));
    ctx.counts.reauthorized += 1;
    ctx.report({ kind: "outreach_mailbox_reauthorize", tenantId: box.tenantId, mailboxId: box.id, code });
  } catch (error) {
    if (!(error instanceof LostLease)) throw error;
    ctx.counts.lostLeases += 1;
  }
}
