// M5 Twilio SMS adapter behind the M3d provider port (docs/requirements/twilio.md T-1..T-5, T-9).
// Original code, written from Twilio's public Messages API behaviour in our own words. It only
// calls the fetch, sender lookup and status lookup it is given; nothing here reads the
// environment or the system clock.
import { z } from "zod";
import { secureUrlProblem } from "../edge/auth.js";
import type { DeliveryProvider, ProviderLookupOutcome, ProviderSendOutcome, ProviderSendRequest } from "./provider.js";

export const TWILIO_DEFAULT_BASE_URL = "https://api.twilio.com";
/** The longest `Body` Twilio takes, in characters (T-3). */
export const TWILIO_BODY_MAX = 1600;
/** How long an unknown outcome waits for a status callback by default (T-2). */
export const TWILIO_DEFAULT_OUTCOME_WAIT_MS = 24 * 60 * 60 * 1000;
export const TWILIO_MAX_OUTCOME_WAIT_MS = 72 * 60 * 60 * 1000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/;
const API_KEY_SID_PATTERN = /^SK[0-9a-f]{32}$/;
/** A message resource: `SM` for SMS, `MM` for a message Twilio sent as MMS. */
const MESSAGE_SID_PATTERN = /^(SM|MM)[0-9a-f]{32}$/;
const E164_PATTERN = /^\+[1-9][0-9]{1,14}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Connection errors that prove the request never left this process (T-4). */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "ENETUNREACH", "EHOSTUNREACH"]);

const urlField = (variable: string) => z.string().superRefine((value, ctx) => {
  const problem = secureUrlProblem(variable, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const twilioConfigSchema = z.strictObject({
  accountSid: z.string().regex(ACCOUNT_SID_PATTERN, "accountSid must be AC followed by 32 hex digits"),
  /** The account's auth token; or leave it out and give an API key below (T-9). */
  authToken: z.string().regex(/^[0-9a-f]{32}$/i, "authToken must be 32 hex digits").optional(),
  apiKeySid: z.string().regex(API_KEY_SID_PATTERN, "apiKeySid must be SK followed by 32 hex digits").optional(),
  apiKeySecret: z.string().min(16, "apiKeySecret is too short").max(200, "apiKeySecret is too long")
    .refine((value) => /^[\x21-\x7e]+$/.test(value), "apiKeySecret must be printable ASCII").optional(),
  /** The API's public origin; status callbacks come back under it (T-3, T-6). */
  webhookBaseUrl: urlField("webhookBaseUrl")
    .refine((value) => { const url = URL.parse(value); return !url || (!url.search && !url.hash); }, "webhookBaseUrl must not carry a query or fragment"),
  baseUrl: urlField("baseUrl").default(TWILIO_DEFAULT_BASE_URL),
  /** Recorded on deliveries as `provider`; status callbacks only act on deliveries with this name. */
  name: z.string().min(1).max(100).default("twilio"),
  outcomeWaitMs: z.number().int().positive().max(TWILIO_MAX_OUTCOME_WAIT_MS).default(TWILIO_DEFAULT_OUTCOME_WAIT_MS),
}).superRefine((config, ctx) => {
  // Exactly one way to sign in: the auth token, or an API key SID with its secret.
  const keyGiven = config.apiKeySid !== undefined || config.apiKeySecret !== undefined;
  if (config.authToken !== undefined && keyGiven)
    ctx.addIssue({ code: "custom", path: ["authToken"], message: "give authToken or an API key, not both" });
  else if (keyGiven && config.apiKeySid === undefined)
    ctx.addIssue({ code: "custom", path: ["apiKeySid"], message: "apiKeySid is required with apiKeySecret" });
  else if (keyGiven && config.apiKeySecret === undefined)
    ctx.addIssue({ code: "custom", path: ["apiKeySecret"], message: "apiKeySecret is required with apiKeySid" });
  else if (!keyGiven && config.authToken === undefined)
    ctx.addIssue({ code: "custom", path: ["authToken"], message: "give authToken or apiKeySid with apiKeySecret" });
});
export type TwilioConfig = z.input<typeof twilioConfigSchema>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The tenant's own sending number in E.164 (`sms_numbers`, T-7), or null when it has none. */
export type TwilioSenderLookup = (tenantId: string, options: { readonly signal: AbortSignal }) => Promise<string | null>;
/** Any status callback recorded for the delivery (`sms_status_events`, T-5), or null. */
export type TwilioStatusLookup = (
  input: { readonly tenantId: string; readonly deliveryId: string },
  options: { readonly signal: AbortSignal },
) => Promise<{ readonly messageSid: string } | null>;

/**
 * T-4: what one HTTP answer means for the delivery. Twilio drops no repeat, so only a refusal
 * that proves no message was created is `failed` or `rejected`; anything that might have created
 * one is `uncertain`, and the worker waits for a status callback instead of sending again.
 */
export function classifyTwilioResponse(status: number, body: unknown): ProviderSendOutcome {
  const twilioCode = errorCode(body);
  const code = `twilio_${status}${twilioCode ? `_${twilioCode}` : ""}`;
  if (status >= 200 && status < 300) {
    const sid = body && typeof body === "object" ? (body as { sid?: unknown }).sid : undefined;
    return typeof sid === "string" && MESSAGE_SID_PATTERN.test(sid)
      ? { status: "accepted", providerMessageId: sid }
      // Created, but with no SID to record; the status callback names it.
      : { status: "uncertain", code: "twilio_unreadable_success" };
  }
  // A timeout or conflict on Twilio's side: the message may exist all the same.
  if (status === 408 || status === 409) return { status: "uncertain", code };
  // The request itself is wrong (a bad number, an opted-out recipient, a sender Twilio will not
  // use); replaying the same request cannot fix it.
  if (status === 400 || status === 413 || status === 422) return { status: "rejected", code };
  // Refused before a message was created: rate limits, credentials, a wrong account path.
  // Retrying with backoff is safe and bounded by the attempt cap.
  if (status >= 400 && status < 500) return { status: "failed", code };
  // A server error, a gateway, a redirect: the message may have been created.
  return { status: "uncertain", code };
}

/** Twilio's numeric error code from an error body, as digits, or null. */
function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const code = (body as { code?: unknown }).code;
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) {
    const digits = String(code);
    return digits.length <= 10 ? digits : null;
  }
  if (typeof code === "string" && /^[0-9]{1,10}$/.test(code)) return code;
  return null;
}

/** T-3: the checks that need no lookup, or the reason the request must not be sent. */
function requestProblem(request: ProviderSendRequest): string | null {
  if (request.channel !== "sms") return "twilio_channel_not_sms";
  if (!UUID_PATTERN.test(request.tenantId) || !UUID_PATTERN.test(request.deliveryId)) return "twilio_invalid_id";
  if (!E164_PATTERN.test(request.to)) return "twilio_invalid_recipient";
  if (request.text.length === 0 || request.text.length > TWILIO_BODY_MAX || request.text.includes("\u0000")) return "twilio_invalid_body";
  return null;
}

/** Reads at most `limit` bytes of the body; a longer body is cut, which parses as unreadable. */
async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return "";
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function connectionCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The Twilio adapter (T-1). Twilio documents no idempotency key, so it declares no dedupe window
 * (T-2) and answers `lookup` from recorded status callbacks only (T-5): evidence proves a
 * message exists, and the lack of it proves nothing, so it never answers `not_found`.
 */
export function createTwilioProvider(deps: {
  readonly config: TwilioConfig;
  readonly senderFor: TwilioSenderLookup;
  readonly findStatus: TwilioStatusLookup;
  readonly fetch?: Fetch;
}): DeliveryProvider {
  const parsed = twilioConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new Error(`Invalid Twilio config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const config = parsed.data;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const webhookBase = config.webhookBaseUrl.replace(/\/+$/, "");
  // The schema guarantees one complete credential form.
  const user = config.apiKeySid ?? config.accountSid;
  const password = config.apiKeySid === undefined ? config.authToken : config.apiKeySecret;
  const authorization = `Basic ${Buffer.from(`${user}:${password ?? ""}`, "utf8").toString("base64")}`;

  return {
    name: config.name,
    dedupeWindowMs: 0,
    outcomeWaitMs: config.outcomeWaitMs,
    async send(request, { signal }) {
      const problem = requestProblem(request);
      if (problem) return { status: "rejected", code: problem };
      let sender: string | null;
      try {
        sender = await deps.senderFor(request.tenantId, { signal });
      } catch {
        // Nothing was sent; the next attempt looks the number up again.
        return { status: "failed", code: "twilio_sender_lookup" };
      }
      if (sender === null) return { status: "rejected", code: "twilio_no_sender" };
      if (typeof sender !== "string" || !E164_PATTERN.test(sender)) return { status: "rejected", code: "twilio_invalid_sender" };
      // A deadline that passed during the lookup: no connection was opened, so nothing was sent.
      if (signal.aborted) return { status: "failed", code: "twilio_timeout_before_send" };
      // A fixed field order, so every attempt of one delivery is the same request.
      const form = new URLSearchParams();
      form.append("To", request.to);
      form.append("From", sender);
      form.append("Body", request.text);
      form.append("StatusCallback", `${webhookBase}/webhooks/twilio/status/${request.tenantId}/${request.deliveryId}`);
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "zs-business-delivery",
          },
          body: form.toString(),
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) return { status: "uncertain", code: "twilio_timeout" };
        const code = connectionCode(error);
        // The connection never opened, so nothing reached Twilio.
        if (code && NOT_SENT_CODES.has(code)) return { status: "failed", code: `twilio_connect_${code.toLowerCase()}` };
        return { status: "uncertain", code: code ? `twilio_network_${code.toLowerCase()}` : "twilio_network" };
      }
      let text: string;
      try {
        text = await readLimited(response, RESPONSE_LIMIT_BYTES);
      } catch {
        // The status line arrived, the body did not: a 2xx stays unproven, an error status stands.
        text = "";
      }
      return classifyTwilioResponse(response.status, parseJson(text));
    },
    async lookup(key, { signal, tenantId, deliveryId }): Promise<ProviderLookupOutcome> {
      if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(deliveryId)) return { status: "unknown", code: "twilio_invalid_id" };
      // The worker keys every delivery `zsd-<deliveryId>`; anything else is not this delivery.
      if (key !== `zsd-${deliveryId}`) return { status: "unknown", code: "twilio_key_mismatch" };
      let found: { readonly messageSid: string } | null;
      try {
        found = await deps.findStatus({ tenantId, deliveryId }, { signal });
      } catch {
        return { status: "unknown", code: "twilio_status_lookup" };
      }
      // No callback yet is not proof of no message: it can be late or lost.
      if (found === null) return { status: "unknown", code: "twilio_no_status_evidence" };
      const sid = (found as { messageSid?: unknown }).messageSid;
      if (typeof sid !== "string" || !MESSAGE_SID_PATTERN.test(sid)) return { status: "unknown", code: "twilio_unreadable_status" };
      return { status: "accepted", providerMessageId: sid };
    },
  };
}

/** The variables the Mac sets for the runner (T-9); the cloud never holds their values. */
export const twilioEnvSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_API_KEY_SID: z.string().min(1).optional(),
  TWILIO_API_KEY_SECRET: z.string().min(1).optional(),
  TWILIO_WEBHOOK_BASE_URL: z.string().min(1),
  TWILIO_BASE_URL: z.string().min(1).optional(),
  TWILIO_OUTCOME_WAIT_MS: z.coerce.number().int().optional(),
});

const ENV_VARIABLES: Readonly<Record<string, string>> = {
  accountSid: "TWILIO_ACCOUNT_SID",
  authToken: "TWILIO_AUTH_TOKEN",
  apiKeySid: "TWILIO_API_KEY_SID",
  apiKeySecret: "TWILIO_API_KEY_SECRET",
  webhookBaseUrl: "TWILIO_WEBHOOK_BASE_URL",
  baseUrl: "TWILIO_BASE_URL",
  outcomeWaitMs: "TWILIO_OUTCOME_WAIT_MS",
};

/**
 * Builds the adapter config from an environment object an entry point passes in. An API key,
 * when given, wins over the auth token (Twilio's advice for REST calls); its SID and secret
 * come together or not at all.
 */
export function parseTwilioEnv(env: Readonly<Record<string, string | undefined>>): TwilioConfig {
  const parsed = twilioEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  const vars = parsed.data;
  const { TWILIO_API_KEY_SID: keySid, TWILIO_API_KEY_SECRET: keySecret, TWILIO_AUTH_TOKEN: authToken } = vars;
  let credentials: { apiKeySid: string; apiKeySecret: string } | { authToken: string };
  if (keySid !== undefined && keySecret !== undefined) credentials = { apiKeySid: keySid, apiKeySecret: keySecret };
  else if (keySid !== undefined || keySecret !== undefined)
    throw new Error("Invalid environment: TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together");
  else if (authToken !== undefined) credentials = { authToken };
  else throw new Error("Invalid environment: TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID with TWILIO_API_KEY_SECRET");
  const config: TwilioConfig = {
    accountSid: vars.TWILIO_ACCOUNT_SID,
    ...credentials,
    webhookBaseUrl: vars.TWILIO_WEBHOOK_BASE_URL,
    ...(vars.TWILIO_BASE_URL === undefined ? {} : { baseUrl: vars.TWILIO_BASE_URL }),
    ...(vars.TWILIO_OUTCOME_WAIT_MS === undefined ? {} : { outcomeWaitMs: vars.TWILIO_OUTCOME_WAIT_MS }),
  };
  const checked = twilioConfigSchema.safeParse(config);
  if (!checked.success) throw new Error(`Invalid environment: ${checked.error.issues
    .map((issue) => `${ENV_VARIABLES[String(issue.path[0])] ?? issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return config;
}
