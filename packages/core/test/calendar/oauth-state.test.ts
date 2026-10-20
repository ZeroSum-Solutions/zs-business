// G-1, G-2, G-8: the signed OAuth state, the derived PKCE verifier and the channel token.
// Secrets are generated at runtime.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  browserBindingFor,
  browserKeyMatches,
  channelToken,
  CONNECT_STATE_LIFETIME_MS,
  pkceChallenge,
  pkceVerifier,
  signConnectState,
  verifyChannelToken,
  verifyConnectState,
  type OAuthState,
} from "../../src/index.js";

const NOW = Date.parse("2026-10-20T09:00:00.000Z");
const secret = () => randomBytes(32).toString("hex");
const browserKey = () => randomBytes(32).toString("base64url");
const state = (over: Partial<OAuthState> = {}): OAuthState => ({
  tenantId: randomUUID(), actorId: randomUUID(), resourceId: randomUUID(), connectionId: randomUUID(),
  browserBinding: browserBindingFor(browserKey()), expiresAt: NOW + CONNECT_STATE_LIFETIME_MS, ...over,
});
const at = (ms: number) => new Date(ms);

describe("the OAuth state (G-1, G-2)", () => {
  it("signs and verifies, lower-casing the IDs", () => {
    const key = secret();
    const input = state({ tenantId: randomUUID().toUpperCase() });
    const token = signConnectState(key, input);
    expect(token).toMatch(/^zgs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThanOrEqual(600);
    expect(verifyConnectState({ current: key }, token, at(NOW))).toEqual({ ...input, tenantId: input.tenantId.toLowerCase() });
  });

  it("verifies through a rotation with the previous secret, and not with an unknown one", () => {
    const [old, next] = [secret(), secret()];
    const input = state();
    const token = signConnectState(old, input);
    expect(verifyConnectState({ current: next, previous: old }, token, at(NOW))).toEqual(input);
    expect(verifyConnectState({ current: next }, token, at(NOW))).toBeNull();
    expect(verifyConnectState({ current: next, previous: secret() }, token, at(NOW))).toBeNull();
    expect(verifyConnectState({ current: old, previous: undefined }, token, at(NOW))).toEqual(input);
  });

  it("is valid up to the millisecond before expiry, not at it", () => {
    const key = secret();
    const input = state({ expiresAt: NOW + 1000 });
    const token = signConnectState(key, input);
    expect(verifyConnectState({ current: key }, token, at(NOW + 999))).toEqual(input);
    expect(verifyConnectState({ current: key }, token, at(NOW + 1000))).toBeNull();
    expect(verifyConnectState({ current: key }, token, at(NOW + 1001))).toBeNull();
  });

  it("refuses any change to the body or the tag, including non-canonical spellings of the tag", () => {
    const key = secret();
    const token = signConnectState(key, state());
    const [prefix, body, tag] = token.split(".") as [string, string, string];
    const swap = (text: string, index: number) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      return [...alphabet].filter((char) => char !== text[index]).map((char) => `${text.slice(0, index)}${char}${text.slice(index + 1)}`);
    };
    for (const index of [0, Math.floor(body.length / 2), body.length - 1])
      for (const changed of swap(body, index).slice(0, 8)) expect(verifyConnectState({ current: key }, `${prefix}.${changed}.${tag}`, at(NOW))).toBeNull();
    // Every other last character: some decode to the same 32 bytes (the low bits are padding).
    for (const changed of swap(tag, 42)) expect(verifyConnectState({ current: key }, `${prefix}.${body}.${changed}`, at(NOW)), changed).toBeNull();
    for (const changed of swap(tag, 0).slice(0, 8)) expect(verifyConnectState({ current: key }, `${prefix}.${body}.${changed}`, at(NOW))).toBeNull();
  });

  it("refuses a validly signed body that is not four lower-case UUIDs, a browser binding and a safe integer", () => {
    const key = secret();
    const forge = (fields: unknown) => {
      const body = Buffer.from(typeof fields === "string" ? fields : JSON.stringify(fields)).toString("base64url");
      return `zgs1.${body}.${createHmac("sha256", key).update(`zgs1.${body}`).digest().toString("base64url")}`;
    };
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const binding = browserBindingFor(browserKey());
    expect(verifyConnectState({ current: key }, forge([...ids, binding, NOW + 1000]), at(NOW))).not.toBeNull();
    const bad: unknown[] = [
      [...ids, NOW + 1000],
      [...ids, binding],
      [...ids, binding, NOW + 1000, "extra"],
      [...ids.slice(0, 3), "not-a-uuid", binding, NOW + 1000],
      [ids[0]!.toUpperCase(), ...ids.slice(1), binding, NOW + 1000],
      [...ids.slice(0, 3), 7, binding, NOW + 1000],
      [...ids, binding.slice(1), NOW + 1000],
      [...ids, `${binding.slice(0, 42)}+`, NOW + 1000],
      [...ids, null, NOW + 1000],
      [...ids, binding, String(NOW + 1000)],
      [...ids, binding, NOW + 1000.5],
      [...ids, binding, Number.MAX_SAFE_INTEGER + 2],
      { tenantId: ids[0] },
      "not json",
      "null",
    ];
    for (const fields of bad) expect(verifyConnectState({ current: key }, forge(fields), at(NOW)), JSON.stringify(fields)).toBeNull();
  });

  it("refuses malformed tokens", () => {
    const key = secret();
    const token = signConnectState(key, state());
    const [, body, tag] = token.split(".") as [string, string, string];
    const malformed = [
      "",
      "zgs1.",
      body,
      `zgs2.${body}.${tag}`,
      `zgs1.${body}`,
      `zgs1.${body}.${tag}.x`,
      `zgs1.${body}.${tag.slice(1)}`,
      `zgs1.${body}.${tag}A`,
      `zgs1.${body}=.${tag}`,
      `zgs1..${tag}`,
      `zgs1.${body}.${"+".repeat(43)}`,
      `zgs1.${"A".repeat(600)}.${tag}`,
      ` ${token}`,
    ];
    for (const value of malformed) expect(verifyConnectState({ current: key }, value, at(NOW)), value.slice(0, 30)).toBeNull();
  });
});

describe("the browser binding (G-1, G-2)", () => {
  it("matches only the key the binding was made from, in constant time, and never a missing or malformed key", () => {
    const key = browserKey();
    const bound = state({ browserBinding: browserBindingFor(key) });
    expect(bound.browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bound.browserBinding).toBe(createHash("sha256").update(key).digest("base64url"));
    expect(browserKeyMatches(bound, key)).toBe(true);
    // The binding is in the (readable) state; it is not the key.
    for (const given of [undefined, "", bound.browserBinding, browserKey(), key.slice(1), `${key}A`, `${key.slice(0, 42)}é`, ` ${key.slice(1)}`, key.toUpperCase()])
      expect(browserKeyMatches(bound, given), String(given)).toBe(given === key);
  });
});

describe("PKCE (G-1)", () => {
  it("derives a stable RFC 7636 verifier per secret and connection, and the S256 challenge", () => {
    const key = secret();
    const connection = randomUUID();
    const verifier = pkceVerifier(key, connection);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(verifier).toHaveLength(43);
    expect(pkceVerifier(key, connection)).toBe(verifier);
    expect(pkceVerifier(key, connection.toUpperCase())).toBe(verifier);
    expect(pkceVerifier(key, randomUUID())).not.toBe(verifier);
    expect(pkceVerifier(secret(), connection)).not.toBe(verifier);
    const challenge = pkceChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  });

  it("matches the RFC 7636 appendix B example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("the channel token (G-8)", () => {
  it("verifies its own channel's token only", () => {
    const key = secret();
    const channel = randomUUID();
    const token = channelToken(key, channel);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(channelToken(key, channel.toUpperCase())).toBe(token);
    expect(verifyChannelToken(key, channel, token)).toBe(true);
    expect(verifyChannelToken(key, randomUUID(), token)).toBe(false);
    expect(verifyChannelToken(secret(), channel, token)).toBe(false);
  });

  it("refuses missing, malformed and non-ASCII tokens and non-UUID channels without throwing", () => {
    const key = secret();
    const channel = randomUUID();
    const token = channelToken(key, channel);
    for (const given of [undefined, "", token.slice(1), `${token}A`, `${token.slice(0, 42)}${token[42] === "A" ? "B" : "A"}`, `${token.slice(0, 42)}é`, `${token.slice(0, 41)}é`])
      expect(verifyChannelToken(key, channel, given), String(given)).toBe(false);
    expect(verifyChannelToken(key, channel.toUpperCase(), token)).toBe(false);
    expect(verifyChannelToken(key, "channel-1", channelToken(key, "channel-1"))).toBe(false);
  });
});
