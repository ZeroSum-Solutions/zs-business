// docs/requirements/stripe.md S-3: the endpoint Stripe posts events to. Anonymous to the owner
// auth: the signature over the raw body is checked before anything is parsed or any database
// work. The route only stores the event; the billing worker (service role) moves money.
// Original code.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  apiErrorBody,
  recordStripeEvent,
  verifyStripeWebhook,
  type EdgeDependencies,
  type StripeWebhookSecrets,
} from "@zs/core";
import type { AppEnv } from "../app.js";

export const STRIPE_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface StripeWebhookConfig {
  /** The endpoint's signing secrets (`whsec_…`); `previous` keeps verifying through a rotation. */
  readonly secrets: StripeWebhookSecrets;
  /** Events from the other mode (test or live) are acknowledged and dropped. */
  readonly livemode: boolean;
  /** Receives what each signed event did, for logs. */
  readonly report?: (event: { readonly id: string; readonly type: string; readonly outcome: "stored" | "duplicate" | "other_mode" }) => void;
}

export function stripeWebhookRoutes(
  edge: EdgeDependencies,
  config: StripeWebhookConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  return new Hono<AppEnv>()
    .use("/webhooks/stripe", bodyLimit({
      maxSize: STRIPE_WEBHOOK_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .post("/webhooks/stripe", async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const now = edge.clock.now();
      const verified = verifyStripeWebhook({ secrets: config.secrets, header: c.req.header("stripe-signature"), body, now });
      // One answer for every unsigned or stale request, so a caller learns nothing about why.
      if (!verified.ok)
        return verified.reason === "bad_event"
          ? c.json(apiErrorBody("ValidationFailed", "Invalid webhook payload"), 400)
          : c.json(apiErrorBody("Unauthorized", "Invalid webhook signature"), 401);
      const { event } = verified;
      if (event.livemode !== config.livemode) {
        config.report?.({ id: event.id, type: event.type, outcome: "other_mode" });
        return c.json({ received: true, stored: false }, 200);
      }
      // A database error falls through to the app's 503, so Stripe delivers the event again.
      const { stored } = await recordStripeEvent(requestEdge(c).db, { event, payload: verified.payload, now });
      config.report?.({ id: event.id, type: event.type, outcome: stored ? "stored" : "duplicate" });
      return c.json({ received: true, stored }, 200);
    });
}
