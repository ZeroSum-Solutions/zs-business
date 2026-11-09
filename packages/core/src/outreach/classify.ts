// Inbound classification (outreach-sequencer.md OS-19). Pure: it reads headers and labels Gmail's metadata gave and the
// facts the worker already holds, and answers what the message is and which prospect it belongs to. No body is read.

/** What `gmail.metadata` lets the worker see of one message. Header names are lower-case. */
export interface InboundMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

export interface ClassifyContext {
  /** The mailbox's own address, lower case. */
  readonly mailboxAddress: string;
  /** Gmail ids of the messages this system sent from this mailbox: those are never inbound. */
  readonly ownMessageIds: ReadonlySet<string>;
  /** Gmail thread id to the prospect whose step 1 started it. */
  readonly prospectByThread: ReadonlyMap<string, string>;
  /** Lower-case prospect address to prospect id, for this mailbox's prospects. */
  readonly prospectByAddress: ReadonlyMap<string, string>;
}

export type InboundKind = "bounce" | "auto_reply" | "owner_reply" | "reply";
export type Classification =
  | { readonly kind: "own" }
  | { readonly kind: "unmatched" }
  | { readonly kind: InboundKind; readonly prospectId: string };

/** Every address in a header value such as `Name <a@b.c>, d@e.f`, lower case. */
export function addressesIn(value: string | undefined): string[] {
  if (!value) return [];
  // A linear tokenizer, not a regular expression: header values come from the sender (CodeQL js/polynomial-redos).
  const found: string[] = [];
  for (const raw of value.split(/[\s,;"()]/)) {
    let token = raw;
    const open = token.lastIndexOf("<");
    if (open !== -1) token = token.slice(open + 1);
    if (token.endsWith(">")) token = token.slice(0, -1);
    const at = token.indexOf("@");
    if (at <= 0 || at === token.length - 1 || token.includes("<") || token.includes(">")) continue;
    found.push(token.toLowerCase());
  }
  return found;
}

const localPart = (address: string) => address.slice(0, address.lastIndexOf("@"));

/** A MIME `Content-Type`: the lower-case media type and its parameters, with quoted values unquoted (RFC 2045 section 5.1). */
export function parseContentType(value: string | undefined): { readonly type: string; readonly params: ReadonlyMap<string, string> } {
  const params = new Map<string, string>();
  const text = value ?? "";
  let index = 0;
  const readUntilSemicolon = (): string => {
    let out = "";
    let quoted = false;
    while (index < text.length) {
      const character = text[index]!;
      if (quoted) {
        if (character === "\\" && index + 1 < text.length) { out += text[index + 1]; index += 2; continue; }
        if (character === '"') quoted = false;
        else out += character;
      } else if (character === '"') quoted = true;
      else if (character === ";") break;
      else out += character;
      index += 1;
    }
    index += 1; // the semicolon
    return out;
  };
  const type = readUntilSemicolon().trim().toLowerCase();
  while (index < text.length) {
    const rawName = text.slice(index);
    const equals = rawName.indexOf("=");
    const semicolon = rawName.indexOf(";");
    if (equals === -1 || (semicolon !== -1 && semicolon < equals)) { readUntilSemicolon(); continue; }
    const name = rawName.slice(0, equals).trim().toLowerCase();
    index += equals + 1;
    const parameter = readUntilSemicolon().trim();
    if (name !== "" && !params.has(name)) params.set(name, parameter);
  }
  return { type, params };
}

/** OS-19: a bounce comes from a mail system, names failed recipients, or is a delivery-status report. */
export function isBounce(headers: Readonly<Record<string, string>>): boolean {
  const from = addressesIn(headers.from)[0];
  if (from !== undefined && ["mailer-daemon", "postmaster"].includes(localPart(from))) return true;
  if ((headers["x-failed-recipients"] ?? "").trim() !== "") return true;
  const contentType = parseContentType(headers["content-type"]);
  return contentType.type === "multipart/report" && (contentType.params.get("report-type") ?? "").trim().toLowerCase() === "delivery-status";
}

/** OS-19: `Auto-Submitted` present and not `no` marks an automatic reply (out-of-office). */
export function isAutoReply(headers: Readonly<Record<string, string>>): boolean {
  const value = headers["auto-submitted"];
  return value !== undefined && value.trim().toLowerCase() !== "no";
}

export function classifyInbound(message: InboundMessage, context: ClassifyContext): Classification {
  if (context.ownMessageIds.has(message.id)) return { kind: "own" };
  const headers = message.headers;
  const inThread = context.prospectByThread.get(message.threadId);
  const sender = addressesIn(headers.from)[0];
  const bySender = sender === undefined ? undefined : context.prospectByAddress.get(sender);

  if (isBounce(headers)) {
    // The prospect is the one whose thread it joined, else the one `X-Failed-Recipients` names.
    const named = addressesIn(headers["x-failed-recipients"]).map((address) => context.prospectByAddress.get(address)).find((id) => id !== undefined);
    const prospectId = inThread ?? named;
    return prospectId === undefined ? { kind: "unmatched" } : { kind: "bounce", prospectId };
  }
  const prospectId = inThread ?? bySender;
  if (prospectId === undefined) return { kind: "unmatched" };
  if (isAutoReply(headers)) return { kind: "auto_reply", prospectId };
  // The owner answering from this mailbox inside a prospect's thread took the conversation over.
  if (inThread !== undefined && message.labelIds.includes("SENT")) return { kind: "owner_reply", prospectId };
  return { kind: "reply", prospectId };
}
