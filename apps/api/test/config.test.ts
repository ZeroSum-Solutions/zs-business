import { describe, expect, it } from "vitest";
import { parseServerEnv, PLACEHOLDER_JWT_SECRET } from "../src/config.js";
import { SECRET } from "./helpers.js";

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

  const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const hosted = "postgres://zs_runtime.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

  it("reads the CA and pool size for a hosted database", () => {
    expect(parseServerEnv({ ...base, DATABASE_URL: hosted, DATABASE_CA_CERT: ca, DATABASE_POOL_MAX: "3" }))
      .toMatchObject({ databaseCaCert: ca, databasePoolMax: 3 });
  });

  // pg lets URL options replace the ssl config; percent-encoded names count too.
  it.each(["?sslmode=disable", "?%73slmode=disable", "?%73slmode=no-verify", "?ssl=0", "?application_name=x"])(
    "refuses a URL query string (%s) when DATABASE_CA_CERT is set", (query) => {
      expect(() => parseServerEnv({ ...base, DATABASE_URL: hosted + query, DATABASE_CA_CERT: ca })).toThrow(/query string/);
    });

  it("keeps plain TCP for a loopback database without a CA", () => {
    for (const url of [base.DATABASE_URL, "postgres://zs_runtime@localhost:55432/zs_dev", "postgres://zs_runtime@[::1]:55432/zs_dev",
      "postgres://zs_runtime@127.0.0.1:55432/zs_dev?application_name=dev"])
      expect(parseServerEnv({ ...base, DATABASE_URL: url })).toMatchObject({ databaseUrl: url, databaseCaCert: undefined });
  });

  // Unset CA used to mean plain TCP to any host, and ?sslmode=no-verify meant no certificate check.
  it.each(["", "?sslmode=no-verify", "?sslmode=disable", "?ssl=false"])(
    "refuses a non-loopback URL without DATABASE_CA_CERT (%s)", (query) => {
      expect(() => parseServerEnv({ ...base, DATABASE_URL: hosted + query })).toThrow(/DATABASE_CA_CERT: is required/);
    });

  it("refuses a query string that moves a loopback URL to another host, even without a CA", () => {
    expect(() => parseServerEnv({ ...base, DATABASE_URL: `${base.DATABASE_URL}?host=db.example.com` }))
      .toThrow(/DATABASE_CA_CERT: is required.*DATABASE_URL: must not carry a query string/);
  });

  it("treats a URL with no host as remote: pg would fall back to PGHOST", () => {
    expect(() => parseServerEnv({ ...base, DATABASE_URL: "postgres:///zs_dev" })).toThrow(/DATABASE_CA_CERT: is required/);
  });

  it("never echoes the database password in its errors", () => {
    let message = "";
    try {
      parseServerEnv({ ...base, DATABASE_URL: `${hosted}?sslmode=disable` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain("pw@");
  });
});
