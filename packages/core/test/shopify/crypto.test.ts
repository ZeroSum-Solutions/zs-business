import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openToken, parseSealKeys, sealToken, SealError } from "../../src/shopify/seal.js";
import { verifyIdToken, type IdTokenConfig } from "../../src/shopify/id-token.js";
import { verifyWebhookHmac } from "../../src/shopify/webhook.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("sealed Shopify tokens (C-22)", () => {
  const keys = parseSealKeys({ current: KEY_A, currentId: "k1" });
  it("opens what it sealed and never shows the token in the sealed text", () => {
    const sealed = sealToken(keys, { shopId: "gid://shopify/Shop/1", column: "access" }, "shpat_secret_value");
    expect(sealed.keyId).toBe("k1");
    expect(sealed.text).not.toContain("shpat_secret_value");
    expect(openToken(keys, { shopId: "gid://shopify/Shop/1", column: "access" }, sealed)).toBe("shpat_secret_value");
  });
  it("uses a fresh nonce per seal", () => {
    const a = sealToken(keys, { shopId: "gid://shopify/Shop/1", column: "access" }, "t");
    const b = sealToken(keys, { shopId: "gid://shopify/Shop/1", column: "access" }, "t");
    expect(a.text).not.toBe(b.text);
  });
  it("refuses a value copied to another shop or another column", () => {
    const sealed = sealToken(keys, { shopId: "gid://shopify/Shop/1", column: "access" }, "t");
    expect(() => openToken(keys, { shopId: "gid://shopify/Shop/2", column: "access" }, sealed)).toThrow(SealError);
    expect(() => openToken(keys, { shopId: "gid://shopify/Shop/1", column: "refresh" }, sealed)).toThrow(SealError);
  });
  it("refuses a flipped byte and a wrong key", () => {
    const sealed = sealToken(keys, { shopId: "s", column: "access" }, "token");
    const flipped = { ...sealed, text: sealed.text.slice(0, -2) + (sealed.text.endsWith("AA") ? "BB" : "AA") };
    expect(() => openToken(keys, { shopId: "s", column: "access" }, flipped)).toThrow(SealError);
    const other = parseSealKeys({ current: KEY_B, currentId: "k1" });
    expect(() => openToken(other, { shopId: "s", column: "access" }, sealed)).toThrow(SealError);
  });
  it("opens old rows during a rotation by key id", () => {
    const old = sealToken(keys, { shopId: "s", column: "refresh" }, "old-token");
    const rotated = parseSealKeys({ current: KEY_B, currentId: "k2", previous: KEY_A, previousId: "k1" });
    expect(openToken(rotated, { shopId: "s", column: "refresh" }, old)).toBe("old-token");
    expect(sealToken(rotated, { shopId: "s", column: "refresh" }, "n").keyId).toBe("k2");
  });
  it("rejects a key that is not 32 bytes or reuses an id", () => {
    expect(() => parseSealKeys({ current: Buffer.alloc(16).toString("base64"), currentId: "k1" })).toThrow();
    expect(() => parseSealKeys({ current: KEY_A, currentId: "k1", previous: KEY_B, previousId: "k1" })).toThrow();
  });
});

const SECRET = "s".repeat(40);
const CLIENT = "client123";
const NOW = new Date("2026-11-07T12:00:00Z");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(claims: Record<string, unknown>, opts: { secret?: string; alg?: string } = {}) {
  const header = b64({ alg: opts.alg ?? "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const good = (over: Record<string, unknown> = {}) => ({
  iss: "https://shop-a.myshopify.com/admin", dest: "https://shop-a.myshopify.com", aud: CLIENT, sub: "42",
  exp: Math.floor(NOW.getTime() / 1000) + 50, nbf: Math.floor(NOW.getTime() / 1000) - 5, iat: Math.floor(NOW.getTime() / 1000) - 5, jti: "j-1", sid: "sid", ...over,
});
const cfg: IdTokenConfig = { clientId: CLIENT, secrets: { current: SECRET }, now: () => NOW };

describe("ID token check (C-21, S3)", () => {
  it("accepts a good token and returns the shop and jti", () => {
    const out = verifyIdToken(cfg, token(good()));
    expect(out).toEqual({ ok: true, shopDomain: "shop-a.myshopify.com", jti: "j-1", expiresAt: new Date((Math.floor(NOW.getTime() / 1000) + 50) * 1000), userId: "42" });
  });
  it.each([
    ["wrong secret", token(good(), { secret: "x".repeat(40) })],
    ["alg none", token(good(), { alg: "none" })],
    ["alg HS512", token(good(), { alg: "HS512" })],
    ["wrong audience", token(good({ aud: "other" }))],
    ["expired", token(good({ exp: Math.floor(NOW.getTime() / 1000) - 11 }))],
    ["not yet valid", token(good({ nbf: Math.floor(NOW.getTime() / 1000) + 11 }))],
    ["host mismatch", token(good({ iss: "https://shop-b.myshopify.com/admin" }))],
    ["dest not myshopify", token(good({ dest: "https://evil.example.com", iss: "https://evil.example.com/admin" }))],
    ["dest with path", token(good({ dest: "https://shop-a.myshopify.com/x" }))],
    ["no sub", token(good({ sub: undefined }))],
    ["no jti", token(good({ jti: undefined }))],
    ["not a jwt", "abc"],
    ["four parts", `${token(good())}.x`],
  ])("refuses %s", (_name, value) => {
    expect(verifyIdToken(cfg, value).ok).toBe(false);
  });
  it("allows 10 seconds of skew and no more", () => {
    expect(verifyIdToken(cfg, token(good({ exp: Math.floor(NOW.getTime() / 1000) - 9 }))).ok).toBe(true);
    expect(verifyIdToken(cfg, token(good({ nbf: Math.floor(NOW.getTime() / 1000) + 9 }))).ok).toBe(true);
  });
  it("verifies against the previous secret during a rotation", () => {
    const both: IdTokenConfig = { ...cfg, secrets: { current: "n".repeat(40), previous: SECRET } };
    expect(verifyIdToken(both, token(good())).ok).toBe(true);
  });
  it("refuses an oversized token", () => {
    expect(verifyIdToken(cfg, token(good({ pad: "x".repeat(9000) }))).ok).toBe(false);
  });
});

describe("webhook HMAC (C-24, S8)", () => {
  const raw = Buffer.from('{"shop_domain":"shop-a.myshopify.com"}');
  const hmac = (secret = SECRET, body: Buffer = raw) => createHmac("sha256", secret).update(body).digest("base64");
  it("accepts the right tag on the raw bytes", () => {
    expect(verifyWebhookHmac({ current: SECRET }, raw, hmac())).toBe(true);
  });
  it("refuses wrong secret, changed body, missing, short and non-base64 headers", () => {
    expect(verifyWebhookHmac({ current: SECRET }, raw, hmac("y".repeat(40)))).toBe(false);
    expect(verifyWebhookHmac({ current: SECRET }, Buffer.from('{"shop_domain":"shop-b.myshopify.com"}'), hmac())).toBe(false);
    expect(verifyWebhookHmac({ current: SECRET }, raw, null)).toBe(false);
    expect(verifyWebhookHmac({ current: SECRET }, raw, "")).toBe(false);
    expect(verifyWebhookHmac({ current: SECRET }, raw, "abc")).toBe(false);
    expect(verifyWebhookHmac({ current: SECRET }, raw, hmac().replace(/.$/, "!"))).toBe(false);
  });
  it("accepts the previous secret during a rotation", () => {
    expect(verifyWebhookHmac({ current: "n".repeat(40), previous: SECRET }, raw, hmac())).toBe(true);
  });
});
