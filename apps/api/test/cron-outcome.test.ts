// One rule for "did this run fail": work items failed and none succeeded. No work is a success.
import { describe, expect, it } from "vitest";
import { runFailure } from "../src/cron-outcome.js";

describe("runFailure", () => {
  const cases: Array<[string, string, object, object, object]> = [
    // job, all failed, some succeeded, no work
    ["delivery", "delivery",
      { claimed: 2, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 2 },
      { claimed: 2, sent: 1, retried: 0, blocked: 0, dead: 0, errors: 1 },
      { claimed: 0, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 0 }],
    ["activepieces", "activepieces",
      { claimed: 2, delivered: 0, retried: 0, dead: 0, errors: 2 },
      { claimed: 2, delivered: 0, retried: 1, dead: 0, errors: 1 },
      { claimed: 0, delivered: 0, retried: 0, dead: 0, errors: 0 }],
    ["billing", "billing",
      { passes: 1, claimed: 3, outcomes: { error: 3 }, shopify: null },
      { passes: 1, claimed: 3, outcomes: { error: 1, applied: 2 }, shopify: null },
      { passes: 1, claimed: 0, outcomes: {}, shopify: null }],
    ["followup", "followup",
      { due: 2, finished: 0, drafted: 0, skipped: 0, stopped: 0, errors: 2 },
      { due: 2, finished: 1, drafted: 1, skipped: 0, stopped: 0, errors: 1 },
      { due: 0, finished: 0, drafted: 0, skipped: 0, stopped: 0, errors: 0 }],
    ["calendar", "calendar",
      { passes: 1, counts: { stepsFailed: 2, synced: 0, pushed: 0, notifications: 0 } },
      { passes: 1, counts: { stepsFailed: 1, synced: 3 } },
      { passes: 1, counts: { stepsFailed: 0, synced: 0 } }],
    ["connections", "connections",
      { disconnected: 0, swept: 0, checked: 2, failed: 2, succeeded: 0 },
      { disconnected: 1, swept: 0, checked: 2, failed: 1, succeeded: 2 },
      { disconnected: 0, swept: 0, checked: 0, failed: 0, succeeded: 0 }],
  ];

  it.each(cases)("%s: only failures is a failure; one success or no work is not", (_name, job, allFailed, someOk, noWork) => {
    expect(runFailure(job, allFailed)).toEqual(expect.stringMatching(/failed/));
    expect(runFailure(job, someOk)).toBeNull();
    expect(runFailure(job, noWork)).toBeNull();
  });

  it("billing counts the Shopify pass too, and a skipped item is neither", () => {
    expect(runFailure("billing", { outcomes: {}, shopify: { checked: 1, outcomes: { error: 1 }, stopped: false } })).not.toBeNull();
    expect(runFailure("billing", { outcomes: { error: 1 }, shopify: { checked: 1, outcomes: { plan_synced: 1 }, stopped: false } })).toBeNull();
    expect(runFailure("billing", { outcomes: { error: 1, skipped: 4 } })).not.toBeNull();
  });

  it("followup counts the templated kinds", () => {
    expect(runFailure("followup", { errors: 1, drafted: 0, skipped: 0, stopped: 0, templated: { reminder: { errors: 2, queued: 0, skipped: 0, stopped: 0 } } })).not.toBeNull();
    expect(runFailure("followup", { errors: 1, drafted: 0, skipped: 0, stopped: 0, templated: { reminder: { errors: 0, queued: 3, skipped: 0, stopped: 0 } } })).toBeNull();
  });

  it("calendar counts a failed sync, push and channel as well as a swallowed step", () => {
    expect(runFailure("calendar", { counts: { syncFailed: 1 } })).not.toBeNull();
    expect(runFailure("calendar", { counts: { pushesFailed: 1 } })).not.toBeNull();
    expect(runFailure("calendar", { counts: { channelFailures: 1 } })).not.toBeNull();
    expect(runFailure("calendar", { counts: { pushesFailed: 1, pushed: 1 } })).toBeNull();
  });

  it("an unknown job or a malformed summary is never a failure", () => {
    expect(runFailure("other", { errors: 9 })).toBeNull();
    expect(runFailure("delivery", {})).toBeNull();
    expect(runFailure("billing", { outcomes: "x", shopify: 3 })).toBeNull();
  });
});
