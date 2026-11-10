// Manage tokens (docs/requirements/booking-self-service.md BS-1): round trip, tamper, secrets, expiry, canonical form.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manageTokenSchema } from "@zs/contracts";
import { manageExpiry, signManageToken, verifyManageToken } from "../../src/booking/manage-token.js";

const SECRET = "s".repeat(40);
const OTHER = "t".repeat(40);
const ref = () => ({ tenantId: randomUUID(), bookingId: randomUUID(), expiresAt: 1_800_000_000 });

describe("manage tokens (BS-1)", () => {
  it("round-trips the tenant, the booking and the expiry, in the shape the contract names", () => {
    const given = ref();
    const token = signManageToken(SECRET, given);
    expect(token).toMatch(/^zsm1_[A-Za-z0-9_-]{70}$/);
    expect(manageTokenSchema.safeParse(token).success).toBe(true);
    expect(verifyManageToken({ current: SECRET }, token)).toEqual(given);
  });

  it("signs the same bytes for upper-case IDs", () => {
    const given = ref();
    expect(signManageToken(SECRET, { ...given, tenantId: given.tenantId.toUpperCase(), bookingId: given.bookingId.toUpperCase() }))
      .toBe(signManageToken(SECRET, given));
  });

  it("refuses a token signed by another secret, and accepts the previous one only to verify", () => {
    const token = signManageToken(OTHER, ref());
    expect(verifyManageToken({ current: SECRET }, token)).toBeNull();
    expect(verifyManageToken({ current: SECRET, previous: OTHER }, token)).not.toBeNull();
    expect(verifyManageToken({ current: SECRET, previous: undefined }, token)).toBeNull();
  });

  it("refuses every single-character change and a swapped booking or tenant", () => {
    const given = ref();
    const token = signManageToken(SECRET, given);
    const body = token.slice(5);
    for (let i = 0; i < body.length; i += 1) {
      const flipped = body[i] === "A" ? "B" : "A";
      expect(verifyManageToken({ current: SECRET }, `zsm1_${body.slice(0, i)}${flipped}${body.slice(i + 1)}`), `char ${i}`).toBeNull();
    }
    // A booking ID from another tenant's token, put under this tenant: the tag no longer fits.
    const foreign = signManageToken(SECRET, { ...ref(), tenantId: randomUUID() });
    const spliced = `zsm1_${body.slice(0, 22)}${foreign.slice(5 + 22, 5 + 43)}${body.slice(43)}`;
    expect(verifyManageToken({ current: SECRET }, spliced)).toBeNull();
  });

  it("refuses malformed text without throwing", () => {
    for (const text of ["", "zsm1_", "zsm1_abc", `zsm1_${"A".repeat(70)}`, `zsm2_${"A".repeat(70)}`, `zsm1_${"A".repeat(71)}`, "zsm1_" + "!".repeat(70), "x".repeat(10_000)])
      expect(verifyManageToken({ current: SECRET }, text), text.slice(0, 20)).toBeNull();
  });

  it("refuses a non-canonical encoding of a valid token", () => {
    const token = signManageToken(SECRET, ref());
    // The last base64url character carries two unused bits; a different final character with the same bytes must not verify.
    const last = token.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alias = alphabet[(alphabet.indexOf(last) + 1) % 64]!;
    expect(verifyManageToken({ current: SECRET }, token.slice(0, -1) + alias)).toBeNull();
  });

  it("dies at the booking's start, rounded up to a whole second", () => {
    expect(manageExpiry("2026-11-02T09:00:00.000Z")).toBe(Date.parse("2026-11-02T09:00:00.000Z") / 1000);
    expect(manageExpiry(new Date("2026-11-02T09:00:00.001Z"))).toBe(Date.parse("2026-11-02T09:00:00.000Z") / 1000 + 1);
  });

  it("refuses an expiry outside four bytes", () => {
    expect(() => signManageToken(SECRET, { ...ref(), expiresAt: -1 })).toThrow(RangeError);
    expect(() => signManageToken(SECRET, { ...ref(), expiresAt: 2 ** 32 })).toThrow(RangeError);
    expect(() => signManageToken(SECRET, { ...ref(), expiresAt: 1.5 })).toThrow(RangeError);
  });
});
