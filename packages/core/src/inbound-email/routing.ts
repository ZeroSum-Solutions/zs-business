// Inbound email, slice 1 (docs/requirements/inbound-email.md IE-3, IE-4, IE-8, IE-12). The signed
// `email.received` event, and pure routing over its recipients: which hub handles it names, and in
// which order. Nothing here touches a database; the session looks each handle up. Original code.
import {
  contactEmailInputSchema,
  INBOUND_FROM_LIMIT,
  INBOUND_LOCAL_PART_PATTERN,
  INBOUND_RECIPIENT_LIMIT,
  INBOUND_SUBJECT_LIMIT,
  providerEmailIdSchema,
} from "@zs/contracts";
import { z } from "zod";

/** Only this event is read (IE-8); every other signed event is acknowledged and ignored. */
export const INBOUND_EMAIL_EVENT_TYPE = "email.received";

// No per-entry length: the 256 KiB body bounds them, and an odd entry past the 50 read, or in
// received_for (counted only), must not make the whole event unreadable.
const recipientsSchema = z.array(z.string()).max(1000).nullish().transform((list) => list ?? []);

/**
 * The fields of Resend's `email.received` this slice reads. Other fields (attachments, message ID,
 * headers) are ignored: the body and headers are the content worker's (slice 2). A field that is
 * present but not of the documented type makes the event unreadable (`malformed_event`, 400).
 */
export const inboundEmailEventSchema = z.object({
  type: z.literal(INBOUND_EMAIL_EVENT_TYPE),
  data: z.object({
    email_id: providerEmailIdSchema,
    // Required but otherwise free: the session reads it after routing (IE-4, IE-8).
    from: z.string(),
    // Resend always sends `to` (it may be empty); an event without it is unreadable, not unrouted (IE-8).
    to: z.array(z.string()).max(1000),
    cc: recipientsSchema,
    bcc: recipientsSchema,
    received_for: recipientsSchema,
    // Any length: IE-12 cuts it to 200, and the body limit bounds it.
    subject: z.string().nullish(),
  }),
});
export type InboundEmailEvent = z.infer<typeof inboundEmailEventSchema>;

/** One kept hub recipient: its handle and the reply reference after `+`, if any. */
export interface RoutedRecipient {
  readonly handle: string;
  readonly replyRef: string | null;
}

export interface RecipientRouting {
  /** Hub recipients in `to`, `cc`, `bcc` order (then as listed), at most 50 entries read. */
  readonly recipients: readonly RoutedRecipient[];
  /** Hub-domain entries of `received_for` that routing did not use; counted, never logged (IE-3). */
  readonly receivedForUnrouted: number;
}

/** The address inside `Name <address>`, else the whole entry; trimmed. */
export function addressOf(entry: string): string {
  const match = /<([^<>]*)>\s*$/.exec(entry);
  return (match ? match[1]! : entry).trim();
}

function splitAddress(entry: string): { local: string; domain: string } | null {
  const address = addressOf(entry).toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * IE-3: keeps `to`, `cc` and `bcc` entries (50 together) at the hub domain, in lower case, whose
 * local part is a handle and an optional reply reference. `received_for` never routes.
 */
export function routeRecipients(event: InboundEmailEvent, domain: string): RecipientRouting {
  const hub = domain.toLowerCase();
  const read = [...event.data.to, ...event.data.cc, ...event.data.bcc].slice(0, INBOUND_RECIPIENT_LIMIT);
  const recipients: RoutedRecipient[] = [];
  for (const entry of read) {
    const parts = splitAddress(entry);
    if (!parts || parts.domain !== hub) continue;
    const local = INBOUND_LOCAL_PART_PATTERN.exec(parts.local);
    if (!local) continue;
    recipients.push({ handle: local[1]!, replyRef: local[2] ?? null });
  }
  // An address that also arrived in to, cc or bcc was not dropped: count only the ones routing never saw.
  const seen = new Set(read.map((entry) => addressOf(entry).toLowerCase()));
  const receivedForUnrouted = new Set(event.data.received_for
    .map((entry) => addressOf(entry).toLowerCase())
    .filter((address) => splitAddress(address)?.domain === hub && !seen.has(address))).size;
  return { recipients, receivedForUnrouted };
}

/**
 * IE-3: several kept recipients that route to one tenant collapse to one. The first with a reply
 * reference wins, in the order given; with none, the first. So a redelivery builds the same payload.
 */
export function collapseByTenant<T extends { readonly tenantId: string; readonly recipient: RoutedRecipient }>(
  routed: readonly T[],
): T[] {
  const chosen = new Map<string, T>();
  for (const route of routed) {
    const held = chosen.get(route.tenantId);
    if (!held || (held.recipient.replyRef === null && route.recipient.replyRef !== null)) chosen.set(route.tenantId, route);
  }
  return [...chosen.values()];
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Cuts to at most `limit` UTF-16 units without splitting a character; a lone surrogate becomes U+FFFD. */
function cut(text: string, limit: number): string {
  let out = "";
  for (const char of text.replace(LONE_SURROGATE, "\uFFFD")) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  return out;
}

// C0 and C1 control characters and NUL (Postgres text refuses NUL, and [[:cntrl:]] in the from_address check
// matches C1 too); line breaks become spaces first. Bidirectional overrides and isolates go as well, so a
// subject or sender cannot reorder what the inbox shows.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/**
 * IE-9, IE-19: the sender address, normalised as contacts are when it parses; otherwise trimmed,
 * lower-cased, without control characters, cut to 320. Null when nothing is left.
 */
export function senderAddress(from: string): string | null {
  const address = addressOf(from).replace(CONTROL, "");
  const parsed = contactEmailInputSchema.safeParse(address);
  if (parsed.success) return parsed.data;
  const fallback = cut(address.trim().toLowerCase(), INBOUND_FROM_LIMIT);
  return fallback.length > 0 ? fallback : null;
}

/** IE-12: one line of at most 200 characters; null when the message had none, or nothing is left. */
export function inboundSubject(subject: string | null | undefined): string | null {
  if (subject === null || subject === undefined) return null;
  const line = cut(subject.replace(/[\r\n\u2028\u2029]+/g, " ").replace(CONTROL, ""), INBOUND_SUBJECT_LIMIT);
  return line.length > 0 ? line : null;
}
