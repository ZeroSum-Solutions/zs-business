// docs/requirements/inbound-email.md IE-8, IE-3, IE-4: the endpoint Resend posts received mail to.
// Its own path and secret, so the bounce endpoint's secret and subscriptions do not change. The
// signature over the raw body is checked before anything is parsed or any database work. Only
// `email.received` is read; every other signed event is acknowledged. Original code.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  apiErrorBody,
  createInboundEmailSession,
  INBOUND_EMAIL_EVENT_TYPE,
  inboundEmailEventSchema,
  verifyResendWebhook,
  type EdgeDependencies,
  type InboundEmailOutcome,
  type ResendWebhookSecrets,
} from "@zs/core";
import { INBOUND_WEBHOOK_MAX_BYTES } from "@zs/contracts";
import type { AppEnv } from "../app.js";

export const RESEND_INBOUND_WEBHOOK_PATH = "/webhooks/resend/inbound";

export interface ResendInboundWebhookConfig {
  /** `RESEND_INBOUND_WEBHOOK_SECRET` (and the previous one during a rotation). */
  readonly secrets: ResendWebhookSecrets;
  /** `INBOUND_EMAIL_DOMAIN`: only recipients at this domain route. */
  readonly domain: string;
  /**
   * Receives what each signed event did, for logs: Resend's `email_id`, the outcome and tenant IDs.
   * Never an address, subject or body (IE-4).
   */
  readonly report?: (event: {
    readonly id: string;
    readonly emailId: string | null;
    readonly outcome: InboundEmailOutcome | { readonly handled: false; readonly reason: "unavailable" };
  }) => void;
}

/** The email_id of a signed event, when it has a readable one; only for the log line. */
function emailIdOf(payload: unknown): string | null {
  const id = (payload as { data?: { email_id?: unknown } } | null)?.data?.email_id;
  return typeof id === "string" && /^[\x21-\x7e]{1,200}$/.test(id) ? id : null;
}

export function resendInboundWebhookRoutes(
  edge: EdgeDependencies,
  config: ResendInboundWebhookConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  return new Hono<AppEnv>()
    .use(RESEND_INBOUND_WEBHOOK_PATH, bodyLimit({
      maxSize: INBOUND_WEBHOOK_MAX_BYTES,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .post(RESEND_INBOUND_WEBHOOK_PATH, async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const verified = verifyResendWebhook({
        secrets: config.secrets,
        headers: {
          id: c.req.header("svix-id") ?? c.req.header("webhook-id"),
          timestamp: c.req.header("svix-timestamp") ?? c.req.header("webhook-timestamp"),
          signature: c.req.header("svix-signature") ?? c.req.header("webhook-signature"),
        },
        body,
        now: edge.clock.now(),
      });
      // One answer for every unsigned or stale request, so a caller learns nothing about why.
      if (!verified.ok)
        return verified.reason === "bad_json"
          ? c.json(apiErrorBody("ValidationFailed", "Invalid webhook payload"), 400)
          : c.json(apiErrorBody("Unauthorized", "Invalid webhook signature"), 401);
      const type = (verified.payload as { type?: unknown } | null)?.type;
      if (type !== INBOUND_EMAIL_EVENT_TYPE) return c.json({ handled: false, reason: "unread_event" }, 200);
      const emailId = emailIdOf(verified.payload);
      const event = inboundEmailEventSchema.safeParse(verified.payload);
      // A received message this system cannot read must not vanish: 400, so Resend shows it failed and retries.
      if (!event.success) {
        config.report?.({ id: verified.id, emailId, outcome: { handled: false, reason: "malformed_event" } });
        return c.json(apiErrorBody("ValidationFailed", "Unreadable email.received event"), 400);
      }
      let outcome: InboundEmailOutcome;
      try {
        outcome = await createInboundEmailSession(requestEdge(c), { domain: config.domain }).receive(event.data);
      } catch {
        // IE-8: a database error answers 503 and Resend retries; a stored receive replays.
        config.report?.({ id: verified.id, emailId, outcome: { handled: false, reason: "unavailable" } });
        return c.json(apiErrorBody("Unavailable", "Inbound email could not be stored; retry later"), 503);
      }
      config.report?.({ id: verified.id, emailId, outcome });
      if (!outcome.handled && outcome.reason === "malformed_event")
        return c.json(apiErrorBody("ValidationFailed", "Unreadable email.received event"), 400);
      return c.json(outcome.handled ? { handled: true } : { handled: false, reason: outcome.reason }, 200);
    });
}
