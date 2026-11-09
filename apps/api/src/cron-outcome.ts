// One rule for "did this cron run fail?", used by every cron route. A run that throws is a failure (the
// route sees the throw). A run that returns is a failure too when its work items failed and none
// succeeded: the runners swallow per-item errors so the next item still runs, which would otherwise leave
// a job that fails every tick looking healthy. A run with no work, or with at least one item done, is a
// success: one bad tenant must not raise an alert while the rest of the fleet is served.
//
// The shapes are the runners' summaries (delivery/runner.ts, billing/runner.ts, calendar/runner.ts,
// activepieces/runner.ts, followup/runner.ts) and the connections pass (packages/core connections worker).

type Counts = Readonly<Record<string, unknown>>;

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const sum = (source: Counts, keys: readonly string[]): number => keys.reduce((total, key) => total + n(source[key]), 0);
const record = (value: unknown): Counts => (typeof value === "object" && value !== null ? (value as Counts) : {});

/** The failure rule: items failed, and no item succeeded. */
const allFailed = (failed: number, succeeded: number): boolean => failed > 0 && succeeded === 0;

/** Outcome counts keyed by outcome name: `error` is a failure, `skipped` is neutral, anything else is handled. */
function outcomeTotals(outcomes: Counts): { failed: number; succeeded: number } {
  let succeeded = 0;
  for (const [key, count] of Object.entries(outcomes)) if (key !== "error" && key !== "skipped") succeeded += n(count);
  return { failed: n(outcomes.error), succeeded };
}

const RULES: Readonly<Record<string, (result: Counts) => string | null>> = {
  delivery: (r) =>
    allFailed(n(r.errors), sum(r, ["sent", "retried", "blocked", "dead"])) ? `every delivery of the run failed (${n(r.errors)} errors)` : null,
  activepieces: (r) =>
    allFailed(n(r.errors), sum(r, ["delivered", "retried", "dead"])) ? `every webhook delivery of the run failed (${n(r.errors)} errors)` : null,
  billing: (r) => {
    const stripe = outcomeTotals(record(r.outcomes));
    const shopify = outcomeTotals(record(record(r.shopify).outcomes));
    return allFailed(stripe.failed + shopify.failed, stripe.succeeded + shopify.succeeded)
      ? `every billing item of the run failed (${stripe.failed + shopify.failed} errors)` : null;
  },
  followup: (r) => {
    let failed = n(r.errors);
    let succeeded = sum(r, ["drafted", "skipped", "stopped"]);
    for (const kind of Object.values(record(r.templated))) {
      const k = record(kind);
      failed += n(k.errors);
      succeeded += sum(k, ["queued", "skipped", "stopped"]);
    }
    return allFailed(failed, succeeded) ? `every follow-up tenant run failed (${failed} errors)` : null;
  },
  calendar: (r) => {
    const c = record(r.counts);
    const failed = sum(c, ["stepsFailed", "syncFailed", "pushesFailed", "channelFailures"]);
    return allFailed(failed, sum(c, ["notifications", "disconnected", "synced", "pushed", "channelsOpened", "channelsStopped", "reauthorized"]))
      ? `every calendar step of the run failed (${failed} failures)` : null;
  },
  // outreach-sequencer.md OS-13: a mailbox is a work item; the run fails when every step that ran failed.
  outreach: (r) => {
    const c = record(r.counts);
    const failed = n(c.stepsFailed);
    return allFailed(failed, n(c.stepsSucceeded)) ? `every outreach mailbox step of the run failed (${failed} failures)` : null;
  },
  connections: (r) =>
    allFailed(n(r.failed), n(r.succeeded)) ? `every connections work item of the run failed (${n(r.failed)} failures)` : null,
};

/** A short, secret-free reason when a run that returned counts as failed; null when it is a success. */
export function runFailure(job: string, result: object): string | null {
  const rule = RULES[job];
  return rule ? rule(result as Counts) : null;
}

/** The error a failed-by-outcome run records in the alert. */
export class CronRunFailed extends Error {
  constructor(job: string, reason: string) {
    super(`${job} run finished with only failures: ${reason}`);
    this.name = "CronRunFailed";
  }
}
