// M5 Resend email adapter behind the M3d provider port (docs/requirements/resend.md R-1..R-6).
// Original code, written from Resend's public API behaviour in our own words. It only calls the
// fetch it is given; nothing here reads the environment or the system clock.
import { z } from "zod";
import { secureUrlProblem } from "../edge/auth.js";
import type { DeliveryProvider, ProviderSendOutcome, ProviderSendRequest } from "./provider.js";

/** Resend keeps an idempotency key for 24 hours and drops a repeat inside that time (R-2). */
export const RESEND_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESEND_DEFAULT_BASE_URL = "https://api.resend.com";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;
const TAG_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
/** Headers Resend sets from its own fields, or that would change who the mail is for. */
const RESERVED_HEADERS = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "sender", "content-type",
  "content-transfer-encoding", "mime-version", "message-id", "date", "return-path", "dkim-signature"]);
/** Connection errors that prove the request never left this process (R-3). */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "ENETUNREACH", "EHOSTUNREACH"]);

const oneLine = (max: number) => z.string().min(1).max(max).refine((value) => !/[\r\n\u0000]/.test(value), "Must be one line");

export const resendConfigSchema = z.strictObject({
  apiKey: z.string().min(8).max(500).refine((value) => /^[\x21-\x7e]+$/.test(value), "API key must be printable ASCII"),
  /** The sender, `Name <address>` or a bare address on a domain verified in Resend. */
  from: oneLine(320).refine((value) => value.includes("@"), "from must name an address"),
  replyTo: oneLine(320).refine((value) => value.includes("@"), "replyTo must name an address").optional(),
  baseUrl: z.string().default(RESEND_DEFAULT_BASE_URL)
    .superRefine((value, ctx) => {
      const problem = secureUrlProblem("baseUrl", value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  /** Recorded on deliveries as `provider`; webhooks only act on deliveries with this name. */
  name: z.string().min(1).max(100).default("resend"),
  /** Never longer than Resend's own window; shorter only to be more careful. */
  dedupeWindowMs: z.number().int().positive().max(RESEND_DEDUPE_WINDOW_MS).default(RESEND_DEDUPE_WINDOW_MS),
});
export type ResendConfig = z.input<typeof resendConfigSchema>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * R-3: what one HTTP answer means for the delivery. Only a refusal that proves Resend did not
 * take the message is `failed` or `rejected`; anything that might have been taken is `uncertain`,
 * so the worker keeps the reservation and resends under the same key inside the window.
 */
export function classifyResendResponse(status: number, body: unknown): ProviderSendOutcome {
  const name = errorName(body);
  const code = (prefix: string) => `${prefix}_${status}${name ? `_${name}` : ""}`;
  if (status >= 200 && status < 300) {
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    return typeof id === "string" && /^[\x21-\x7e]{1,500}$/.test(id)
      ? { status: "accepted", providerMessageId: id }
      // Taken, but with no ID to record; the resend under the same key answers with it.
      : { status: "uncertain", code: "resend_unreadable_success" };
  }
  // A key in flight, or a key already used: an earlier request with it may have been sent.
  if (status === 409 || status === 408) return { status: "uncertain", code: code("resend") };
  // The request itself is wrong; replaying the same request cannot fix it.
  if (status === 400 || status === 413 || status === 422) return { status: "rejected", code: code("resend") };
  // Refused before acceptance: rate limits and quotas, a key or domain the operator must fix,
  // a wrong base URL. Retrying with backoff is safe and bounded by the attempt cap.
  if (status >= 400 && status < 500) return { status: "failed", code: code("resend") };
  // A server error, a gateway, a redirect: the message may have been taken.
  return { status: "uncertain", code: code("resend") };
}

function errorName(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const clean = name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 60);
  return clean || null;
}

/** R-4: the request that is safe to hand to Resend, or the reason it must not be sent. */
function buildBody(config: z.infer<typeof resendConfigSchema>, request: ProviderSendRequest):
  { ok: true; body: string } | { ok: false; code: string } {
  if (request.channel !== "email") return { ok: false, code: "resend_channel_not_email" };
  if (!KEY_PATTERN.test(request.idempotencyKey)) return { ok: false, code: "resend_invalid_idempotency_key" };
  if (!request.subject || /[\r\n]/.test(request.subject)) return { ok: false, code: "resend_invalid_subject" };
  if (!request.to.includes("@") || /[\s,;<>]/.test(request.to)) return { ok: false, code: "resend_invalid_recipient" };
  if (!TAG_VALUE_PATTERN.test(request.tenantId) || !TAG_VALUE_PATTERN.test(request.deliveryId))
    return { ok: false, code: "resend_invalid_tag" };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HEADER_NAME_PATTERN.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, code: "resend_invalid_header" };
    if (/[\r\n\u0000]/.test(value) || value.length > 2000) return { ok: false, code: "resend_invalid_header" };
    headers[name] = value;
  }
  // D-9: every email carries a one-click unsubscribe (RFC 8058) to an https URL.
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const listUnsubscribe = lower.get("list-unsubscribe");
  if (!listUnsubscribe || !/<https:\/\/[^<>\s]+>/.test(listUnsubscribe)
    || lower.get("list-unsubscribe-post") !== "List-Unsubscribe=One-Click")
    return { ok: false, code: "resend_unsubscribe_missing" };
  // The same request byte for byte on every attempt: Resend refuses a key reused with another body.
  return {
    ok: true,
    body: JSON.stringify({
      from: config.from,
      to: [request.to],
      subject: request.subject,
      text: request.text,
      headers,
      ...(config.replyTo === undefined ? {} : { reply_to: config.replyTo }),
      // R-5: webhooks name the tenant and delivery through these tags.
      tags: [{ name: "zs_tenant", value: request.tenantId }, { name: "zs_delivery", value: request.deliveryId }],
    }),
  };
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
 * The Resend adapter. It has no `lookup`: Resend cannot be asked about an idempotency key without
 * sending, so an outcome that stays unknown past the window is a dead letter for an operator (D-8).
 */
export function createResendProvider(deps: { readonly config: ResendConfig; readonly fetch?: Fetch }): DeliveryProvider {
  const parsed = resendConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new Error(`Invalid Resend config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const config = parsed.data;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/emails`;

  return {
    name: config.name,
    dedupeWindowMs: config.dedupeWindowMs,
    async send(request, { signal }) {
      const built = buildBody(config, request);
      if (!built.ok) return { status: "rejected", code: built.code };
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": request.idempotencyKey,
            "User-Agent": "zs-business-delivery",
          },
          body: built.body,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) return { status: "uncertain", code: "resend_timeout" };
        const code = connectionCode(error);
        // The connection never opened, so nothing reached Resend.
        if (code && NOT_SENT_CODES.has(code)) return { status: "failed", code: `resend_connect_${code.toLowerCase()}` };
        return { status: "uncertain", code: code ? `resend_network_${code.toLowerCase()}` : "resend_network" };
      }
      let text: string;
      try {
        text = await readLimited(response, RESPONSE_LIMIT_BYTES);
      } catch {
        // The status line arrived, the body did not: a 2xx stays unproven, an error status stands.
        text = "";
      }
      return classifyResendResponse(response.status, parseJson(text));
    },
  };
}

/** The variables the Mac sets for the sender (R-6); the cloud never holds their values. */
export const resendEnvSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM: z.string().min(1),
  RESEND_REPLY_TO: z.string().min(1).optional(),
  RESEND_BASE_URL: z.string().min(1).optional(),
});

/** Builds the adapter config from an environment object an entry point passes in. */
export function parseResendEnv(env: Readonly<Record<string, string | undefined>>): ResendConfig {
  const parsed = resendEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  const config: ResendConfig = {
    apiKey: parsed.data.RESEND_API_KEY,
    from: parsed.data.RESEND_FROM,
    ...(parsed.data.RESEND_REPLY_TO === undefined ? {} : { replyTo: parsed.data.RESEND_REPLY_TO }),
    ...(parsed.data.RESEND_BASE_URL === undefined ? {} : { baseUrl: parsed.data.RESEND_BASE_URL }),
  };
  const checked = resendConfigSchema.safeParse(config);
  const variables: Record<string, string> = { apiKey: "RESEND_API_KEY", from: "RESEND_FROM", replyTo: "RESEND_REPLY_TO", baseUrl: "RESEND_BASE_URL" };
  if (!checked.success) throw new Error(`Invalid environment: ${checked.error.issues
    .map((issue) => `${variables[String(issue.path[0])] ?? issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return config;
}
