import { describe, expect, it } from "vitest";
import { parseServerEnv, PLACEHOLDER_BOOKING_KEY_SECRET, PLACEHOLDER_JWT_SECRET } from "../src/config.js";
import { KEY_SECRET, PREVIOUS_KEY_SECRET, SECRET } from "./helpers.js";

const base = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", JWT_SECRET: SECRET };

describe("parseServerEnv", () => {
  it("refuses the .env.example placeholder secret", () => {
    expect(() => parseServerEnv({ ...base, JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(/placeholder/);
  });

  it("defaults to a one-hour token lifetime, a one-minute clock skew and no issuer", () => {
    expect(parseServerEnv(base)).toMatchObject({
      jwtMaxLifetimeSeconds: 3600, jwtClockSkewSeconds: 60, jwtIssuer: undefined, port: 8787,
    });
  });

  it("reads JWT_CLOCK_SKEW_SECONDS and refuses values outside 0 to 300", () => {
    expect(parseServerEnv({ ...base, JWT_CLOCK_SKEW_SECONDS: "0" })).toMatchObject({ jwtClockSkewSeconds: 0 });
    for (const value of ["-1", "301", "abc"])
      expect(() => parseServerEnv({ ...base, JWT_CLOCK_SKEW_SECONDS: value })).toThrow(/JWT_CLOCK_SKEW_SECONDS/);
  });

  it("lets local dev raise the lifetime and set an issuer", () => {
    expect(parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: "604800", JWT_ISSUER: "https://example.supabase.co/auth/v1" }))
      .toMatchObject({ jwtMaxLifetimeSeconds: 604800, jwtIssuer: "https://example.supabase.co/auth/v1" });
  });

  it.each(["0", "abc", String(31 * 24 * 3600)])("refuses JWT_MAX_TTL_SECONDS=%s", (value) => {
    expect(() => parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: value })).toThrow(/JWT_MAX_TTL_SECONDS/);
  });

  it("keeps the public booking routes off until a key secret is set", () => {
    expect(parseServerEnv(base).publicIntake).toBeNull();
    expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: PREVIOUS_KEY_SECRET })).toThrow(/needs PUBLIC_BOOKING_KEY_SECRET/);
  });

  it("reads the public booking settings with safe defaults", () => {
    expect(parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PORT: "8798" }).publicIntake).toEqual({
      keySecrets: { current: KEY_SECRET }, publicBaseUrl: "http://localhost:8798", trustProxy: false, limitOverrides: {},
    });
    expect(parseServerEnv({
      ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: PREVIOUS_KEY_SECRET,
      PUBLIC_BASE_URL: "https://book.example.com/", TRUST_PROXY: "1", PUBLIC_RATE_ADDRESS_WRITES: "5",
    }).publicIntake).toEqual({
      keySecrets: { current: KEY_SECRET, previous: PREVIOUS_KEY_SECRET },
      publicBaseUrl: "https://book.example.com", trustProxy: true, limitOverrides: { addressWrites: 5 },
    });
  });

  it("refuses a short or placeholder booking key secret and a non-http base URL", () => {
    for (const secret of ["short", PLACEHOLDER_BOOKING_KEY_SECRET])
      expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: secret })).toThrow(/PUBLIC_BOOKING_KEY_SECRET/);
    expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BASE_URL: "javascript:alert(1)" }))
      .toThrow(/PUBLIC_BASE_URL/);
    expect(() => parseServerEnv({ ...base, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
  });
});
