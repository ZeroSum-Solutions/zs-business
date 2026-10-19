import { describe, expect, it } from "vitest";
import { parseServerEnv, PLACEHOLDER_JWT_SECRET } from "../src/config.js";
import { SECRET } from "./helpers.js";

const DATABASE_URL = "postgres://zs_runtime@127.0.0.1:55432/zs_dev";
const base = { DATABASE_URL, JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
const JWKS_URL = "https://abcd.supabase.co/auth/v1/.well-known/jwks.json";

describe("parseServerEnv", () => {
  it("requires an explicit JWT_VERIFIER: hs256 or jwks", () => {
    expect(() => parseServerEnv({ DATABASE_URL, JWT_SECRET: SECRET })).toThrow(/JWT_VERIFIER: JWT_VERIFIER must be hs256 or jwks/);
    for (const value of ["", "HS256", "es256", "auto"])
      expect(() => parseServerEnv({ ...base, JWT_VERIFIER: value })).toThrow(/JWT_VERIFIER/);
  });

  it("reports every invalid variable at once", () => {
    expect(() => parseServerEnv({ JWT_VERIFIER: "hs256" })).toThrow(/DATABASE_URL.*JWT_SECRET is required/);
  });

  it("hs256 requires a real JWT_SECRET", () => {
    expect(() => parseServerEnv({ DATABASE_URL, JWT_VERIFIER: "hs256" })).toThrow(/JWT_SECRET is required when JWT_VERIFIER=hs256/);
    expect(() => parseServerEnv({ ...base, JWT_SECRET: "too-short" })).toThrow(/at least 32 characters/);
    expect(() => parseServerEnv({ ...base, JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(/placeholder/);
    expect(parseServerEnv(base).jwt).toMatchObject({ method: "hs256", secret: SECRET });
  });

  it("jwks requires JWT_JWKS_URL, not JWT_SECRET", () => {
    expect(() => parseServerEnv({ DATABASE_URL, JWT_VERIFIER: "jwks" })).toThrow(/JWT_JWKS_URL is required when JWT_VERIFIER=jwks/);
    expect(parseServerEnv({ DATABASE_URL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: JWKS_URL }).jwt).toEqual({
      method: "jwks", jwksUrl: JWKS_URL, issuer: undefined, maxLifetimeSeconds: 3600, clockSkewSeconds: 60,
    });
  });

  it("jwks refuses plain http except on loopback", () => {
    expect(() => parseServerEnv({ DATABASE_URL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: JWKS_URL.replace("https:", "http:") }))
      .toThrow(/JWT_JWKS_URL must use https/);
    expect(parseServerEnv({ DATABASE_URL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json" }).jwt)
      .toMatchObject({ method: "jwks" });
  });

  it("defaults to a one-hour token lifetime, a one-minute clock skew and no issuer", () => {
    expect(parseServerEnv(base)).toMatchObject({
      jwt: { maxLifetimeSeconds: 3600, clockSkewSeconds: 60, issuer: undefined }, port: 8787,
    });
  });

  it("reads JWT_CLOCK_SKEW_SECONDS and refuses values outside 0 to 300", () => {
    expect(parseServerEnv({ ...base, JWT_CLOCK_SKEW_SECONDS: "0" })).toMatchObject({ jwt: { clockSkewSeconds: 0 } });
    for (const value of ["-1", "301", "abc"])
      expect(() => parseServerEnv({ ...base, JWT_CLOCK_SKEW_SECONDS: value })).toThrow(/JWT_CLOCK_SKEW_SECONDS/);
  });

  it("lets local dev raise the lifetime and set an issuer", () => {
    expect(parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: "604800", JWT_ISSUER: "https://example.supabase.co/auth/v1" }))
      .toMatchObject({ jwt: { maxLifetimeSeconds: 604800, issuer: "https://example.supabase.co/auth/v1" } });
  });

  it.each(["0", "abc", String(31 * 24 * 3600)])("refuses JWT_MAX_TTL_SECONDS=%s", (value) => {
    expect(() => parseServerEnv({ ...base, JWT_MAX_TTL_SECONDS: value })).toThrow(/JWT_MAX_TTL_SECONDS/);
  });
});
