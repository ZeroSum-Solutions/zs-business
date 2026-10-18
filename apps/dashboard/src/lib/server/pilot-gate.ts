/**
 * Pilot gate for live mode. The proxy holds one owner token (ZS_API_TOKEN), so whoever may
 * call the proxy may spend it. Until real sign-in ships, a person proves they may by typing
 * a shared access code once; the server then sets a signed, expiring, httpOnly session
 * cookie, and the proxy and /api/session refuse every request without a valid one.
 *
 * Signing key: a separate server-only DASHBOARD_SESSION_SECRET (at least 32 characters),
 * not a key derived from the access code alone. A cookie then never helps anyone guess the
 * code offline, and rotating the secret signs everyone out without a new code. The access
 * code is mixed into the key too (HMAC(secret, code)), so changing the code also ends every
 * session issued under the old one.
 *
 * TODO(auth): real sign-in replaces this with the signed-in person's own token.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "zs_dashboard_session";
export const MIN_ACCESS_CODE_LENGTH = 16;
export const MIN_SESSION_SECRET_LENGTH = 32;
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const VERSION = "v1";

export interface PilotGateConfig {
  accessCode: string;
  sessionSecret: string;
  ttlSeconds: number;
  /** DASHBOARD_TRUST_PROXY=1: a reverse proxy in front sets X-Forwarded-Host and -Proto, and appends to -For. */
  trustProxy: boolean;
}

/** The gate's settings, or the reason live mode must not serve. */
export type PilotGateSetup = { ok: true; config: PilotGateConfig } | { ok: false; problem: string };

export function trustProxyFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.DASHBOARD_TRUST_PROXY?.trim() === "1";
}

export function pilotGateFromEnv(env: Record<string, string | undefined> = process.env): PilotGateSetup {
  const accessCode = env.DASHBOARD_ACCESS_CODE?.trim() ?? "";
  const sessionSecret = env.DASHBOARD_SESSION_SECRET?.trim() ?? "";
  if (accessCode.length < MIN_ACCESS_CODE_LENGTH) {
    return { ok: false, problem: `Live mode needs DASHBOARD_ACCESS_CODE of at least ${MIN_ACCESS_CODE_LENGTH} characters.` };
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    return { ok: false, problem: `Live mode needs DASHBOARD_SESSION_SECRET of at least ${MIN_SESSION_SECRET_LENGTH} characters.` };
  }
  const rawTtl = env.DASHBOARD_SESSION_TTL_SECONDS?.trim();
  const ttlSeconds = rawTtl ? Number(rawTtl) : DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_SESSION_TTL_SECONDS) {
    return { ok: false, problem: `DASHBOARD_SESSION_TTL_SECONDS must be a whole number from 60 to ${MAX_SESSION_TTL_SECONDS}.` };
  }
  return { ok: true, config: { accessCode, sessionSecret, ttlSeconds, trustProxy: trustProxyFromEnv(env) } };
}

const reported = new Set<string>();
/** Say once in the server log why live mode refuses to serve. */
export function reportGateProblem(problem: string) {
  if (reported.has(problem)) return;
  reported.add(problem);
  console.error(`[dashboard] ${problem} Live mode refuses every request until it is set.`);
}

function signingKey(config: PilotGateConfig): Buffer {
  return createHmac("sha256", config.sessionSecret).update(`zs-dashboard-session:${config.accessCode}`).digest();
}

function signature(config: PilotGateConfig, payload: string): Buffer {
  return createHmac("sha256", signingKey(config)).update(payload).digest();
}

/** `v1.<expires, unix seconds>.<nonce>.<HMAC>`; the nonce makes every session cookie unique. */
export function issueSessionValue(config: PilotGateConfig, now: Date = new Date()): { value: string; expiresAt: number } {
  const expiresAt = Math.floor(now.getTime() / 1000) + config.ttlSeconds;
  const payload = `${VERSION}.${expiresAt}.${randomBytes(16).toString("base64url")}`;
  return { value: `${payload}.${signature(config, payload).toString("base64url")}`, expiresAt };
}

export type SessionCheck = "valid" | "missing" | "invalid" | "expired";

export function checkSessionValue(value: string | null | undefined, config: PilotGateConfig, now: Date = new Date()): SessionCheck {
  if (!value) return "missing";
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !/^\d{1,12}$/.test(parts[1]!)) return "invalid";
  const given = Buffer.from(parts[3]!, "base64url");
  const expected = signature(config, parts.slice(0, 3).join("."));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid";
  const expiresAt = Number(parts[1]);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (expiresAt <= nowSeconds) return "expired";
  // Signed under a longer TTL than the one now set: the shorter setting wins.
  if (expiresAt - nowSeconds > config.ttlSeconds) return "expired";
  return "valid";
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function checkSession(request: Request, config: PilotGateConfig, now: Date = new Date()): SessionCheck {
  return checkSessionValue(readCookie(request, SESSION_COOKIE), config, now);
}

/** True when the browser reached this server over https (the proxy says so only if trusted). */
export function isHttps(request: Request, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto) return proto === "https";
  }
  return new URL(request.url).protocol === "https:";
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [`${SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "HttpOnly", "SameSite=Strict", ...(secure ? ["Secure"] : [])].join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

/** Constant-time code check: both sides are hashed first, so their lengths never differ. */
export function accessCodeMatches(given: string, config: PilotGateConfig): boolean {
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(given), digest(config.accessCode));
}

export interface AttemptLimits {
  windowMs: number;
  /** Attempts one address may make in a window. */
  perAddress: number;
  /** Attempts everyone together may make in a window. */
  global: number;
}

const MAX_TRACKED_ADDRESSES = 1000;

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = { windowMs: 15 * 60 * 1000, perAddress: 5, global: 30 };

/**
 * Sign-in attempts, kept in memory: enough for one pilot server. Every attempt is reserved
 * before its body is read and counts against its address (see clientAddress) and against
 * everyone; only a successful sign-in gives its reservation back. A full limit also refuses
 * the right code until the window passes.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly limits: AttemptLimits = DEFAULT_ATTEMPT_LIMITS) {}

  /** Seconds until this address may try again, or 0 when it may try now. */
  retryAfter(address: string, now: number = Date.now()): number {
    const since = now - this.limits.windowMs;
    this.all = this.all.filter((time) => time > since);
    const mine = (this.attempts.get(address) ?? []).filter((time) => time > since);
    if (mine.length > 0) this.attempts.set(address, mine);
    else this.attempts.delete(address);
    const blockedUntil = Math.max(
      mine.length >= this.limits.perAddress ? mine[mine.length - this.limits.perAddress]! + this.limits.windowMs : 0,
      this.all.length >= this.limits.global ? this.all[this.all.length - this.limits.global]! + this.limits.windowMs : 0,
    );
    return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0;
  }

  /**
   * Takes one attempt for this address and for everyone, or returns the seconds to wait and
   * takes nothing. Synchronous on purpose: call it before awaiting anything, so concurrent
   * requests each see the attempts the ones before them took.
   */
  reserve(address: string, now: number = Date.now()): number {
    const wait = this.retryAfter(address, now);
    if (wait > 0) return wait;
    this.all.push(now);
    this.attempts.set(address, [...(this.attempts.get(address) ?? []), now]);
    // Addresses that never come back must not pile up.
    if (this.attempts.size > MAX_TRACKED_ADDRESSES) {
      const since = now - this.limits.windowMs;
      for (const [key, times] of this.attempts) {
        if (times[times.length - 1]! <= since) this.attempts.delete(key);
      }
    }
    return 0;
  }

  /** Gives back the attempt reserve() took at `time`: the sign-in succeeded. */
  refund(address: string, time: number) {
    const drop = (times: number[]) => {
      const index = times.lastIndexOf(time);
      return index === -1 ? times : [...times.slice(0, index), ...times.slice(index + 1)];
    };
    this.all = drop(this.all);
    const mine = drop(this.attempts.get(address) ?? []);
    if (mine.length > 0) this.attempts.set(address, mine);
    else this.attempts.delete(address);
  }
}

/** The limiter key for every caller when no trusted proxy says who they are. */
export const DIRECT_ADDRESS = "direct";

/**
 * The caller's address for rate limiting. X-Forwarded-For counts only behind a trusted
 * proxy (DASHBOARD_TRUST_PROXY=1), which appends the address it saw, so the right-most
 * entry is the one to use. Without one, anyone can write that header (and `next start`
 * passes a sent one through), so every caller shares one "direct" key: the per-address
 * limit then bounds everyone together, next to the global one.
 */
export function clientAddress(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return DIRECT_ADDRESS;
  const entries = request.headers.get("x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return entries.at(-1) ?? DIRECT_ADDRESS;
}
