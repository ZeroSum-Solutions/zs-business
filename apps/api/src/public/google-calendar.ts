// docs/requirements/google-calendar.md G-2, G-8: the two anonymous Google routes. Original code.
// The OAuth callback trusts only its signed state, and runs the connect action as the member the
// state names. The push webhook checks the channel token before any database work and only stores
// that a channel changed; the calendar worker (service role) does the rest.
import type { KeyObject } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  apiErrorBody,
  createOAuthCallbackSession,
  recordCalendarPush,
  verifyChannelToken,
  type EdgeDependencies,
  type GoogleClient,
  type OAuthCallbackReason,
  type OAuthStateSecrets,
} from "@zs/core";
import type { AppEnv } from "../app.js";

/** Google sends no body with a push; anything larger than this is not Google. */
export const GOOGLE_WEBHOOK_BODY_LIMIT = 4 * 1024;

export interface GoogleCalendarConfig {
  readonly google: GoogleClient;
  /** Signs and verifies the OAuth state; `previous` keeps verifying through a rotation. */
  readonly stateSecrets: OAuthStateSecrets;
  /** Seals refresh tokens for the calendar worker, which alone holds the private key (G-3). */
  readonly tokenPublicKey: KeyObject;
  /** The dashboard page the callback redirects to (GOOGLE_RETURN_URL). */
  readonly returnUrl: string;
  /** Verifies X-Goog-Channel-Token (G-8). */
  readonly channelSecret: string;
  /** Receives what each callback and push did, for logs; never a token. */
  readonly report?: (event:
    | { readonly route: "callback"; readonly outcome: "connected" | "bad_state" | OAuthCallbackReason }
    | { readonly route: "webhook"; readonly outcome: "stored" | "duplicate" }) => void;
}

/** The callback lands in a browser: nothing may cache it, and the code must not leak as a Referer. */
const CALLBACK_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const UNAUTHORIZED = apiErrorBody("Unauthorized", "Invalid channel token");

export function googleCalendarRoutes(
  config: GoogleCalendarConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  return new Hono<AppEnv>()
    .get("/oauth/google/callback", async (c) => {
      const outcome = await createOAuthCallbackSession(requestEdge(c)).complete({
        state: c.req.query("state"), code: c.req.query("code"), error: c.req.query("error"),
      }, c.var.signal);
      if (!outcome.ok) {
        config.report?.({ route: "callback", outcome: "bad_state" });
        return c.json(apiErrorBody("ValidationFailed", "Invalid OAuth state"), 400, CALLBACK_HEADERS);
      }
      const target = new URL(config.returnUrl);
      if (outcome.connected) target.searchParams.set("calendar", "connected");
      else {
        target.searchParams.set("calendar", "error");
        target.searchParams.set("reason", outcome.reason);
      }
      config.report?.({ route: "callback", outcome: outcome.connected ? "connected" : outcome.reason });
      for (const [name, value] of Object.entries(CALLBACK_HEADERS)) c.header(name, value);
      return c.redirect(target.toString(), 303);
    })
    .use("/webhooks/google/calendar", bodyLimit({
      maxSize: GOOGLE_WEBHOOK_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .post("/webhooks/google/calendar", async (c) => {
      const channelId = (c.req.header("x-goog-channel-id") ?? "").toLowerCase();
      // One answer for every missing or wrong token, before any database work.
      if (!verifyChannelToken(config.channelSecret, channelId, c.req.header("x-goog-channel-token")))
        return c.json(UNAUTHORIZED, 401);
      const messageNumber = c.req.header("x-goog-message-number") ?? "";
      const resourceState = c.req.header("x-goog-resource-state") ?? "";
      if (!/^\d{1,18}$/.test(messageNumber) || !/^[a-z_]{1,40}$/.test(resourceState))
        return c.json(apiErrorBody("ValidationFailed", "Invalid push notification"), 400);
      // A database error falls through to the app's 503, so Google delivers the push again.
      const { stored } = await recordCalendarPush(requestEdge(c).db, { channelId, messageNumber, resourceState, now: requestEdge(c).clock.now() });
      config.report?.({ route: "webhook", outcome: stored ? "stored" : "duplicate" });
      return c.json({ received: true, stored }, 200);
    });
}
