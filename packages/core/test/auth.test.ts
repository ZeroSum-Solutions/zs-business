import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createJwksVerifier,
  createVerifierFromConfig,
  mapError,
  parseJwtEnv,
  PLACEHOLDER_JWT_SECRET,
  Unauthenticated,
  type JwtConfig,
} from "../src/index.js";

const NOW = Date.parse("2026-10-19T08:00:00.000Z");
const clock = { now: () => new Date(NOW) };
/** Synthetic HS256 key, built at runtime so secret scanners do not flag a literal. */
const SECRET = ["core", "auth", "secret", "x".repeat(32)].join("-");
const principal = { tenantId: randomUUID(), actorId: randomUUID(), sessionId: randomUUID() };

type Signing = { alg: "HS256"; key: Uint8Array } | { alg: "ES256"; key: CryptoKey; kid: string };

/** A Supabase-shaped access token for `principal`, issued now for `ttl` seconds. */
function sign(signing: Signing, ttl = 600): Promise<string> {
  const iat = Math.floor(NOW / 1000);
  return new SignJWT({ role: "authenticated", session_id: principal.sessionId, app_metadata: { tenant_id: principal.tenantId } })
    .setProtectedHeader(signing.alg === "HS256" ? { alg: "HS256", typ: "JWT" } : { alg: "ES256", typ: "JWT", kid: signing.kid })
    .setSubject(principal.actorId)
    .setAudience("authenticated")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(signing.key);
}

const hs256: Signing = { alg: "HS256", key: new TextEncoder().encode(SECRET) };
let issuer: Signing & { alg: "ES256" };
let impostor: Signing & { alg: "ES256" };
let publicJwk: JWK;
let jwksServer: Server;
let jwksUrl: string;
let jwksRequests = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  issuer = { alg: "ES256", key: pair.privateKey, kid: "signing-key-1" };
  // Another key under the same kid: only the signature can tell them apart.
  impostor = { alg: "ES256", key: (await generateKeyPair("ES256")).privateKey, kid: "signing-key-1" };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: issuer.kid, alg: "ES256", use: "sig" };
  // A tiny JWKS endpoint on loopback, as Supabase serves /auth/v1/.well-known/jwks.json.
  jwksServer = createServer((request, response) => {
    jwksRequests += 1;
    if (request.url !== "/auth/v1/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => (jwksServer ? jwksServer.close(() => resolve()) : resolve()));
});

describe("parseJwtEnv: the signing method is an explicit, required choice", () => {
  it("refuses a missing or unknown JWT_VERIFIER", () => {
    expect(() => parseJwtEnv({ JWT_SECRET: SECRET })).toThrow(/JWT_VERIFIER: JWT_VERIFIER must be hs256 or jwks/);
    for (const value of ["", "HS256", "rs256", "none", "jwks,hs256"])
      expect(() => parseJwtEnv({ JWT_VERIFIER: value, JWT_SECRET: SECRET, JWT_JWKS_URL: "https://example.supabase.co/x" }))
        .toThrow(/JWT_VERIFIER/);
  });

  it("hs256 needs a real JWT_SECRET, and never echoes it", () => {
    expect(() => parseJwtEnv({ JWT_VERIFIER: "hs256" })).toThrow(/JWT_SECRET: JWT_SECRET is required when JWT_VERIFIER=hs256/);
    expect(() => parseJwtEnv({ JWT_VERIFIER: "hs256", JWT_SECRET: "short-secret" })).toThrow(/at least 32 characters/);
    expect(() => parseJwtEnv({ JWT_VERIFIER: "hs256", JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(/placeholder/);
    try {
      parseJwtEnv({ JWT_VERIFIER: "hs256", JWT_SECRET: "short-secret" });
    } catch (error) {
      expect(String(error)).not.toContain("short-secret");
    }
    // A JWKS URL alongside is ignored: the choice decides.
    expect(parseJwtEnv({ JWT_VERIFIER: "hs256", JWT_SECRET: SECRET, JWT_JWKS_URL: "http://evil.example/jwks" }))
      .toEqual({ method: "hs256", secret: SECRET, issuer: undefined, maxLifetimeSeconds: 3600, clockSkewSeconds: 60 });
  });

  it("jwks needs JWT_JWKS_URL and does not need JWT_SECRET", () => {
    expect(() => parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_SECRET: SECRET })).toThrow(/JWT_JWKS_URL: JWT_JWKS_URL is required when JWT_VERIFIER=jwks/);
    const url = "https://abcd.supabase.co/auth/v1/.well-known/jwks.json";
    expect(parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: url, JWT_ISSUER: "https://abcd.supabase.co/auth/v1" })).toEqual({
      method: "jwks", jwksUrl: url, issuer: "https://abcd.supabase.co/auth/v1", maxLifetimeSeconds: 3600, clockSkewSeconds: 60,
    });
  });

  it("jwks accepts https anywhere and plain http only on loopback", () => {
    for (const url of ["https://abcd.supabase.co/auth/v1/.well-known/jwks.json", "http://127.0.0.1:54321/jwks", "http://localhost/jwks", "http://[::1]:9000/jwks"])
      expect(parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: url })).toMatchObject({ method: "jwks", jwksUrl: url });
    for (const url of ["http://abcd.supabase.co/auth/v1/.well-known/jwks.json", "http://10.0.0.5/jwks", "http://127.0.0.1.nip.io/jwks", "ftp://127.0.0.1/jwks", "file:///etc/jwks.json"])
      expect(() => parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: url })).toThrow(/must use https/);
    expect(() => parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: "not a url" })).toThrow(/must be a URL/);
    expect(() => parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: "https://user:pass@abcd.supabase.co/jwks" })).toThrow(/credentials/);
  });

  it("keeps the lifetime and skew limits", () => {
    const base = { JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
    expect(parseJwtEnv({ ...base, JWT_MAX_TTL_SECONDS: "604800", JWT_CLOCK_SKEW_SECONDS: "0" }))
      .toMatchObject({ maxLifetimeSeconds: 604800, clockSkewSeconds: 0 });
    expect(() => parseJwtEnv({ ...base, JWT_MAX_TTL_SECONDS: "0" })).toThrow(/JWT_MAX_TTL_SECONDS/);
    expect(() => parseJwtEnv({ ...base, JWT_CLOCK_SKEW_SECONDS: "301" })).toThrow(/JWT_CLOCK_SKEW_SECONDS/);
  });
});

const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(Unauthenticated);

describe("createVerifierFromConfig", () => {
  it("hs256 accepts its HS256 token and refuses ES256 tokens", async () => {
    const verifier = createVerifierFromConfig(parseJwtEnv({ JWT_VERIFIER: "hs256", JWT_SECRET: SECRET }), clock);
    await expect(verifier.verify(await sign(hs256))).resolves.toEqual({ ...principal, expiresAt: expect.any(Number) });
    await refused(verifier.verify(await sign(issuer)));
    await refused(verifier.verify(await sign({ alg: "HS256", key: new TextEncoder().encode(`${SECRET}-other`) })));
  });

  it("jwks fetches the keys over HTTP, accepts the issuer's ES256 token and refuses others", async () => {
    const verifier = createVerifierFromConfig(parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: jwksUrl }), clock);
    const before = jwksRequests;
    await expect(verifier.verify(await sign(issuer))).resolves.toEqual({ ...principal, expiresAt: expect.any(Number) });
    expect(jwksRequests).toBeGreaterThan(before);
    // Signed by another key under the same kid, by a key the JWKS does not list, or with HS256.
    await refused(verifier.verify(await sign(impostor)));
    await refused(verifier.verify(await sign({ ...impostor, kid: "unknown-key" })));
    await refused(verifier.verify(await sign(hs256)));
    // An expired token is refused against the injected clock.
    const later = createVerifierFromConfig(parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: jwksUrl }), { now: () => new Date(NOW + 601_000) });
    await refused(later.verify(await sign(issuer)));
  });

  it("jwks applies the configured issuer", async () => {
    const verifier = createVerifierFromConfig(
      parseJwtEnv({ JWT_VERIFIER: "jwks", JWT_JWKS_URL: jwksUrl, JWT_ISSUER: "https://abcd.supabase.co/auth/v1" }), clock,
    );
    await refused(verifier.verify(await sign(issuer)));
  });

  it("refuses a hand-built config with a non-loopback http JWKS URL", () => {
    const config: JwtConfig = { method: "jwks", jwksUrl: "http://abcd.supabase.co/jwks", issuer: undefined, maxLifetimeSeconds: 3600, clockSkewSeconds: 60 };
    expect(() => createVerifierFromConfig(config, clock)).toThrow(/https/);
  });
});

describe("createJwksVerifier with a local JWKS", () => {
  it("accepts the listed key's ES256 token and refuses another key's or an HS256 token", async () => {
    const verifier = createJwksVerifier(createLocalJWKSet({ keys: [publicJwk] }), { clock });
    await expect(verifier.verify(await sign(issuer))).resolves.toEqual({ ...principal, expiresAt: expect.any(Number) });
    await refused(verifier.verify(await sign(impostor)));
    await refused(verifier.verify(await sign(hs256)));
  });
});

describe("Unauthenticated", () => {
  it("maps to 401 Unauthorized with its fixed message", () => {
    expect(mapError(new Unauthenticated())).toEqual({
      status: 401, body: { error: { code: "Unauthorized", message: "Invalid or missing access token", details: {} } },
    });
    expect(mapError(new Unauthenticated("Session has ended")).body.error).toMatchObject({ code: "Unauthorized", message: "Session has ended" });
  });
});
