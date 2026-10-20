// M5 Resend webhooks (docs/requirements/resend.md R-7, R-8). Original code. Resend signs each
// webhook the Standard Webhooks way: an HMAC-SHA-256 over `<id>.<timestamp>.<raw body>` with the
// endpoint secret, sent as `v1,<base64>` entries in one header. Nothing here touches a database.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Webhooks older or newer than this are refused, so a captured request cannot be replayed later. */
export const RESEND_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]+={0,2}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,150}$/;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_HEADER_LIMIT = 4096;

export const resendWebhookSecretSchema = z.string().max(200)
  .refine((value) => SECRET_PATTERN.test(value), "A Resend webhook secret looks like whsec_ followed by base64")
  .refine((value) => Buffer.from(value.slice("whsec_".length), "base64").length >= 24, "Resend webhook secret is too short");

export interface ResendWebhookSecrets {
  readonly current: string;
  /** Still verifies during a rotation. */
  readonly previous?: string | undefined;
}

export interface ResendWebhookHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

export type ResendWebhookVerification =
  | { readonly ok: true; readonly id: string; readonly payload: unknown }
  | { readonly ok: false; readonly reason: "missing_headers" | "bad_timestamp" | "stale" | "bad_signature" | "bad_json" };

const sign = (secret: string, signed: Buffer): Buffer =>
  createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(signed).digest();

/** The header value Resend would send for this body; for tests and local tools. */
export function signResendWebhook(secret: string, id: string, timestampSeconds: number, body: string | Uint8Array): string {
  const signed = Buffer.concat([Buffer.from(`${id}.${timestampSeconds}.`), Buffer.from(body)]);
  return `v1,${sign(secret, signed).toString("base64")}`;
}

/**
 * R-7: checks the signature over the exact bytes received, then the timestamp against the
 * injected clock, and only then parses the JSON. Any `v1` entry signed by a known secret passes.
 */
export function verifyResendWebhook(input: {
  readonly secrets: ResendWebhookSecrets;
  readonly headers: ResendWebhookHeaders;
  readonly body: Uint8Array;
  readonly now: Date;
  readonly toleranceMs?: number;
}): ResendWebhookVerification {
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature || !ID_PATTERN.test(id) || signature.length > SIGNATURE_HEADER_LIMIT)
    return { ok: false, reason: "missing_headers" };
  if (!TIMESTAMP_PATTERN.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), Buffer.from(input.body)]);
  const expected = [input.secrets.current, input.secrets.previous]
    .filter((secret): secret is string => secret !== undefined)
    .map((secret) => sign(secret, signed));
  let valid = false;
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(entry.slice(comma + 1), "base64");
    for (const tag of expected) if (given.length === tag.length && timingSafeEqual(given, tag)) valid = true;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  const skew = Math.abs(input.now.getTime() - Number(timestamp) * 1000);
  if (skew > (input.toleranceMs ?? RESEND_WEBHOOK_TOLERANCE_MS)) return { ok: false, reason: "stale" };
  try {
    return { ok: true, id, payload: JSON.parse(Buffer.from(input.body).toString("utf8")) };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

const tagValue = z.string().max(256);
/** Resend sends tags as an object; an array of name/value pairs is accepted too. */
const tagsSchema = z.union([
  z.record(z.string().max(256), tagValue),
  z.array(z.object({ name: z.string().max(256), value: tagValue })).max(50)
    .transform((tags) => Object.fromEntries(tags.map((tag) => [tag.name, tag.value]))),
]);

/**
 * R-8: the fields an email event carries that this system uses; other fields pass unread. An
 * optional field may be absent or null.
 */
export const resendEmailEventSchema = z.object({
  type: z.string().min(1).max(100),
  data: z.object({
    email_id: z.string().min(1).max(500),
    to: z.union([z.string().max(320).transform((to) => [to]), z.array(z.string().max(320)).max(50)]),
    tags: tagsSchema.nullish(),
    bounce: z.object({ type: z.string().max(100).nullish() }).nullish(),
  }),
});

/** R-8: the event types that may suppress an address; one of these that cannot be read is an error. */
export const RESEND_SUPPRESSION_EVENT_TYPES: ReadonlySet<string> = new Set(["email.bounced", "email.complained", "email.suppressed"]);
export type ResendEmailEvent = z.infer<typeof resendEmailEventSchema>;

/**
 * R-8: the suppression an event calls for, or why it calls for none. A permanent bounce (or a
 * bounce with no type, since Resend raises `email.bounced` for permanent rejections) is a
 * `bounce`; a transient or undetermined one is not. A complaint is a `complaint`. An address
 * Resend refused because its own list holds it is a `bounce`. Other events change nothing.
 */
export function resendSuppressionReason(event: ResendEmailEvent): { reason: "bounce" | "complaint" } | { ignored: string } {
  switch (event.type) {
    case "email.bounced": {
      const type = event.data.bounce?.type?.toLowerCase();
      return type === undefined || type === "permanent" ? { reason: "bounce" } : { ignored: "bounce_not_permanent" };
    }
    case "email.complained":
      return { reason: "complaint" };
    case "email.suppressed":
      return { reason: "bounce" };
    default:
      return { ignored: "no_suppression" };
  }
}
