/**
 * Rate limits for sign-in link requests, kept in the API's shared Postgres limiter (POST /public/v1/sign-in/admit,
 * public-intake.md P-10) so they hold across every dashboard server instance. Every request is charged against the
 * caller's address and against everyone, together in one atomic call, before its body is read: a burst of parallel
 * requests cannot outrun the limit and nobody can make the server send unlimited email. There is no per-email
 * bucket (it would let anyone lock a known address out, and its Retry-After would tell who has an account). A
 * charge is never given back, so a request Supabase could not take still counts.
 *
 * It fails closed, like the API's other shared-limiter callers: when the limiter cannot answer (no valid
 * DASHBOARD_SIGN_IN_LIMITER_SECRET, an unusable ZS_API_URL, the API unreachable, a store outage) no link is sent and
 * the caller gets 502. A missing or invalid setting is logged once per process.
 */
import {
  SIGN_IN_ADMIT_PATH, SIGN_IN_DEFAULT_LIMITS, SIGN_IN_DIRECT_ADDRESS, signInLimiterSecretSchema, type SignInAdmitBody,
} from "@zs/contracts";

export interface AttemptLimits {
  /** Attempts one address may make in a window. */
  perAddress: number;
  /** Attempts everyone together may make in a window. */
  global: number;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = { ...SIGN_IN_DEFAULT_LIMITS };

type Vars = Record<string, string | undefined>;

/**
 * Sign-in link requests per 15 minutes: DASHBOARD_SIGN_IN_PER_ADDRESS (default 5) and DASHBOARD_SIGN_IN_GLOBAL
 * (default 30), whole numbers from 1 to 10000. Without a trusted proxy every caller shares one address, so a
 * larger team may need a higher first limit.
 */
export function attemptLimitsFromEnv(vars: Vars = process.env): AttemptLimits {
  const read = (name: string, fallback: number) => {
    const value = Number(vars[name]?.trim() || fallback);
    return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : fallback;
  };
  return {
    perAddress: read("DASHBOARD_SIGN_IN_PER_ADDRESS", DEFAULT_ATTEMPT_LIMITS.perAddress),
    global: read("DASHBOARD_SIGN_IN_GLOBAL", DEFAULT_ATTEMPT_LIMITS.global),
  };
}

export type Admission =
  | { readonly ok: true }
  /** Over a limit: the seconds to wait. */
  | { readonly ok: false; readonly retryAfterSeconds: number }
  /** The limiter could not answer: fail closed. */
  | { readonly ok: false; readonly unavailable: true };

export interface SignInLimiter {
  /**
   * Charges the caller's address and everyone, in one call, before the request body is read. `signal` ends the
   * call early (the incoming request was dropped); the call always ends after a few seconds on its own.
   */
  admit(address: string, signal?: AbortSignal): Promise<Admission>;
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
/** The API reads at most this many characters of an address; a longer one is not an address. */
const MAX_ADDRESS_LENGTH = 64;

/** An empty or oversize value joins the shared "direct" bucket here, so a header can never make the call fail. */
const boundedAddress = (address: string) =>
  address.length === 0 || address.length > MAX_ADDRESS_LENGTH ? SIGN_IN_DIRECT_ADDRESS : address;

export function createSharedSignInLimiter(config: SharedLimiterConfig): SignInLimiter {
  const send = config.fetch ?? fetch;
  return {
    async admit(address, signal) {
      if (!config.secret) return { ok: false, unavailable: true };
      const body: SignInAdmitBody = { address: boundedAddress(address), perAddress: config.limits.perAddress, global: config.limits.global };
      const deadline = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await send(`${config.apiUrl}${SIGN_IN_ADMIT_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
          body: JSON.stringify(body),
          cache: "no-store",
          redirect: "error",
          signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
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
    },
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

/**
 * The base URL the limiter call goes to. https anywhere; plain http only to this machine (the secret is a bearer
 * token, so it must not cross a network in clear). Returns the reason when the value cannot be used.
 */
export function limiterApiUrl(raw: string | undefined): { readonly url: string } | { readonly problem: string } {
  const value = raw?.trim() ?? "";
  if (value === "") return { problem: "ZS_API_URL is not set" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { problem: "ZS_API_URL is not a URL" };
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname) || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) return { problem: "ZS_API_URL must be https (plain http is allowed only for localhost)" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { problem: "ZS_API_URL must be an https URL" };
  return { url: value.replace(/\/+$/, "") };
}

const reported = new Set<string>();
/** Test hook: forget what was already logged. */
export function resetSignInLimiterReports(): void {
  reported.clear();
}

/** The limiter for this server: the shared one at ZS_API_URL, with its secret and limits from the environment. */
export function signInLimiterFromEnv(
  vars: Vars = process.env,
  report: (message: string) => void = (message) => console.error(message),
): SignInLimiter {
  const problems: string[] = [];
  const rawSecret = vars.DASHBOARD_SIGN_IN_LIMITER_SECRET;
  const secret = signInLimiterSecretSchema.safeParse(rawSecret ?? "");
  if (rawSecret === undefined || rawSecret.trim() === "")
    problems.push("DASHBOARD_SIGN_IN_LIMITER_SECRET is not set");
  else if (!secret.success)
    problems.push(`DASHBOARD_SIGN_IN_LIMITER_SECRET ${secret.error.issues[0]?.message ?? "is not valid"}`);
  const api = limiterApiUrl(vars.ZS_API_URL);
  if ("problem" in api) problems.push(api.problem);
  for (const problem of problems) {
    if (reported.has(problem)) continue;
    reported.add(problem);
    report(`Sign-in is closed: ${problem}. Set it on the dashboard (and SIGN_IN_LIMITER_SECRET on the API, deployed first).`);
  }
  return createSharedSignInLimiter({
    apiUrl: "url" in api ? api.url : "",
    secret: secret.success && "url" in api ? secret.data : null,
    limits: attemptLimitsFromEnv(vars),
  });
}

/** The limiter key for every caller when no trusted proxy says who they are. */
export const DIRECT_ADDRESS = SIGN_IN_DIRECT_ADDRESS;

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
