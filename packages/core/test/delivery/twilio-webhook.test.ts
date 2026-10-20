// M5 Twilio webhook verification (docs/requirements/twilio.md T-6, T-8). No database.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formFields,
  parseTwilioForm,
  signTwilioRequest,
  twiml,
  twilioInboundSchema,
  twilioStatusCallbackSchema,
  verifyTwilioSignature,
} from "../../src/index.js";

const TOKEN = randomBytes(16).toString("hex");
const PREVIOUS = randomBytes(16).toString("hex");
const URL = "https://api.example.test/webhooks/twilio/status/0d9c1c6e-4f0e-4c4e-9a36-1b7f43a1c0aa/7b2f6a1e-2d3c-4b5a-8c9d-0e1f2a3b4c5d";
const SID = `SM${"0a".repeat(16)}`;
const ACCOUNT = `AC${"1b".repeat(16)}`;
const form = (fields: Record<string, string>) => new URLSearchParams(fields);
const params = () => form({ MessageStatus: "delivered", AccountSid: ACCOUNT, MessageSid: SID, To: "+15555550123", ErrorCode: "" });

describe("X-Twilio-Signature (T-6)", () => {
  it("is base64 HMAC-SHA1 of the URL followed by each name and value, sorted by name", () => {
    // A fixed vector: HMAC-SHA1 keyed "5f"×16 over the URL, then AccountSid…ErrorCode (empty)…
    // MessageSid…MessageStatus…To in name order, computed independently of this module.
    expect(signTwilioRequest("5f".repeat(16), URL, params())).toBe("Ica+Msi1Jx/B8DAao+AU/kwRYkI=");
  });

  it("verifies with the current or previous token and nothing else", () => {
    const tokens = { current: TOKEN, previous: PREVIOUS };
    expect(verifyTwilioSignature({ tokens, url: URL, params: params(), signature: signTwilioRequest(TOKEN, URL, params()) })).toBe(true);
    expect(verifyTwilioSignature({ tokens, url: URL, params: params(), signature: signTwilioRequest(PREVIOUS, URL, params()) })).toBe(true);
    const other = randomBytes(16).toString("hex");
    expect(verifyTwilioSignature({ tokens, url: URL, params: params(), signature: signTwilioRequest(other, URL, params()) })).toBe(false);
    expect(verifyTwilioSignature({ tokens: { current: TOKEN }, url: URL, params: params(), signature: signTwilioRequest(PREVIOUS, URL, params()) })).toBe(false);
  });

  it("fails for another URL, a changed, added or removed field, and a missing or malformed header", () => {
    const tokens = { current: TOKEN };
    const signature = signTwilioRequest(TOKEN, URL, params());
    expect(verifyTwilioSignature({ tokens, url: URL.replace("api.example.test", "evil.example"), params: params(), signature })).toBe(false);
    const changed = params();
    changed.set("To", "+15555550999");
    expect(verifyTwilioSignature({ tokens, url: URL, params: changed, signature })).toBe(false);
    const added = params();
    added.append("Extra", "1");
    expect(verifyTwilioSignature({ tokens, url: URL, params: added, signature })).toBe(false);
    const removed = params();
    removed.delete("ErrorCode");
    expect(verifyTwilioSignature({ tokens, url: URL, params: removed, signature })).toBe(false);
    for (const bad of [undefined, "", "not base64!", "A".repeat(300), signature.slice(0, -4)])
      expect(verifyTwilioSignature({ tokens, url: URL, params: params(), signature: bad })).toBe(false);
  });

  it("does not depend on the order the fields arrived in, and signs repeated names in a fixed order", () => {
    const reordered = new URLSearchParams([...params().entries()].reverse());
    expect(signTwilioRequest(TOKEN, URL, reordered)).toBe(signTwilioRequest(TOKEN, URL, params()));
    const a = new URLSearchParams([["Media", "b"], ["Media", "a"]]);
    const b = new URLSearchParams([["Media", "a"], ["Media", "b"]]);
    expect(signTwilioRequest(TOKEN, URL, a)).toBe(signTwilioRequest(TOKEN, URL, b));
  });
});

describe("form bodies and schemas", () => {
  it("parses a UTF-8 form and refuses bytes that are not UTF-8", () => {
    const parsed = parseTwilioForm(new TextEncoder().encode("Body=Caf%C3%A9+STOP&From=%2B15555550123"));
    expect(parsed && formFields(parsed)).toEqual({ Body: "Café STOP", From: "+15555550123" });
    expect(parseTwilioForm(new Uint8Array([0x42, 0x3d, 0xff, 0xfe]))).toBeNull();
  });

  it("keeps the first value of a repeated field", () => {
    expect(formFields(new URLSearchParams("To=%2B1&To=%2B2"))).toEqual({ To: "+1" });
  });

  it("reads a status callback: lower-case status, empty error code as none", () => {
    expect(twilioStatusCallbackSchema.parse(formFields(params()))).toEqual({
      AccountSid: ACCOUNT, MessageSid: SID, MessageStatus: "delivered", ErrorCode: null, To: "+15555550123",
    });
    expect(twilioStatusCallbackSchema.parse({ ...formFields(params()), MessageStatus: "Undelivered", ErrorCode: "30007" }))
      .toMatchObject({ MessageStatus: "undelivered", ErrorCode: "30007" });
    for (const bad of [{ MessageSid: "SMshort" }, { MessageSid: `AC${"0a".repeat(16)}` }, { AccountSid: "AC1" },
      { MessageStatus: "sent; drop" }, { ErrorCode: "30007x" }])
      expect(twilioStatusCallbackSchema.safeParse({ ...formFields(params()), ...bad }).success).toBe(false);
  });

  it("reads an inbound text; a missing body is empty", () => {
    expect(twilioInboundSchema.parse({ AccountSid: ACCOUNT, MessageSid: SID, From: "+15555550123", To: "+15555550100" }))
      .toMatchObject({ Body: "" });
    expect(twilioInboundSchema.safeParse({ AccountSid: ACCOUNT, MessageSid: SID, From: "+1", To: "+1", Body: "x".repeat(1601) }).success).toBe(false);
  });
});

describe("TwiML (T-8)", () => {
  it("answers with no message, or one escaped message", () => {
    expect(twiml(null)).toBe("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
    expect(twiml("Halden & Rowe: <STOP> \"now\" 'ok'")).toBe(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Message>Halden &amp; Rowe: &lt;STOP&gt; &quot;now&quot; &apos;ok&apos;</Message></Response>");
  });
});
