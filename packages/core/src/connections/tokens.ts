// Connections C-4, C-5: the attempt token (zca1) the API hands the dashboard when a connect starts,
// and the grant token (zcg1) it stages when the callback verified the account. Original code, in
// the shape of calendar/oauth-state.ts and calendar/pending-grant.ts: an HMAC-SHA-256 tag over a
// prefix and a base64url JSON array, a prefix inside the MAC so a token of one kind never reads as
// another, `{current, previous}` secrets for a rotation, the canonical tag spelling only, and a
// constant-time compare. Nothing is stored for either token; the worker's attempt row is the
// record of an attempt.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeAccountLabel, shopDomainSchema, toolkitSchema } from "@zs/contracts";
import { browserKeyMatches } from "../calendar/oauth-state.js";

export type { OAuthStateSecrets as ConnectionStateSecrets } from "../calendar/oauth-state.js";
import type { OAuthStateSecrets } from "../calendar/oauth-state.js";

const ATTEMPT_PREFIX = "zca1.";
const GRANT_PREFIX = "zcg1.";
/** Both tokens live 10 minutes (C-4, C-5). */
export const CONNECT_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
export const CONNECT_GRANT_LIFETIME_MS = 10 * 60 * 1000;
/** A grant fits one cookie with room to spare. */
export const MAX_CONNECT_GRANT_LENGTH = 3500;
const MAX_ATTEMPT_LENGTH = 1800;

export interface ConnectAttempt {
  readonly tenantId: string;
  /** The member's user ID (the principal's actor), re-checked for `integrations` at the callback. */
  readonly actorId: string;
  readonly toolkit: string;
  readonly attemptId: string;
  readonly connectionId: string;
  readonly composioAccountId: string;
  readonly authConfigId: string;
  /** SHA-256 (base64url) of the browser key the dashboard set when the flow started. */
  readonly browserHash: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}
export interface ConnectGrant {
  readonly tenantId: string;
  readonly actorId: string;
  readonly toolkit: string;
  readonly attemptId: string;
  readonly connectionId: string;
  readonly composioAccountId: string;
  readonly accountDomain: string;
  readonly externalAccountId: string;
  readonly accountLabel: string;
  readonly expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_32 = /^[A-Za-z0-9_-]{43}$/;
const tag = (prefix: string, secret: string, body: string) => createHmac("sha256", secret).update(`${prefix}${body}`).digest();

function sign(prefix: string, secret: string, fields: readonly unknown[]): string {
  const body = Buffer.from(JSON.stringify(fields)).toString("base64url");
  return `${prefix}${body}.${tag(prefix, secret, body).toString("base64url")}`;
}

/** The fields of a token this server signed with a known secret, or null. */
function open(prefix: string, secrets: OAuthStateSecrets, token: string | undefined, maxLength: number): unknown[] | null {
  if (token === undefined || token.length > maxLength || !token.startsWith(prefix)) return null;
  const parts = token.slice(prefix.length).split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !KEY_32.test(parts[1]!)) return null;
  const [body, given] = [parts[0]!, Buffer.from(parts[1]!, "base64url")];
  // 43 characters carry 258 bits; only the canonical spelling of the 256-bit tag is accepted.
  if (given.toString("base64url") !== parts[1]) return null;
  let valid = false;
  for (const secret of [secrets.current, secrets.previous])
    if (secret !== undefined && timingSafeEqual(given, tag(prefix, secret, body))) valid = true;
  if (!valid) return null;
  try {
    const fields: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return Array.isArray(fields) ? fields : null;
  } catch {
    return null;
  }
}

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;
const live = (expiresAt: unknown, now: Date): expiresAt is number =>
  typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > now.getTime();

export function signConnectAttempt(secret: string, attempt: ConnectAttempt): string {
  return sign(ATTEMPT_PREFIX, secret, [
    attempt.tenantId, attempt.actorId, attempt.toolkit, attempt.attemptId, attempt.connectionId, attempt.composioAccountId,
    attempt.authConfigId, attempt.browserHash, attempt.expiresAt,
  ]);
}
/** The attempt, or null when it is malformed, not signed by a known secret, or expired. */
export function verifyConnectAttempt(secrets: OAuthStateSecrets, token: string | undefined, now: Date): ConnectAttempt | null {
  const fields = open(ATTEMPT_PREFIX, secrets, token, MAX_ATTEMPT_LENGTH);
  if (!fields || fields.length !== 9) return null;
  const [tenantId, actorId, toolkit, attemptId, connectionId, composioAccountId, authConfigId, browserHash, expiresAt] = fields;
  if (![tenantId, actorId, attemptId, connectionId].every(isUuid)) return null;
  if (typeof toolkit !== "string" || !toolkitSchema.safeParse(toolkit).success) return null;
  if (!isText(composioAccountId, 128) || !isText(authConfigId, 128)) return null;
  if (typeof browserHash !== "string" || !KEY_32.test(browserHash) || !live(expiresAt, now)) return null;
  return {
    tenantId: tenantId as string, actorId: actorId as string, toolkit, attemptId: attemptId as string, connectionId: connectionId as string,
    composioAccountId, authConfigId, browserHash, expiresAt,
  };
}
/** Whether `browserKey` is the key the attempt was bound to; missing or malformed never matches. */
export const attemptBrowserMatches = (attempt: Pick<ConnectAttempt, "browserHash">, browserKey: string | undefined): boolean =>
  browserKeyMatches({ browserBinding: attempt.browserHash }, browserKey);

/** The signed grant, or null when it would not fit a cookie. */
export function signConnectGrant(secret: string, grant: ConnectGrant): string | null {
  const token = sign(GRANT_PREFIX, secret, [
    grant.tenantId, grant.actorId, grant.toolkit, grant.attemptId, grant.connectionId, grant.composioAccountId,
    grant.accountDomain, grant.externalAccountId, grant.accountLabel, grant.expiresAt,
  ]);
  return token.length <= MAX_CONNECT_GRANT_LENGTH ? token : null;
}
/** The grant, or null when it is malformed, not signed by a known secret, or expired. */
export function verifyConnectGrant(secrets: OAuthStateSecrets, token: string | undefined, now: Date): ConnectGrant | null {
  const fields = open(GRANT_PREFIX, secrets, token, MAX_CONNECT_GRANT_LENGTH);
  if (!fields || fields.length !== 10) return null;
  const [tenantId, actorId, toolkit, attemptId, connectionId, composioAccountId, accountDomain, externalAccountId, accountLabel, expiresAt] = fields;
  if (![tenantId, actorId, attemptId, connectionId].every(isUuid)) return null;
  if (typeof toolkit !== "string" || !toolkitSchema.safeParse(toolkit).success) return null;
  if (!isText(composioAccountId, 128) || !isText(externalAccountId, 64) || !isText(accountLabel, 120)) return null;
  if (typeof accountDomain !== "string" || !shopDomainSchema.safeParse(accountDomain).success) return null;
  // Signed by us, but the label must still be in the normal form the action will store.
  if (normalizeAccountLabel(accountLabel) !== accountLabel) return null;
  if (!live(expiresAt, now)) return null;
  return {
    tenantId: tenantId as string, actorId: actorId as string, toolkit, attemptId: attemptId as string, connectionId: connectionId as string,
    composioAccountId, accountDomain, externalAccountId, accountLabel, expiresAt,
  };
}
/** The grant's ID: the SHA-256 (base64url) of its token, so a replaced grant is never confirmed in place of the one reviewed. */
export const connectGrantId = (token: string): string => createHash("sha256").update(token, "utf8").digest("base64url");
/** C-5: the reserved key the connect action runs under, one per connection. */
export const connectIdempotencyKey = (connectionId: string): string => `connect:${connectionId.toLowerCase()}`;
