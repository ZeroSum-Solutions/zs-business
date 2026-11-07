// Connections C-3: the signature on every API-to-worker request. The tag covers the environment,
// the worker's host, the method, the path, a timestamp, a 128-bit random request ID (jti) and the
// SHA-256 of the raw body, under HMAC-SHA-256 with a different secret per environment. The worker
// refuses a timestamp more than 60 seconds off, a host or environment that is not its own, a bad
// tag (constant time, current or previous secret) and a jti it has seen. Original code.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectionStateSecrets } from "./tokens.js";

export const CONNECTOR_SIGNATURE_HEADERS = Object.freeze({
  env: "x-zs-conn-env",
  timestamp: "x-zs-conn-timestamp",
  jti: "x-zs-conn-jti",
  signature: "x-zs-conn-signature",
});
export const CONNECTOR_MAX_SKEW_MS = 60_000;
/** Nonces are kept this long: past the skew window both ways, with room to spare (C-3: 5 minutes). */
export const CONNECTOR_NONCE_TTL_MS = 5 * 60_000;
export const CONNECTOR_PATH_PREFIX = "/internal/connections/";
const PREFIX = "zcs1";

export type ConnectorEnv = "production" | "preview";

const sha256Hex = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const canonical = (parts: { env: string; host: string; method: string; path: string; timestamp: string; jti: string; body: string | Uint8Array }) =>
  [PREFIX, parts.env, parts.host.toLowerCase(), parts.method.toUpperCase(), parts.path, parts.timestamp, parts.jti, sha256Hex(parts.body)].join("\n");
const tagOf = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest();

/** The headers the API adds to a request for `host` and `path`. The body must be the bytes sent. */
export function signConnectorRequest(input: {
  readonly secret: string;
  readonly env: ConnectorEnv;
  readonly host: string;
  readonly method?: string;
  readonly path: string;
  readonly body: string;
  readonly now: Date;
  /** Tests pin it; production draws 128 random bits. */
  readonly jti?: string;
}): Record<string, string> {
  const jti = input.jti ?? randomBytes(16).toString("base64url");
  const timestamp = String(input.now.getTime());
  const text = canonical({ env: input.env, host: input.host, method: input.method ?? "POST", path: input.path, timestamp, jti, body: input.body });
  return {
    [CONNECTOR_SIGNATURE_HEADERS.env]: input.env,
    [CONNECTOR_SIGNATURE_HEADERS.timestamp]: timestamp,
    [CONNECTOR_SIGNATURE_HEADERS.jti]: jti,
    [CONNECTOR_SIGNATURE_HEADERS.signature]: tagOf(input.secret, text).toString("base64url"),
  };
}

export type ConnectorRequestRefusal = "unsigned" | "stale" | "wrong_env" | "bad_signature" | "replayed";

/**
 * Whether a request is the API's, fresh and unseen. `takeNonce` records the jti and answers false
 * when it was already there; it runs only after the tag verified, so a forger fills nothing.
 */
export async function verifyConnectorRequest(input: {
  readonly secrets: ConnectionStateSecrets;
  readonly env: ConnectorEnv;
  /** The host this request arrived for. */
  readonly host: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly headers: { get(name: string): string | null | undefined };
  readonly body: string;
  readonly now: Date;
  readonly takeNonce: (jti: string, expiresAt: Date) => Promise<boolean>;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: ConnectorRequestRefusal }> {
  const header = (name: string) => input.headers.get(name) ?? undefined;
  const given = header(CONNECTOR_SIGNATURE_HEADERS.signature);
  const timestamp = header(CONNECTOR_SIGNATURE_HEADERS.timestamp);
  const jti = header(CONNECTOR_SIGNATURE_HEADERS.jti);
  const env = header(CONNECTOR_SIGNATURE_HEADERS.env);
  if (!given || !timestamp || !jti || !env || input.host === undefined || input.host === "") return { ok: false, reason: "unsigned" };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(jti) || !/^[0-9]{1,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{43}$/.test(given)) return { ok: false, reason: "unsigned" };
  if (Math.abs(input.now.getTime() - Number(timestamp)) > CONNECTOR_MAX_SKEW_MS) return { ok: false, reason: "stale" };
  if (env !== input.env) return { ok: false, reason: "wrong_env" };
  const text = canonical({ env, host: input.host, method: input.method, path: input.path, timestamp, jti, body: input.body });
  const tag = Buffer.from(given, "base64url");
  if (tag.toString("base64url") !== given) return { ok: false, reason: "bad_signature" };
  let valid = false;
  for (const secret of [input.secrets.current, input.secrets.previous])
    if (secret !== undefined && timingSafeEqual(tag, tagOf(secret, text))) valid = true;
  if (!valid) return { ok: false, reason: "bad_signature" };
  // The host is part of the tag, so a request signed for another host fails above as a bad signature.
  if (!(await input.takeNonce(jti, new Date(input.now.getTime() + CONNECTOR_NONCE_TTL_MS)))) return { ok: false, reason: "replayed" };
  return { ok: true };
}
