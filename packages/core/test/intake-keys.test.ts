import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBookingKey, verifyBookingKey } from "../src/index.js";

// Synthetic secrets built at runtime so scanners do not flag literals.
const CURRENT = ["unit", "current", "c".repeat(32)].join("-");
const PREVIOUS = ["unit", "previous", "p".repeat(32)].join("-");

describe("public booking keys (public-intake.md P-2)", () => {
  const ref = { tenantId: randomUUID(), pageId: randomUUID() };

  it("round-trips the tenant and page in a fixed 69-character key", () => {
    const key = signBookingKey(CURRENT, ref);
    expect(key).toMatch(/^zsb1_[A-Za-z0-9_-]{64}$/);
    expect(verifyBookingKey({ current: CURRENT }, key)).toEqual(ref);
    expect(signBookingKey(CURRENT, { tenantId: ref.tenantId.toUpperCase(), pageId: ref.pageId })).toBe(key);
  });

  it("verifies with the previous secret only while it is configured", () => {
    const old = signBookingKey(PREVIOUS, ref);
    expect(verifyBookingKey({ current: CURRENT, previous: PREVIOUS }, old)).toEqual(ref);
    expect(verifyBookingKey({ current: CURRENT }, old)).toBeNull();
  });

  it("refuses tampered, truncated and non-canonical keys", () => {
    const key = signBookingKey(CURRENT, ref);
    const body = Buffer.from(key.slice(5), "base64url");
    const swapped = Buffer.from(body);
    swapped.set(Buffer.from(randomUUID().replaceAll("-", ""), "hex"), 16);
    for (const bad of [
      "", "zsb1_", key.slice(0, -1), `${key}A`, key.replace("zsb1_", "zsb2_"),
      `zsb1_${swapped.toString("base64url")}`,
      key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"),
      key.slice(0, -1) + (key.endsWith("w") ? "x" : "w"),
    ]) expect(verifyBookingKey({ current: CURRENT }, bad), bad).toBeNull();
  });
});
