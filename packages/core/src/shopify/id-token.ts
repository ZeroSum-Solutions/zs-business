// Connections C-21, S3: the check on a Shopify ID (session) token. Original code. HS256 against the
// app's client secret (the previous one during a rotation); `aud` is the client id; `exp` and `nbf` hold
// with 10 seconds of skew; `dest` is exactly `https://<shop>.myshopify.com` and `iss` is `dest/admin`.
// Anything else is refused with no reason a caller could show: the caller learns only `ok: false`.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;
const MAX_TOKEN_BYTES = 8192;
const SKEW_SECONDS = 10;

export interface IdTokenConfig {
  readonly clientId: string;
  readonly secrets: { readonly current: string; readonly previous?: string };
  readonly now: () => Date;
}
export type IdTokenResult =
  | { readonly ok: true; readonly shopDomain: string; readonly jti: string; readonly expiresAt: Date; readonly userId: string }
  | { readonly ok: false };

const REFUSED = { ok: false } as const;
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function decodeJson(part: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyIdToken(config: IdTokenConfig, token: string): IdTokenResult {
  if (token.length === 0 || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return REFUSED;
  const parts = token.split(".");
  if (parts.length !== 3) return REFUSED;
  const [header, payload, signature] = parts as [string, string, string];
  const head = decodeJson(header);
  if (head === null || head.alg !== "HS256") return REFUSED;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return REFUSED;
  const given = Buffer.from(signature, "base64url");
  let valid = false;
  for (const secret of [config.secrets.current, config.secrets.previous]) {
    if (secret === undefined) continue;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) valid = true;
  }
  if (!valid) return REFUSED;
  const claims = decodeJson(payload);
  if (claims === null) return REFUSED;
  const { iss, dest, aud, sub, exp, nbf, jti } = claims;
  if (!isString(iss) || !isString(dest) || !isString(aud) || !isString(sub) || !isString(jti) || !isNumber(exp) || !isNumber(nbf)) return REFUSED;
  if (aud !== config.clientId) return REFUSED;
  const now = Math.floor(config.now().getTime() / 1000);
  if (exp + SKEW_SECONDS < now || nbf - SKEW_SECONDS > now) return REFUSED;
  const match = /^https:\/\/([^/]+)$/.exec(dest);
  if (!match || !SHOP_DOMAIN.test(match[1]!)) return REFUSED;
  if (iss !== `${dest}/admin`) return REFUSED;
  if (jti.length > 128 || sub.length > 64) return REFUSED;
  return { ok: true, shopDomain: match[1]!, jti, expiresAt: new Date(exp * 1000), userId: sub };
}
