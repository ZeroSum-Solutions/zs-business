// activepieces.md W-5, W-6, W-9: derived secrets, Standard Webhooks signatures and tokens.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signAutomationToken,
  signingSecrets,
  signWebhookBody,
  verifyAutomationToken,
  verifyResendWebhook,
  webhookSignatureHeader,
  webhookSigningSecret,
} from "../../src/index.js";
import { KEY, OTHER_KEY } from "./helpers.js";

const tenantId = randomUUID();
const endpointId = randomUUID();

describe("webhook signing secrets (W-5)", () => {
  it("derives one whsec_ secret per tenant, endpoint and version, and nothing else changes it", () => {
    const secret = webhookSigningSecret(KEY, tenantId, endpointId, 1);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(webhookSigningSecret(KEY, tenantId.toUpperCase(), endpointId, 1)).toBe(secret);
    expect(webhookSigningSecret(KEY, tenantId, endpointId, 2)).not.toBe(secret);
    expect(webhookSigningSecret(KEY, randomUUID(), endpointId, 1)).not.toBe(secret);
    expect(webhookSigningSecret(KEY, tenantId, randomUUID(), 1)).not.toBe(secret);
    expect(webhookSigningSecret(OTHER_KEY, tenantId, endpointId, 1)).not.toBe(secret);
  });

  it("signs the way an independent Standard Webhooks verifier checks", () => {
    const secret = webhookSigningSecret(KEY, tenantId, endpointId, 1);
    const body = JSON.stringify({ id: "evt_1", type: "lead.created", data: { name: "Rowan" } });
    const now = new Date("2026-10-19T08:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const header = webhookSignatureHeader([secret], "evt_1", timestamp, body);
    const check = (signature: string, raw = body) => verifyResendWebhook({
      secrets: { current: secret }, headers: { id: "evt_1", timestamp: String(timestamp), signature }, body: Buffer.from(raw), now,
    });
    expect(check(header)).toMatchObject({ ok: true, id: "evt_1" });
    expect(check(header, `${body} `)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(check(signWebhookBody(webhookSigningSecret(KEY, tenantId, endpointId, 2), "evt_1", timestamp, body)))
      .toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("signs with the previous version and the previous key while they still count (W-5, W-6)", () => {
    const one = signingSecrets({ current: KEY }, tenantId, endpointId, { secretVersion: 2, previousVersion: null });
    expect(one).toEqual([webhookSigningSecret(KEY, tenantId, endpointId, 2)]);
    const both = signingSecrets({ current: KEY, previous: OTHER_KEY }, tenantId, endpointId, { secretVersion: 2, previousVersion: 1 });
    expect(both).toHaveLength(4);
    expect(both).toContain(webhookSigningSecret(OTHER_KEY, tenantId, endpointId, 1));
    const header = webhookSignatureHeader(both, "evt_2", 1_000, "{}");
    expect(header.split(" ")).toHaveLength(4);
    for (const secret of both)
      expect(verifyResendWebhook({
        secrets: { current: secret }, headers: { id: "evt_2", timestamp: "1000", signature: header }, body: Buffer.from("{}"),
        now: new Date(1_000_000),
      }).ok).toBe(true);
  });
});

describe("automation tokens (W-9)", () => {
  const tokenId = randomUUID();

  it("round-trips the tenant and token, and verifies under the previous key during a rotation", () => {
    const token = signAutomationToken(KEY, { tenantId, tokenId });
    expect(token).toMatch(/^zsap1_[A-Za-z0-9_-]{86}$/);
    expect(verifyAutomationToken({ current: KEY }, token)).toEqual({ tenantId, tokenId });
    expect(verifyAutomationToken({ current: OTHER_KEY }, token)).toBeNull();
    expect(verifyAutomationToken({ current: OTHER_KEY, previous: KEY }, token)).toEqual({ tenantId, tokenId });
  });

  it("refuses a token whose tenant or token was swapped, or that is malformed", () => {
    const token = signAutomationToken(KEY, { tenantId, tokenId });
    const bytes = Buffer.from(token.slice(6), "base64url");
    const swapped = Buffer.concat([Buffer.from(randomUUID().replaceAll("-", ""), "hex"), bytes.subarray(16)]);
    expect(verifyAutomationToken({ current: KEY }, `zsap1_${swapped.toString("base64url")}`)).toBeNull();
    for (const bad of ["", "zsap1_", token.slice(0, -1), `${token}A`, token.replace("zsap1_", "zsap2_"), token.toUpperCase()])
      expect(verifyAutomationToken({ current: KEY }, bad)).toBeNull();
  });
});
