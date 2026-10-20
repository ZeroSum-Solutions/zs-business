import { describe, expect, it } from "vitest";
import { parseServerEnv, PLACEHOLDER_BOOKING_KEY_SECRET, PLACEHOLDER_JWT_SECRET, PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET } from "../src/config.js";
import { KEY_SECRET, PREVIOUS_KEY_SECRET, PREVIOUS_UNSUBSCRIBE_SECRET, SECRET, UNSUBSCRIBE_SECRET } from "./helpers.js";

const LOCAL = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub" };
const base = { ...LOCAL, JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
const JWKS_URL = "https://abcd.supabase.co/auth/v1/.well-known/jwks.json";

describe("parseServerEnv", () => {
  it("requires an explicit JWT_VERIFIER: hs256 or jwks", () => {
    expect(() => parseServerEnv({ ...LOCAL, JWT_SECRET: SECRET })).toThrow(/JWT_VERIFIER: JWT_VERIFIER must be hs256 or jwks/);
    for (const value of ["", "HS256", "es256", "auto"])
      expect(() => parseServerEnv({ ...base, JWT_VERIFIER: value })).toThrow(/JWT_VERIFIER/);
  });

  it("reports every invalid variable at once", () => {
    expect(() => parseServerEnv({ JWT_VERIFIER: "hs256" })).toThrow(/DATABASE_URL.*JWT_SECRET is required.*SESSION_CHECK/);
  });

  it("hs256 requires a real JWT_SECRET", () => {
    expect(() => parseServerEnv({ ...LOCAL, JWT_VERIFIER: "hs256" })).toThrow(/JWT_SECRET is required when JWT_VERIFIER=hs256/);
    expect(() => parseServerEnv({ ...base, JWT_SECRET: "too-short" })).toThrow(/at least 32 characters/);
    expect(() => parseServerEnv({ ...base, JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(/placeholder/);
    expect(parseServerEnv(base).jwt).toMatchObject({ method: "hs256", secret: SECRET });
  });

  it("jwks requires JWT_JWKS_URL, not JWT_SECRET", () => {
    expect(() => parseServerEnv({ ...LOCAL, JWT_VERIFIER: "jwks" })).toThrow(/JWT_JWKS_URL is required when JWT_VERIFIER=jwks/);
    expect(parseServerEnv({ ...LOCAL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: JWKS_URL }).jwt).toEqual({
      method: "jwks", jwksUrl: JWKS_URL, issuer: undefined, maxLifetimeSeconds: 3600, clockSkewSeconds: 60,
    });
  });

  it("jwks refuses plain http except on loopback", () => {
    expect(() => parseServerEnv({ ...LOCAL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: JWKS_URL.replace("https:", "http:") }))
      .toThrow(/JWT_JWKS_URL must use https/);
    expect(parseServerEnv({ ...LOCAL, JWT_VERIFIER: "jwks", JWT_JWKS_URL: "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json" }).jwt)
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

  it("keeps the public booking routes off until a key secret is set", () => {
    expect(parseServerEnv(base).publicIntake).toBeNull();
    expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: PREVIOUS_KEY_SECRET })).toThrow(/needs PUBLIC_BOOKING_KEY_SECRET/);
  });

  it("reads the public booking settings with safe defaults", () => {
    expect(parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PORT: "8798" }).publicIntake).toEqual({
      keySecrets: { current: KEY_SECRET }, publicBaseUrl: "http://localhost:8798", clientIp: {}, limitOverrides: {},
    });
    expect(parseServerEnv({
      ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: PREVIOUS_KEY_SECRET,
      PUBLIC_BASE_URL: "https://book.example.com/", PUBLIC_CLIENT_IP_HEADER: "x-vercel-forwarded-for", PUBLIC_RATE_ADDRESS_WRITES: "5",
    }).publicIntake).toEqual({
      keySecrets: { current: KEY_SECRET, previous: PREVIOUS_KEY_SECRET },
      publicBaseUrl: "https://book.example.com", clientIp: { header: "x-vercel-forwarded-for" }, limitOverrides: { addressWrites: 5 },
    });
  });

  it("refuses a short or placeholder booking key secret and a non-http base URL", () => {
    for (const secret of ["short", PLACEHOLDER_BOOKING_KEY_SECRET])
      expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: secret })).toThrow(/PUBLIC_BOOKING_KEY_SECRET/);
    expect(() => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BASE_URL: "javascript:alert(1)" }))
      .toThrow(/PUBLIC_BASE_URL/);
  });

  it("keeps the unsubscribe routes off until a token secret is set", () => {
    expect(parseServerEnv(base).unsubscribe).toBeNull();
    // The booking secret does not turn them on, and theirs does not turn booking on.
    expect(parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET }).unsubscribe).toBeNull();
    expect(parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET }).publicIntake).toBeNull();
    expect(() => parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: PREVIOUS_UNSUBSCRIBE_SECRET }))
      .toThrow(/needs UNSUBSCRIBE_TOKEN_SECRET/);
  });

  it("reads the unsubscribe settings, sharing the client address source and address limits", () => {
    expect(parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET }).unsubscribe).toEqual({
      tokenSecrets: { current: UNSUBSCRIBE_SECRET }, clientIp: {}, limitOverrides: {},
    });
    expect(parseServerEnv({
      ...base, UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET, UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: PREVIOUS_UNSUBSCRIBE_SECRET,
      PUBLIC_CLIENT_IP_HEADER: "x-vercel-forwarded-for", PUBLIC_RATE_ADDRESS_READS: "50", PUBLIC_RATE_TENANT_WRITES: "9",
    }).unsubscribe).toEqual({
      tokenSecrets: { current: UNSUBSCRIBE_SECRET, previous: PREVIOUS_UNSUBSCRIBE_SECRET },
      clientIp: { header: "x-vercel-forwarded-for" }, limitOverrides: { addressReads: 50 },
    });
    expect(() => parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET, PUBLIC_TRUSTED_PROXIES: "proxy.internal" }))
      .toThrow(/PUBLIC_TRUSTED_PROXIES/);
  });

  it("refuses a short or placeholder unsubscribe token secret", () => {
    for (const secret of ["short", PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET]) {
      expect(() => parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_SECRET: secret })).toThrow(/UNSUBSCRIBE_TOKEN_SECRET/);
      expect(() => parseServerEnv({ ...base, UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET, UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: secret }))
        .toThrow(/UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET/);
    }
  });

  it("takes the client address source from explicit settings only", () => {
    const intake = (env: Record<string, string>) => parseServerEnv({ ...base, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, ...env }).publicIntake;
    expect(intake({ PUBLIC_TRUSTED_PROXIES: "10.0.0.0/8, fd00::/8,192.0.2.1" })?.clientIp)
      .toEqual({ trustedProxies: ["10.0.0.0/8", "fd00::/8", "192.0.2.1"] });
    // Any header a caller can set itself would let it pick its own bucket.
    expect(() => intake({ PUBLIC_CLIENT_IP_HEADER: "x-forwarded-for" })).toThrow(/PUBLIC_CLIENT_IP_HEADER/);
    expect(() => intake({ PUBLIC_TRUSTED_PROXIES: "10.0.0.0/33" })).toThrow(/PUBLIC_TRUSTED_PROXIES/);
    expect(() => intake({ PUBLIC_TRUSTED_PROXIES: "proxy.internal" })).toThrow(/PUBLIC_TRUSTED_PROXIES/);
    expect(() => intake({ PUBLIC_CLIENT_IP_HEADER: "x-real-ip", PUBLIC_TRUSTED_PROXIES: "10.0.0.0/8" })).toThrow(/not both/);
    // The old switch must not be ignored quietly.
    for (const value of ["1", "yes"]) expect(() => intake({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY was replaced/);
    expect(intake({ TRUST_PROXY: "0" })?.clientIp).toEqual({});
  });

  it("requires an explicit SESSION_CHECK: supabase or local-stub", () => {
    const { SESSION_CHECK: _check, ...noCheck } = base;
    expect(() => parseServerEnv(noCheck)).toThrow(/SESSION_CHECK must be supabase or local-stub/);
    expect(() => parseServerEnv({ ...base, SESSION_CHECK: "database" })).toThrow(/SESSION_CHECK/);
  });

  it("supabase needs SUPABASE_URL over https and the anon key, and caches live answers 5 seconds by default", () => {
    const supabase = { ...base, SESSION_CHECK: "supabase" };
    expect(() => parseServerEnv(supabase)).toThrow(/SUPABASE_URL is required.*SUPABASE_ANON_KEY is required/);
    expect(() => parseServerEnv({ ...supabase, SUPABASE_URL: "http://abcd.supabase.co", SUPABASE_ANON_KEY: "anon" }))
      .toThrow(/SUPABASE_URL must use https/);
    expect(parseServerEnv({ ...supabase, SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_ANON_KEY: "anon" }).sessionCheck)
      .toEqual({ method: "supabase", supabaseUrl: "https://abcd.supabase.co", anonKey: "anon", cacheSeconds: 5 });
    for (const value of ["-1", "31", "abc"])
      expect(() => parseServerEnv({ ...supabase, SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_ANON_KEY: "anon", SESSION_CACHE_SECONDS: value }))
        .toThrow(/SESSION_CACHE_SECONDS/);
  });

  it("allows the local auth stub only with a loopback database", () => {
    expect(parseServerEnv(base).sessionCheck).toEqual({ method: "local-stub" });
    for (const DATABASE_URL of ["postgres://zs_runtime.abcd@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      "postgres://zs_runtime@127.0.0.1:55432/zs_dev?host=db.example.com"])
      expect(() => parseServerEnv({ ...base, DATABASE_URL })).toThrow(/SESSION_CHECK=local-stub needs a loopback DATABASE_URL/);
  });

  // Hosted databases need the Supabase session check: the local stub is loopback only.
  const remote = { ...base, SESSION_CHECK: "supabase", SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_ANON_KEY: "anon" };
  const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const hosted = "postgres://zs_runtime.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

  // P-10: per-process counters would let every serverless instance grant the full limit.
  it("counts public limits in Postgres by default, and in memory only on a loopback database", () => {
    const intake = (env: Record<string, string>) => parseServerEnv({ ...remote, PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, ...env });
    expect(intake({ DATABASE_URL: hosted, DATABASE_CA_CERT: ca }).rateLimitStore).toBe("postgres");
    expect(intake({ PUBLIC_RATE_LIMIT_STORE: "memory" }).rateLimitStore).toBe("memory");
    expect(() => intake({ DATABASE_URL: hosted, DATABASE_CA_CERT: ca, PUBLIC_RATE_LIMIT_STORE: "memory" }))
      .toThrow(/PUBLIC_RATE_LIMIT_STORE: memory needs a loopback DATABASE_URL/);
    for (const value of ["", "redis", "Postgres"]) expect(() => intake({ PUBLIC_RATE_LIMIT_STORE: value })).toThrow(/PUBLIC_RATE_LIMIT_STORE/);
  });

  it("reads the CA and pool size for a hosted database", () => {
    expect(parseServerEnv({ ...remote, DATABASE_URL: hosted, DATABASE_CA_CERT: ca, DATABASE_POOL_MAX: "3" }))
      .toMatchObject({ databaseCaCert: ca, databasePoolMax: 3 });
  });

  // pg lets URL options replace the ssl config; percent-encoded names count too.
  it.each(["?sslmode=disable", "?%73slmode=disable", "?%73slmode=no-verify", "?ssl=0", "?application_name=x"])(
    "refuses a URL query string (%s) when DATABASE_CA_CERT is set", (query) => {
      expect(() => parseServerEnv({ ...remote, DATABASE_URL: hosted + query, DATABASE_CA_CERT: ca })).toThrow(/query string/);
    });

  it("keeps plain TCP for a loopback database without a CA", () => {
    for (const url of [remote.DATABASE_URL, "postgres://zs_runtime@localhost:55432/zs_dev", "postgres://zs_runtime@[::1]:55432/zs_dev",
      "postgres://zs_runtime@127.0.0.1:55432/zs_dev?application_name=dev"])
      expect(parseServerEnv({ ...remote, DATABASE_URL: url })).toMatchObject({ databaseUrl: url, databaseCaCert: undefined });
  });

  // Unset CA used to mean plain TCP to any host, and ?sslmode=no-verify meant no certificate check.
  it.each(["", "?sslmode=no-verify", "?sslmode=disable", "?ssl=false"])(
    "refuses a non-loopback URL without DATABASE_CA_CERT (%s)", (query) => {
      expect(() => parseServerEnv({ ...remote, DATABASE_URL: hosted + query })).toThrow(/DATABASE_CA_CERT: is required/);
    });

  it("refuses a query string that moves a loopback URL to another host, even without a CA", () => {
    expect(() => parseServerEnv({ ...remote, DATABASE_URL: `${remote.DATABASE_URL}?host=db.example.com` }))
      .toThrow(/DATABASE_CA_CERT: is required.*DATABASE_URL: must not carry a query string/);
  });

  it("treats a URL with no host as remote: pg would fall back to PGHOST", () => {
    expect(() => parseServerEnv({ ...remote, DATABASE_URL: "postgres:///zs_dev" })).toThrow(/DATABASE_CA_CERT: is required/);
  });

  it("never echoes the database password in its errors", () => {
    let message = "";
    try {
      parseServerEnv({ ...remote, DATABASE_URL: `${hosted}?sslmode=disable` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain("pw@");
  });

  it("turns site publishing on with SITES_STORE, and needs every R2 variable for r2", () => {
    expect(parseServerEnv(base).sites).toBeNull();
    expect(parseServerEnv({ ...base, SITES_STORE: "memory" }).sites).toEqual({ store: { kind: "memory" }, compiler: "plain" });
    expect(() => parseServerEnv({ ...base, SITES_STORE: "r2", R2_BUCKET: "zs-sites" }))
      .toThrow(/R2_ENDPOINT: is required when SITES_STORE=r2.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/);
    const r2 = { R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com", R2_BUCKET: "zs-sites", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "s" };
    expect(parseServerEnv({ ...base, SITES_STORE: "r2", ...r2 }).sites).toEqual({
      store: { kind: "r2", endpoint: r2.R2_ENDPOINT, bucket: "zs-sites", accessKeyId: "id", secretAccessKey: "s" }, compiler: "plain",
    });
    expect(() => parseServerEnv({ ...base, SITES_STORE: "r2", ...r2, R2_ENDPOINT: "http://acct.r2.cloudflarestorage.com" })).toThrow(/R2_ENDPOINT/);
  });

  it("keeps the in-memory site store to loopback databases", () => {
    const remote = { ...base, SESSION_CHECK: "supabase", SUPABASE_URL: "https://abcd.supabase.co", DATABASE_URL: "postgres://zs_runtime@db.example.com:5432/postgres", DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----x" };
    expect(() => parseServerEnv({ ...remote, SITES_STORE: "memory" })).toThrow(/SITES_STORE: memory is for local runs/);
  });
});
