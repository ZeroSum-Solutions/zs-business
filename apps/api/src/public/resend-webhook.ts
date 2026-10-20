// docs/requirements/resend.md R-7, R-8: the endpoint Resend posts email events to. Anonymous to the
// owner auth: the signature over the raw body is checked before anything is parsed or any database
// work, and the core session takes the tenant and delivery from the tags this system sent. Only
// bounces and complaints change anything; every other signed event is acknowledged so Resend does
// not retry it. Original code.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  apiErrorBody,
  createEmailFeedbackSession,
  resendEmailEventSchema,
  verifyResendWebhook,
  type EdgeDependencies,
  type EmailFeedbackOutcome,
  type ResendWebhookSecrets,
} from "@zs/core";
import type { AppEnv } from "../app.js";

/** Resend's email events are a few KiB; inbound mail (`email.received`) is not subscribed. */
export const RESEND_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface ResendWebhookConfig {
  /** The endpoint's signing secrets (`whsec_…`); `previous` keeps verifying through a rotation. */
  readonly secrets: ResendWebhookSecrets;
  /** The adapter's provider name, as recorded on deliveries; defaults to `resend`. */
  readonly providerName?: string;
  /** Receives what each signed event did, for logs. */
  readonly report?: (event: { readonly id: string; readonly type: string; readonly outcome: EmailFeedbackOutcome }) => void;
}

export function resendWebhookRoutes(
  edge: EdgeDependencies,
  config: ResendWebhookConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  return new Hono<AppEnv>()
    .use("/webhooks/resend", bodyLimit({
      maxSize: RESEND_WEBHOOK_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .post("/webhooks/resend", async (c) => {
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
      const event = resendEmailEventSchema.safeParse(verified.payload);
      // A signed event of a shape this system does not read (a contact or domain event) is not ours to act on.
      if (!event.success) return c.json({ handled: false, reason: "unread_event" }, 200);
      const session = createEmailFeedbackSession(requestEdge(c), {
        ...(config.providerName === undefined ? {} : { providerName: config.providerName }),
      });
      const outcome = await session.receive(verified.id, event.data);
      config.report?.({ id: verified.id, type: event.data.type, outcome });
      return c.json(outcome.handled ? { handled: true } : { handled: false, reason: outcome.reason }, 200);
    });
}
