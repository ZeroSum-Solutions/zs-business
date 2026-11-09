import { describe, expect, it } from "vitest";
import { buildRawMessage, decodeQuotedPrintable, encodeQuotedPrintable, MimeError, parseRawMessage, type RawMessageInput } from "../../src/outreach/mime.js";

const base: RawMessageInput = {
  fromName: "Sam Sender", fromAddress: "sam@sender.example", to: "pat@acme.example", subject: "Quick idea for Acme",
  body: "Hi Pat,\n\nA short note.\n\n--\nSender Co\n1 Example Way\nTo stop these emails: https://hub.example/u/tok  (or reply \"stop\")\n",
  date: new Date("2026-11-09T16:05:00.000Z"), sendId: "0b5f6f7e-1d6b-4a52-9b8a-0a7d5a1c9e11", unsubscribeUrl: "https://hub.example/u/tok",
};
const text = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("buildRawMessage (OS-17)", () => {
  it("writes a step 1 message with CRLF lines and the headers in order", () => {
    const raw = buildRawMessage(base);
    expect(raw).not.toMatch(/[=+/]/);
    const whole = text(raw);
    const head = whole.slice(0, whole.indexOf("\r\n\r\n"));
    const body = whole.slice(whole.indexOf("\r\n\r\n") + 4);
    expect(head.split("\r\n")).toEqual([
      'From: "Sam Sender" <sam@sender.example>',
      "To: pat@acme.example",
      "Subject: Quick idea for Acme",
      "Date: Mon, 09 Nov 2026 16:05:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "List-Unsubscribe: <https://hub.example/u/tok>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "X-Zs-Ref: 0b5f6f7e-1d6b-4a52-9b8a-0a7d5a1c9e11",
    ]);
    expect(body).toContain("Hi Pat,\r\n\r\nA short note.");
    expect(text(raw)).not.toMatch(/[^\r]\n/);
    const parsed = parseRawMessage(raw);
    expect(parsed.body).toBe(base.body);
    expect(parsed.headers["in-reply-to"]).toBeUndefined();
  });

  it("writes a step 3 message that replies in the thread with every earlier Message-ID in order", () => {
    const raw = buildRawMessage({
      ...base, subject: "Re: Quick idea for Acme", body: "Third note.\n",
      inReplyTo: "<m2@mail.example>", references: ["<m1@mail.example>", "m2@mail.example"],
    });
    const [head] = text(raw).split("\r\n\r\n");
    expect(head!.split("\r\n").slice(2, 3)).toEqual(["Subject: Re: Quick idea for Acme"]);
    expect(head).toContain("\r\nIn-Reply-To: <m2@mail.example>\r\nReferences: <m1@mail.example> <m2@mail.example>");
    expect(head!.split("\r\n").at(-1)).toBe("References: <m1@mail.example> <m2@mail.example>");
  });

  it("folds a long References header under the line limit", () => {
    const ids = Array.from({ length: 12 }, (_, n) => `<message-number-${n}-with-a-long-id@mail.example>`);
    const raw = buildRawMessage({ ...base, inReplyTo: ids.at(-1)!, references: ids });
    for (const line of text(raw).split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(parseRawMessage(raw).headers.references).toBe(ids.join(" "));
    expect(text(raw).split("\r\n\r\n")[0]!.split("\r\n").every((line) => line.length <= 78)).toBe(true);
  });

  it("encodes a non-ASCII subject and display name and reads them back", () => {
    const subject = "Idée rapide pour Café Müller — 日本語のご案内 and a rather long tail to force more than one encoded word";
    const raw = buildRawMessage({ ...base, subject, fromName: "Zoë Müller" });
    const head = text(raw).split("\r\n\r\n")[0]!;
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(head.split("\r\n").every((line) => line.length <= 78)).toBe(true);
    const parsed = parseRawMessage(raw);
    expect(parsed.headers.subject).toBe(subject);
    expect(parsed.headers.from).toBe("Zoë Müller <sam@sender.example>");
  });

  it("encodes the body as quoted-printable and round-trips non-ASCII text, long lines and trailing spaces", () => {
    const body = `Café ${"é".repeat(60)} = sign\nline with trailing space \nlast ${"word ".repeat(40)}\n`;
    const encoded = encodeQuotedPrintable(body);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).not.toMatch(/[^\x20-\x7e\r\n]/);
    expect(decodeQuotedPrintable(encoded).replace(/\r\n/g, "\n")).toBe(body);
    expect(parseRawMessage(buildRawMessage({ ...base, body })).body).toBe(body);
  });

  it("refuses a header injection in every field", () => {
    const attempts: Array<[string, Partial<RawMessageInput>]> = [
      ["from name", { fromName: "Sam\r\nBcc: x@y.z" }],
      ["from name quote", { fromName: 'Sam"' }],
      ["from name angle", { fromName: "Sam <x@y.z>" }],
      ["from name lf", { fromName: "Sam\nX" }],
      ["from address", { fromAddress: "a@b.c\r\nBcc: x@y.z" }],
      ["from address space", { fromAddress: "a b@c.d" }],
      ["recipient", { to: "pat@acme.example\r\nBcc: x@y.z" }],
      ["recipient list", { to: "a@b.c, d@e.f" }],
      ["recipient nul", { to: "a\0@b.c" }],
      ["subject", { subject: "Hello\r\nBcc: x@y.z" }],
      ["subject lf", { subject: "Hello\nBcc: x@y.z" }],
      ["subject nul", { subject: "Hello\0" }],
      ["unsubscribe url", { unsubscribeUrl: "https://hub.example/u/t\r\nBcc: x@y.z" }],
      ["unsubscribe url scheme", { unsubscribeUrl: "javascript:alert(1)" }],
      ["send id", { sendId: "abc\r\nBcc: x" }],
      ["in-reply-to", { inReplyTo: "<a@b.c>\r\nBcc: x@y.z" }],
      ["references", { inReplyTo: "<a@b.c>", references: ["<a@b.c>", "<d@e.f>\nBcc: x@y.z"] }],
    ];
    for (const [label, change] of attempts) expect(() => buildRawMessage({ ...base, ...change }), label).toThrow(MimeError);
  });

  it("refuses references without in-reply-to and an invalid date", () => {
    expect(() => buildRawMessage({ ...base, references: ["<a@b.c>"] })).toThrow(MimeError);
    expect(() => buildRawMessage({ ...base, date: new Date(Number.NaN) })).toThrow(MimeError);
  });

  it("decodes Q-encoded words and ignores the space between adjacent encoded words", () => {
    const raw = Buffer.from("Subject: =?UTF-8?Q?Caf=C3=A9_au_lait?=\r\n =?UTF-8?B?4pyT?=\r\nX-Other: plain\r\n\r\nbody", "utf8").toString("base64url");
    const parsed = parseRawMessage(raw);
    expect(parsed.headers.subject).toBe("Café au lait✓");
    expect(parsed.headers["x-other"]).toBe("plain");
    expect(parsed.body).toBe("body");
  });
});
