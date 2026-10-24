// docs/requirements/twilio.md T-6, T-8: the endpoints Twilio posts status callbacks and inbound
// texts to. Anonymous to the owner auth: the signature over the URL (rebuilt from the configured
// base, never from the Host header) and every form field is checked before anything is parsed or
// any database work, and the core sessions take the tenant and delivery from that signed URL.
// Original code.
import { callSidSchema } from "@zs/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  apiErrorBody,
  createSmsStatusSession,
  createTwilioInboundSession,
  createVoiceSession,
  formFields,
  parseTwilioForm,
  retryableAsUnavailable,
  TWILIO_WEBHOOK_BODY_LIMIT,
  trimTrailingSlashes,
  twiml,
  twilioInboundSchema,
  twilioStatusCallbackSchema,
  verifyTwilioSignature,
  type EdgeDependencies,
  type InboundTextOutcome,
  type KeywordReplies,
  type SmsStatusOutcome,
  type TwilioAuthTokens,
} from "@zs/core";
import type { AppEnv } from "../app.js";
import { createMemoryRateLimiter, type RateLimiter } from "./limiter.js";

export interface TwilioWebhookConfig {
  /** The account's auth token; `previous` keeps verifying through a rotation. */
  readonly tokens: TwilioAuthTokens;
  /** Every webhook must name this account. */
  readonly accountSid: string;
  /** The API's public origin as Twilio calls it, e.g. https://api.example.com (no trailing slash). */
  readonly webhookBaseUrl: string;
  /** T-8: who answers STOP, START and HELP; defaults to Twilio's own opt-out handling. */
  readonly keywordReplies?: KeywordReplies;
  /** The adapter's provider name, as recorded on deliveries; defaults to `twilio`. */
  readonly providerName?: string;
  /** T-14: the limiter the voice routes charge; defaults to an in-memory one on the app clock. */
  readonly limiter?: RateLimiter;
  /** Receives what each signed webhook did, for logs. */
  readonly report?: (event:
    | { readonly kind: "status"; readonly messageSid: string; readonly outcome: SmsStatusOutcome }
    | { readonly kind: "inbound"; readonly messageSid: string; readonly outcome: InboundTextOutcome }) => void;
}

/** T-6: a lock wait or deadlock answers 503 (Twilio retries), not a 409 it would drop. */
const retryable = (error: unknown): never => { throw retryableAsUnavailable(error); };

const xml = (c: Context<AppEnv>, reply: string | null) =>
  c.body(twiml(reply), 200, { "Content-Type": "text/xml; charset=utf-8" });

export function twilioWebhookRoutes(
  edge: EdgeDependencies,
  config: TwilioWebhookConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  const base = trimTrailingSlashes(config.webhookBaseUrl);
  const unauthorized = (c: Context<AppEnv>) => c.json(apiErrorBody("Unauthorized", "Invalid webhook signature"), 401);

  /** The signed form fields, or null when the request is not Twilio's for this account. */
  async function verified(c: Context<AppEnv>): Promise<Record<string, string> | null> {
    const params = parseTwilioForm(new Uint8Array(await c.req.arrayBuffer()));
    if (!params) return null;
    const url = new URL(c.req.url);
    const signed = verifyTwilioSignature({
      tokens: config.tokens,
      url: `${base}${url.pathname}${url.search}`,
      params,
      signature: c.req.header("x-twilio-signature"),
    });
    if (!signed) return null;
    const fields = formFields(params);
    return fields.AccountSid === config.accountSid ? fields : null;
  }

  // T-14: the voice routes' limiter, behind the core session's port.
  const limiter = config.limiter ?? createMemoryRateLimiter(edge.clock);
  const voiceLimiter = { take: (charges: Parameters<RateLimiter["take"]>[0]) => limiter.take(charges) };

  /** T-10: a signed voice webhook with a valid CallSid, handed to the voice session; 401 and 400 come first. */
  const voice = (answer: (c: Context<AppEnv>, fields: Record<string, string>) => Promise<string>) =>
    async (c: Context<AppEnv>) => {
      const fields = await verified(c);
      if (!fields) return unauthorized(c);
      if (!callSidSchema.safeParse(fields.CallSid).success) return c.json(apiErrorBody("ValidationFailed", "Invalid CallSid"), 400);
      const reply = await answer(c, fields).catch(retryable);
      return c.body(reply, 200, { "Content-Type": "text/xml; charset=utf-8" });
    };
  const tenantOf = (c: Context<AppEnv>) => c.req.param("tenantId") ?? "";
  const session = (c: Context<AppEnv>) => createVoiceSession(requestEdge(c), { webhookBaseUrl: base, limiter: voiceLimiter });

  return new Hono<AppEnv>()
    .use("/webhooks/twilio/*", bodyLimit({
      maxSize: TWILIO_WEBHOOK_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .post("/webhooks/twilio/status/:tenantId/:deliveryId", async (c) => {
      const fields = await verified(c);
      if (!fields) return unauthorized(c);
      const callback = twilioStatusCallbackSchema.safeParse(fields);
      // A signed callback of a shape this system does not read changes nothing.
      if (!callback.success) return c.json({ handled: false, reason: "unread_callback" }, 200);
      const session = createSmsStatusSession(requestEdge(c), {
        ...(config.providerName === undefined ? {} : { providerName: config.providerName }),
      });
      const outcome = await session.receive(c.req.param("tenantId"), c.req.param("deliveryId"), callback.data).catch(retryable);
      config.report?.({ kind: "status", messageSid: callback.data.MessageSid, outcome });
      return c.json(outcome.handled ? { handled: true } : { handled: false, reason: outcome.reason }, 200);
    })
    .post("/webhooks/twilio/inbound/:tenantId", async (c) => {
      const fields = await verified(c);
      if (!fields) return unauthorized(c);
      const message = twilioInboundSchema.safeParse(fields);
      if (!message.success) return xml(c, null);
      const session = createTwilioInboundSession(requestEdge(c), {
        ...(config.keywordReplies === undefined ? {} : { keywordReplies: config.keywordReplies }),
      });
      const outcome = await session.receive(c.req.param("tenantId"), message.data).catch(retryable);
      config.report?.({ kind: "inbound", messageSid: message.data.MessageSid, outcome });
      return xml(c, outcome.handled ? outcome.reply : null);
    })
    .post("/webhooks/twilio/voice/:tenantId", voice((c, f) =>
      session(c).incoming(tenantOf(c), { CallSid: f.CallSid!, From: f.From ?? "", To: f.To ?? "" })))
    .post("/webhooks/twilio/voice/:tenantId/dial", voice((c, f) =>
      session(c).dial(tenantOf(c), { CallSid: f.CallSid!, DialCallStatus: f.DialCallStatus ?? "" })))
    .post("/webhooks/twilio/voice/:tenantId/gather", voice((c, f) =>
      session(c).gather(tenantOf(c), { CallSid: f.CallSid!, Digits: f.Digits }, c.req.query("v"))))
    .post("/webhooks/twilio/voice/:tenantId/recording", voice((c, f) =>
      session(c).recording(tenantOf(c), {
        CallSid: f.CallSid!, RecordingSid: f.RecordingSid, RecordingStatus: f.RecordingStatus, RecordingDuration: f.RecordingDuration,
      }, c.req.query("step"))));
}
