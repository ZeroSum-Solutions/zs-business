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
}
export type CronAlertNotifier = (message: CronAlertMessage) => Promise<void>;

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

  return async (message) => {
    try {
      const mail = configured();
      if (mail === "off") return;
      const response = await doFetch(mail.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mail.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `cron-alert:${message.job}:${message.openedAt}`,
          "User-Agent": "zs-business-cron-alerts",
        },
        body: JSON.stringify({
          from: mail.from,
          to: [mail.to],
          subject: `[ZS Hub] Cron job "${message.job}" is failing`,
          text: [
            `The scheduled job "${message.job}" failed at ${message.openedAt}.`,
            "",
            `Error: ${message.error}`,
            "",
            "You get this one email when an alert opens, and again only if it is fixed and then fails again.",
            "To see every open alert, run in the production database:",
            "  SELECT job, failure_count, last_failed_at, last_error FROM cron_alerts WHERE resolved_at IS NULL;",
            "The alert closes by itself on the next good run.",
          ].join("\n"),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) report(`Cron alert email for ${message.job} refused: HTTP ${response.status}`);
    } catch (error) {
      report(`Cron alert email for ${message.job} not sent`, error instanceof Error ? error.message : error);
    }
  };
}
