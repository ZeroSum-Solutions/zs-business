// The outgoing message and its decoder (outreach-sequencer.md OS-17). Original code written from RFC 5322, RFC 2045
// and RFC 2047 in our own words. The builder writes CRLF lines and refuses any header value that could start another
// header; the decoder is what the fake Gmail and the tests read a sent message back with.

export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeError";
  }
}

const CRLF = "\r\n";
const BAD_HEADER_CHARACTER = /[\r\n\0]/;

function safe(name: string, value: string): string {
  if (BAD_HEADER_CHARACTER.test(value)) throw new MimeError(`${name} holds a line break or NUL`);
  return value;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** Longest chunk of UTF-8 bytes in one encoded word: 42 bytes make 56 base64 characters plus 12 of framing, under 75. */
const WORD_BYTES = 42;

/** RFC 2047 encoded words (UTF-8, B encoding), cut at character boundaries, joined by a fold. ASCII passes through. */
export function encodeHeaderText(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > WORD_BYTES) {
      words.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

/** Folds a long header at spaces so no line passes 78 characters; a value with its own folds is kept as is. */
function header(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78 || value.includes(CRLF)) return line;
  const parts = line.split(" ");
  const lines: string[] = [];
  let current = parts[0]!;
  for (const part of parts.slice(1)) {
    if (current.length + 1 + part.length > 78) {
      lines.push(current);
      current = part;
    } else current += ` ${part}`;
  }
  lines.push(current);
  return lines.join(`${CRLF} `);
}

/** Quoted-printable (RFC 2045) of UTF-8 text: lines of at most 76 characters, hard breaks as CRLF. */
export function encodeQuotedPrintable(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\n").split("\n").map((line) => {
    const bytes = Buffer.from(line, "utf8");
    const tokens: string[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      const last = index === bytes.length - 1;
      if ((byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last)) tokens.push(String.fromCharCode(byte));
      else tokens.push(`=${byte.toString(16).toUpperCase().padStart(2, "0")}`);
    }
    const lines: string[] = [];
    let current = "";
    for (const token of tokens) {
      if (current.length + token.length > 75) {
        lines.push(`${current}=`);
        current = "";
      }
      current += token;
    }
    lines.push(current);
    return lines.join(CRLF);
  }).join(CRLF);
}

export function decodeQuotedPrintable(text: string): string {
  const joined = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index]!;
    if (character === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(...Buffer.from(character, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface RawMessageInput {
  readonly fromName: string;
  readonly fromAddress: string;
  readonly to: string;
  readonly subject: string;
  /** Plain text with `\n` line ends; the footer is already in it. */
  readonly body: string;
  /** From the injected clock. */
  readonly date: Date;
  /** The `outreach_sends.id`, written as `X-Zs-Ref` so a probe can find the message (OS-16). */
  readonly sendId: string;
  readonly unsubscribeUrl: string;
  /** Steps 2 and later: the previous step's Message-ID, and every earlier step's in order. */
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}

const ADDRESS = /^[^\s<>,;"@]+@[^\s<>,;"@]+$/;
function address(name: string, value: string): string {
  if (BAD_HEADER_CHARACTER.test(value) || !ADDRESS.test(value)) throw new MimeError(`${name} is not a plain address`);
  return value;
}
function messageId(value: string): string {
  safe("Message-ID", value);
  const bare = value.trim().replace(/^<|>$/g, "");
  if (bare === "" || /[\s<>]/.test(bare)) throw new MimeError("Message-ID is not a message id");
  return `<${bare}>`;
}

/** OS-17: the RFC 5322 message, base64url without padding (what `messages.send` takes as `raw`). */
export function buildRawMessage(input: RawMessageInput): string {
  safe("display name", input.fromName);
  if (/["<>\\]/.test(input.fromName) || input.fromName.trim() === "") throw new MimeError("display name holds a character a From header cannot carry");
  const from = PRINTABLE_ASCII.test(input.fromName) ? `"${input.fromName}"` : encodeHeaderText(input.fromName);
  safe("subject", input.subject);
  safe("unsubscribe URL", input.unsubscribeUrl);
  if (!/^https?:\/\/[^\s<>]+$/.test(input.unsubscribeUrl)) throw new MimeError("The unsubscribe URL is not a URL");
  safe("send id", input.sendId);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(input.sendId)) throw new MimeError("The send id is not a plain id");
  if (Number.isNaN(input.date.getTime())) throw new MimeError("The message date is not a date");
  const lines = [
    header("From", `${from} <${address("from address", input.fromAddress)}>`),
    header("To", address("recipient", input.to)),
    header("Subject", encodeHeaderText(input.subject)),
    `Date: ${input.date.toUTCString().replace(/ GMT$/, " +0000")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    `List-Unsubscribe: <${input.unsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    `X-Zs-Ref: ${input.sendId}`,
  ];
  if (input.inReplyTo !== undefined) {
    lines.push(header("In-Reply-To", messageId(input.inReplyTo)));
    lines.push(header("References", (input.references ?? [input.inReplyTo]).map(messageId).join(" ")));
  } else if (input.references !== undefined && input.references.length > 0) throw new MimeError("References need In-Reply-To");
  const message = `${lines.join(CRLF)}${CRLF}${CRLF}${encodeQuotedPrintable(input.body)}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

// The decoder.

export interface ParsedMessage {
  /** Lower-case name to the first value, unfolded and decoded. */
  readonly headers: Readonly<Record<string, string>>;
  readonly headerList: ReadonlyArray<readonly [string, string]>;
  /** The decoded body with `\n` line ends. */
  readonly body: string;
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
/** Decodes RFC 2047 words; whitespace between two encoded words is dropped. */
export function decodeHeaderText(value: string): string {
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1");
  return joined.replace(ENCODED_WORD, (_word, _charset: string, encoding: string, text: string) => {
    if (encoding.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf8");
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "_") bytes.push(32);
      else if (text[index] === "=") {
        bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
        index += 2;
      } else bytes.push(text.charCodeAt(index));
    }
    return Buffer.from(bytes).toString("utf8");
  });
}

/** Reads a `raw` value (base64url) back into headers and a decoded body. */
export function parseRawMessage(raw: string): ParsedMessage {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf(`${CRLF}${CRLF}`);
  const head = split < 0 ? text : text.slice(0, split);
  const rest = split < 0 ? "" : text.slice(split + 4);
  const unfolded = head.replace(/\r\n[ \t]+/g, " ").split(CRLF);
  const headerList: Array<readonly [string, string]> = [];
  const headers: Record<string, string> = {};
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    const value = decodeHeaderText(line.slice(colon + 1).trim());
    headerList.push([name, value]);
    headers[name.toLowerCase()] ??= value;
  }
  const encoding = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
  const body = (encoding === "quoted-printable" ? decodeQuotedPrintable(rest) : rest).replace(/\r\n/g, "\n");
  return { headers, headerList, body };
}
