// G-2: the grant the OAuth callback stages for the owner to confirm. Secrets and keys are
// generated at runtime.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { PENDING_GRANT_PATTERN } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import {
  browserBindingFor,
  generateSealKeyPair,
  MAX_PENDING_GRANT_LENGTH,
  parseSealPublicKey,
  PENDING_GRANT_LIFETIME_MS,
  sealRefreshToken,
  signConnectState,
  signPendingGrant,
  verifyPendingGrant,
  type PendingGrant,
} from "../../src/index.js";

const NOW = Date.parse("2026-10-20T09:00:00.000Z");
const secret = () => randomBytes(32).toString("hex");
const publicKey = parseSealPublicKey(generateSealKeyPair().publicKey);
const grant = (over: Partial<PendingGrant> = {}): PendingGrant => {
  const tenantId = randomUUID();
  const connectionId = randomUUID();
  return {
    tenantId, actorId: randomUUID(), resourceId: randomUUID(), connectionId, accountEmail: "owner@calendar.test",
    scope: "openid email https://www.googleapis.com/auth/calendar.events",
    refreshTokenSealed: sealRefreshToken(publicKey, { tenantId, connectionId }, "1//refresh"), expiresAt: NOW + PENDING_GRANT_LIFETIME_MS, ...over,
  };
};
const at = (ms: number) => new Date(ms);
/** Re-sign a body the way the signer does, to test what verification makes of its fields. */
const signedBody = (key: string, fields: unknown) => {
  const body = Buffer.from(JSON.stringify(fields)).toString("base64url");
  return `zgg1.${body}.${createHmac("sha256", key).update(`zgg1.${body}`).digest("base64url")}`;
};

describe("a staged grant (G-2)", () => {
  it("signs and verifies, lower-casing the IDs, in a form that fits a cookie", () => {
    const key = secret();
    const input = grant({ tenantId: randomUUID().toUpperCase() });
    const token = signPendingGrant(key, input)!;
    expect(token).toMatch(PENDING_GRANT_PATTERN);
    expect(token.length).toBeLessThanOrEqual(MAX_PENDING_GRANT_LENGTH);
    expect(verifyPendingGrant({ current: key }, token, at(NOW))).toEqual({ ...input, tenantId: input.tenantId.toLowerCase() });
    expect(verifyPendingGrant({ current: key }, signPendingGrant(key, grant({ accountEmail: null }))!, at(NOW))?.accountEmail).toBeNull();
  });

  it("verifies through a rotation, and refuses an unknown secret, a changed byte and an expired grant", () => {
    const [old, next] = [secret(), secret()];
    const token = signPendingGrant(old, grant())!;
    expect(verifyPendingGrant({ current: next, previous: old }, token, at(NOW))).not.toBeNull();
    expect(verifyPendingGrant({ current: next }, token, at(NOW))).toBeNull();
    const [, body, tag] = token.split(".");
    const flipped = (text: string, index: number) => text.slice(0, index) + (text[index] === "A" ? "B" : "A") + text.slice(index + 1);
    expect(verifyPendingGrant({ current: old }, `zgg1.${flipped(body!, 5)}.${tag}`, at(NOW))).toBeNull();
    expect(verifyPendingGrant({ current: old }, `zgg1.${body}.${flipped(tag!, 3)}`, at(NOW))).toBeNull();
    expect(verifyPendingGrant({ current: old }, token, at(NOW + PENDING_GRANT_LIFETIME_MS - 1))).not.toBeNull();
    expect(verifyPendingGrant({ current: old }, token, at(NOW + PENDING_GRANT_LIFETIME_MS))).toBeNull();
    for (const bad of [undefined, "", "zgg1.", "zgg1.a.b", `${token}.x`, token.replace("zgg1.", "zgs1."), "x".repeat(MAX_PENDING_GRANT_LENGTH + 1)])
      expect(verifyPendingGrant({ current: old }, bad, at(NOW))).toBeNull();
  });

  it("never reads a signed OAuth state as a grant, though both use the state secret", () => {
    const key = secret();
    const state = signConnectState(key, {
      tenantId: randomUUID(), actorId: randomUUID(), resourceId: randomUUID(), connectionId: randomUUID(),
      browserBinding: browserBindingFor(randomBytes(32).toString("base64url")), expiresAt: NOW + 60_000,
    });
    expect(verifyPendingGrant({ current: key }, state.replace("zgs1.", "zgg1."), at(NOW))).toBeNull();
  });

  it("refuses a well-signed body whose fields the connect action would not take", () => {
    const key = secret();
    const g = grant();
    const fields = [g.tenantId, g.actorId, g.resourceId, g.connectionId, g.accountEmail, g.scope, g.refreshTokenSealed, g.expiresAt];
    expect(verifyPendingGrant({ current: key }, signedBody(key, fields), at(NOW))).not.toBeNull();
    const changed = (index: number, value: unknown) => fields.map((field, i) => (i === index ? value : field));
    for (const bad of [
      fields.slice(0, 7), [...fields, "extra"], { ...fields }, changed(0, "not-a-uuid"), changed(3, 7), changed(4, "x"),
      changed(6, "1//plain-token"), changed(7, String(g.expiresAt)), changed(7, 1.5),
    ]) expect(verifyPendingGrant({ current: key }, signedBody(key, bad), at(NOW))).toBeNull();
  });

  it("refuses to sign a grant too long for a cookie; the longest it signs still matches the contract", () => {
    const key = secret();
    expect(signPendingGrant(key, grant({ scope: "s".repeat(MAX_PENDING_GRANT_LENGTH) }))).toBeNull();
    const base = signPendingGrant(key, grant({ scope: "" }))!;
    // JSON of plain letters grows the base64url body by four characters per three letters.
    const longest = signPendingGrant(key, grant({ scope: "s".repeat(Math.floor((MAX_PENDING_GRANT_LENGTH - base.length) / 4) * 3) }))!;
    expect(longest.length).toBeGreaterThan(MAX_PENDING_GRANT_LENGTH - 4);
    expect(longest).toMatch(PENDING_GRANT_PATTERN);
  });
});
