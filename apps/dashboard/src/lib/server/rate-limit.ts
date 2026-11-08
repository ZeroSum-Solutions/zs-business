/**
 * Rate limits for sign-in link requests, kept in the API's shared Postgres limiter (POST /public/v1/sign-in/admit,
 * public-intake.md P-10) so they hold across every dashboard server instance. Every request is charged against the
 * caller's address and against everyone before its body is read, so a burst of parallel requests cannot outrun the
 * limit and nobody can make the server send unlimited email; once the body parsed it is charged against the email
 * too (by the SHA-256 of the lowercased address: the raw address never reaches the limiter). A charge is never given
 * back, so a request Supabase could not take still counts.
 *
 * It fails closed, like the API's other shared-limiter callers: when the limiter cannot answer (no
 * DASHBOARD_SIGN_IN_LIMITER_SECRET, the API unreachable, a store outage) no link is sent and the caller gets 502.
 */
import { createHash } from "node:crypto";
import { SIGN_IN_ADMIT_PATH, SIGN_IN_DEFAULT_LIMITS, type SignInAdmitBody } from "@zs/contracts";

export interface AttemptLimits {
  /** Attempts one address may make in a window. */
  perAddress: number;
  /** Attempts everyone together may make in a window. */
  global: number;
  /** Attempts one email address may receive in a window. */
  perEmail: number;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = { ...SIGN_IN_DEFAULT_LIMITS };

type Vars = Record<string, string | undefined>;

/**
 * Sign-in link requests per 15 minutes: DASHBOARD_SIGN_IN_PER_ADDRESS (default 5), DASHBOARD_SIGN_IN_GLOBAL
 * (default 30) and DASHBOARD_SIGN_IN_PER_EMAIL (default 5), whole numbers from 1 to 10000. Without a trusted
 * proxy every caller shares one address, so a larger team may need a higher first limit.
 */
export function attemptLimitsFromEnv(vars: Vars = process.env): AttemptLimits {
  const read = (name: string, fallback: number) => {
    const value = Number(vars[name]?.trim() || fallback);
    return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : fallback;
  };
  return {
    perAddress: read("DASHBOARD_SIGN_IN_PER_ADDRESS", DEFAULT_ATTEMPT_LIMITS.perAddress),
    global: read("DASHBOARD_SIGN_IN_GLOBAL", DEFAULT_ATTEMPT_LIMITS.global),
    perEmail: read("DASHBOARD_SIGN_IN_PER_EMAIL", DEFAULT_ATTEMPT_LIMITS.perEmail),
  };
}

export type Admission =
  | { readonly ok: true }
  /** Over a limit: the seconds to wait. */
  | { readonly ok: false; readonly retryAfterSeconds: number }
  /** The limiter could not answer: fail closed. */
  | { readonly ok: false; readonly unavailable: true };

export interface SignInLimiter {
  /** Charges the caller's address and everyone, before the request body is read. */
  admitAddress(address: string): Promise<Admission>;
  /** Charges one email address (already trimmed and lowercased). */
  admitEmail(email: string): Promise<Admission>;
}

export interface SharedLimiterConfig {
  /** apps/api base URL. */
  apiUrl: string;
  /** DASHBOARD_SIGN_IN_LIMITER_SECRET; the API holds the same value as SIGN_IN_LIMITER_SECRET. Absent: always unavailable. */
  secret: string | null;
  limits: AttemptLimits;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export function createSharedSignInLimiter(config: SharedLimiterConfig): SignInLimiter {
  const send = config.fetch ?? fetch;
  const take = async (body: SignInAdmitBody): Promise<Admission> => {
    if (!config.secret) return { ok: false, unavailable: true };
    try {
      const response = await send(`${config.apiUrl}${SIGN_IN_ADMIT_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (response.status === 204) return { ok: true };
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after"));
        return { ok: false, retryAfterSeconds: Number.isInteger(wait) && wait >= 1 ? wait : 60 };
      }
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, unavailable: true };
    } catch {
      return { ok: false, unavailable: true };
    }
  };
  return {
    admitAddress: (address) => take({ scope: "address", address, perAddress: config.limits.perAddress, global: config.limits.global }),
    admitEmail: (email) => take({ scope: "email", emailHash: sha256Hex(email), perEmail: config.limits.perEmail }),
  };
}

/** The limiter for this server: the shared one at ZS_API_URL, with its secret and limits from the environment. */
export function signInLimiterFromEnv(vars: Vars = process.env): SignInLimiter {
  const secret = vars.DASHBOARD_SIGN_IN_LIMITER_SECRET?.trim() ?? "";
  return createSharedSignInLimiter({
    apiUrl: (vars.ZS_API_URL?.trim() ?? "").replace(/\/+$/, ""),
    secret: secret.length >= 32 ? secret : null,
    limits: attemptLimitsFromEnv(vars),
  });
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
