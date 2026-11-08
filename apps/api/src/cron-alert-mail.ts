// The one plain email a new or reopened cron alert sends to the operator. It uses the Resend account the
// delivery worker already sends with (RESEND_API_KEY, RESEND_FROM, optional RESEND_BASE_URL); no vendor is
// added. It is not a tenant delivery: no outbox row, wallet charge, unsubscribe header or tenant tag. The
// recipient is OPS_ALERT_EMAIL. Unset or unusable, nothing is sent and the operator log says so once.
// It never throws: a mail that fails must not change what the cron answers.
import { parseResendEnv } from "@zs/core";

export interface CronAlertMessage {
  readonly job: string;
  /** When this alert opened; with the job it keys the send, so a retried call cannot mail twice. */
  readonly openedAt: string;
  readonly failureCount: number;
  /** Already redacted by describeCronError. */
  readonly error: string;
  /**
   * A start-up failure that could not be written to cron_alerts (cron-startup.ts). `openedAt` is then the start of the
   * hour. The text says so, says it repeats hourly, and promises no close; the idempotency key names the deployment.
   */
  readonly unrecorded?: boolean;
}
/** Resolves true only when the provider accepted the mail (a 2xx); false when it was skipped, refused or failed. */
export type CronAlertNotifier = (message: CronAlertMessage, options?: { readonly timeoutMs?: number }) => Promise<boolean>;

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const SEND_TIMEOUT_MS = 4_000;
const ADDRESS = /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/;

export function createOpsAlertMailer(deps: {
  readonly env: Env;
  readonly fetch?: Fetch;
  readonly report?: (message: string, detail?: unknown) => void;
}): CronAlertNotifier {
  const report = deps.report ?? ((message, detail) => console.warn(message, detail ?? ""));
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  let setup: { to: string; apiKey: string; from: string; endpoint: string } | "off" | null = null;

  /** Reads the variables once; a missing or bad setting is logged once and turns sending off. */
  function configured() {
    if (setup !== null) return setup;
    const to = deps.env.OPS_ALERT_EMAIL?.trim();
    if (!to) {
      report("OPS_ALERT_EMAIL is not set: cron failure alerts are recorded but not emailed");
      return (setup = "off");
    }
    if (!ADDRESS.test(to)) {
      report("OPS_ALERT_EMAIL is not a single email address: cron failure alerts are not emailed");
      return (setup = "off");
    }
    try {
      const resend = parseResendEnv(deps.env);
      return (setup = {
        to,
        apiKey: resend.apiKey,
        from: resend.from,
        endpoint: `${(resend.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`,
      });
    } catch (error) {
      report("Cron failure alerts are not emailed: the Resend settings are unusable", error instanceof Error ? error.message : error);
      return (setup = "off");
    }
  }

  /** Where this alert comes from: the Vercel environment and the project's host, never a guess at "production". */
  function origin(): { readonly environment: string; readonly project: string } {
    const clean = (value: string | undefined) => (value ?? "").replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 80);
    return {
      environment: clean(deps.env.VERCEL_ENV) || "unknown environment",
      project: clean(deps.env.VERCEL_PROJECT_PRODUCTION_URL) || clean(deps.env.VERCEL_URL) || "unknown project",
    };
  }

  return async (message, options) => {
    try {
      const mail = configured();
      if (mail === "off") return false;
      const where = origin();
      const unrecorded = message.unrecorded === true;
      const response = await doFetch(mail.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mail.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": unrecorded
            ? `cron-alert:unrecorded:${where.environment}:${where.project}:${message.job}:${message.openedAt}`
            : `cron-alert:${message.job}:${message.openedAt}`,
          "User-Agent": "zs-business-cron-alerts",
        },
        body: JSON.stringify({
          from: mail.from,
          to: [mail.to],
          subject: unrecorded
            ? `[ZS Hub ${where.environment}] Cron job "${message.job}" failed to start (not recorded)`
            : `[ZS Hub ${where.environment}] Cron job "${message.job}" is failing`,
          text: unrecorded
            ? [
              `The scheduled job "${message.job}" failed to start (seen in the hour of ${message.openedAt}).`,
              `Environment: ${where.environment}. Project: ${where.project}.`,
              "",
              `Error: ${message.error}`,
              "",
              "This failure could not be written to cron_alerts (the database URL is missing or unusable, or the database did not answer), so no alert row exists and nothing closes it.",
              "While the job keeps failing to start you get this email at most once an hour. Check the function log in Vercel for the job.",
            ].join("\n")
            : [
              `The scheduled job "${message.job}" failed at ${message.openedAt}.`,
              `Environment: ${where.environment}. Project: ${where.project}.`,
              "",
              `Error: ${message.error}`,
              "",
              "You get this email when an alert opens (again later only if the send did not go through), and again only if it is fixed and then fails again.",
              `To see every open alert, run in the ${where.environment} database:`,
              "  SELECT job, failure_count, last_failed_at, last_error FROM cron_alerts WHERE resolved_at IS NULL;",
              "The alert closes by itself on the next good run.",
            ].join("\n"),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(SEND_TIMEOUT_MS, options?.timeoutMs ?? SEND_TIMEOUT_MS)))),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) {
        report(`Cron alert email for ${message.job} refused: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      report(`Cron alert email for ${message.job} not sent`, error instanceof Error ? error.message : error);
      return false;
    }
  };
}
