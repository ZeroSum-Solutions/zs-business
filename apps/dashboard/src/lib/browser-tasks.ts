// Website tasks (browser-tasks.md): plain words for what a run did and why it stopped.
import type { BrowserAction, BrowserRun, BrowserStatus, BrowserStopReason } from "@zs/contracts";

export const BROWSER_STOP_WORDS: Record<BrowserStopReason, string> = {
  origin_denied: "it tried to leave the sites you allowed",
  write_refused: "the page asked it to change something, and website tasks only read",
  needs_vision: "the page needs to be seen, which website tasks cannot do yet",
  needs_owner: "it needs an owner to look at the site",
  killed: "an owner or team member stopped website tasks",
  disabled: "website tasks or this site are switched off",
  step_cap: "it reached its step limit",
  deadline: "it ran out of time",
  cost_cap: "it reached its cost limit",
  stalled: "it stopped answering",
  insufficient_funds: "the balance is too low to pay for the run",
  model_error: "the helper that plans the steps failed",
  runner_error: "the computer that runs the task failed",
};

export const BROWSER_RUN_STATUS: Record<BrowserRun["status"], { label: string; tone: "accent" | "success" | "warn" | "neutral" }> = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  completed: { label: "Done", tone: "success" },
  stopped: { label: "Stopped", tone: "warn" },
};

export const BROWSER_ACTION_WORDS: Record<BrowserAction, string> = {
  sign_in: "Signed in",
  open: "Opened a page",
  click_link: "Followed a link",
  set_date_filter: "Chose the month",
  download: "Saved an invoice",
  stop: "Finished",
};

export const BROWSER_BLOCKED_WORDS: Record<NonNullable<BrowserStatus["blockedBy"]>, string> = {
  global_killed: "Website tasks are stopped for every business right now.",
  disabled: "Website tasks are off. An owner can turn them on in the settings.",
  tenant_killed: "Website tasks are stopped. An owner can resume them.",
  daily_cap: "Today's limit of runs is used up. It starts again tomorrow.",
  cost_cap: "Today's cost limit is used up. It starts again tomorrow.",
};

/** Why a request for a run was refused (a conflict reason from the API), in words. */
export const BROWSER_REFUSED_WORDS: Record<string, string> = {
  ...BROWSER_BLOCKED_WORDS,
  target_disabled: "This website is switched off. An owner can turn it on first.",
};

/** The sentence under a stopped run. */
export function stopSentence(run: Pick<BrowserRun, "status" | "stopReason">): string | null {
  if (run.status !== "stopped" || !run.stopReason) return null;
  return `Stopped because ${BROWSER_STOP_WORDS[run.stopReason]}.`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" as "September 2026". */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  return `${MONTH_NAMES[Number(number) - 1] ?? month} ${year}`;
}

/** The last `count` months, newest first, ending at the month of `now` in UTC. */
export function recentMonths(now: Date, count = 12): string[] {
  const months: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  for (let i = 0; i < count; i += 1) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return months;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
