// M5 Twilio webhooks (docs/requirements/twilio.md T-6, T-8). Original code, written from Twilio's
// public webhook behaviour in our own words. Twilio signs each webhook with an HMAC-SHA1, keyed
// by the account's auth token, over the URL it called followed by every POST parameter name and
// value sorted by name, sent base64 in X-Twilio-Signature. Nothing here touches a database.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Status callbacks and inbound texts are a few KiB of form fields. */
export const TWILIO_WEBHOOK_BODY_LIMIT = 64 * 1024;
/** Twilio's error for a send to a number that opted out at Twilio (T-6). */
export const TWILIO_OPTED_OUT_ERROR = "21610";
const SIGNATURE_LIMIT = 200;

export const twilioAuthTokenSchema = z.string().regex(/^[0-9a-f]{32}$/i, "A Twilio auth token is 32 hex characters");
export const twilioAccountSidSchema = z.string().regex(/^AC[0-9a-f]{32}$/, "A Twilio account SID is AC and 32 hex characters");
const messageSidSchema = z.string().regex(/^(SM|MM)[0-9a-f]{32}$/);

export interface TwilioAuthTokens {
  readonly current: string;
  /** Still verifies during a rotation (Twilio's secondary token). */
  readonly previous?: string | undefined;
}

/** The string Twilio signs: the URL, then each parameter name and value, sorted by name. */
function signedText(url: string, params: URLSearchParams): string {
  const entries = [...params.entries()];
  // Code-unit order by name, then by value, so repeated names sign the same way every time.
  entries.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return url + entries.map(([name, value]) => name + value).join("");
}

const sign = (token: string, text: string): Buffer => createHmac("sha1", token).update(text, "utf8").digest();

/** The header value Twilio would send for this request; for tests and local tools. */
export function signTwilioRequest(authToken: string, url: string, params: URLSearchParams): string {
  return sign(authToken, signedText(url, params)).toString("base64");
}

/** T-6: true when the signature matches the current or previous token, compared in constant time. */
export function verifyTwilioSignature(input: {
  readonly tokens: TwilioAuthTokens;
  readonly url: string;
  readonly params: URLSearchParams;
  readonly signature: string | undefined;
}): boolean {
  const { signature } = input;
  if (!signature || signature.length > SIGNATURE_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const given = Buffer.from(signature, "base64");
  const text = signedText(input.url, input.params);
  let valid = false;
  for (const token of [input.tokens.current, input.tokens.previous]) {
    if (token === undefined) continue;
    const expected = sign(token, text);
    if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
  }
  return valid;
}

/** A form body as Twilio posts it; null when the bytes are not UTF-8 text. */
export function parseTwilioForm(body: Uint8Array): URLSearchParams | null {
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
}

/** The first value of each name, for schema checks after the signature passed. */
export const formFields = (params: URLSearchParams): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const [name, value] of params) if (!(name in fields)) fields[name] = value;
  return fields;
};

/** T-5, T-6: the fields of a status callback this system reads; others pass unread. */
export const twilioStatusCallbackSchema = z.object({
  AccountSid: twilioAccountSidSchema,
  MessageSid: messageSidSchema,
  MessageStatus: z.string().transform((value) => value.toLowerCase()).pipe(z.string().regex(/^[a-z_]{1,40}$/)),
  ErrorCode: z.string().max(10).optional().transform((value) => (value ? value : null))
    .pipe(z.string().regex(/^[0-9]{1,10}$/).nullable()),
  To: z.string().min(1).max(64),
});
export type TwilioStatusCallback = z.infer<typeof twilioStatusCallbackSchema>;

/** T-6: the fields of an inbound text this system reads. */
export const twilioInboundSchema = z.object({
  AccountSid: twilioAccountSidSchema,
  MessageSid: messageSidSchema,
  From: z.string().min(1).max(64),
  To: z.string().min(1).max(64),
  Body: z.string().max(1600).default(""),
});
export type TwilioInbound = z.infer<typeof twilioInboundSchema>;

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (char) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[char]!);

/** T-8: the TwiML answer to an inbound text: one reply message, or none. */
export function twiml(reply: string | null): string {
  const head = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
  return reply === null ? `${head}<Response/>` : `${head}<Response><Message>${escapeXml(reply)}</Message></Response>`;
}
