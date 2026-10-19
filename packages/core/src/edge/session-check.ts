// Is the Supabase session behind a verified access token still live? Sign-out deletes the
// session, so a token whose signature and expiry are fine can still be dead. Hosted Supabase
// keeps auth.sessions to itself (owned by supabase_auth_admin, RLS on, no policies), so the
// edge asks Supabase Auth: GET /auth/v1/user with the caller's own token answers 200 with the
// user only while the token's session exists and the user exists.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "@zs/db";
import { formatEnvIssues, secureUrlProblem } from "./auth.js";

export interface SessionCheckInput {
  /** The compact JWT, already verified. */
  readonly token: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly sessionId: string;
  /** The token's `exp`, in seconds since the epoch; no answer is cached beyond it. */
  readonly expiresAt: number;
}

export interface SessionCheck {
  /** True while the session is live; false once it ended. Throws AuthUnavailable when it cannot tell. */
  isLive(input: SessionCheckInput): Promise<boolean>;
}

/** Supabase Auth could not answer. The edge fails closed with 500, never 401, so a browser keeps its cookies. */
export class AuthUnavailable extends Error {
  constructor() {
    super("Supabase Auth did not answer the session check");
    this.name = "AuthUnavailable";
  }
}

export interface SupabaseSessionCheckOptions {
  /** The project URL, e.g. https://<ref>.supabase.co. */
  readonly supabaseUrl: string;
  /** The project's anon (publishable) key; Supabase Auth requires it as `apikey`. */
  readonly anonKey: string;
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
  /** How long a live answer is reused, 0 to 30 seconds. Sign-out takes at most this long to bite. */
  readonly cacheSeconds?: number;
  readonly timeoutMs?: number;
  /** Bound on cached answers; the oldest goes first. */
  readonly maxCacheEntries?: number;
}

export const DEFAULT_SESSION_CACHE_SECONDS = 5;
export const MAX_SESSION_CACHE_SECONDS = 30;

const userSchema = z.object({
  id: z.string(),
  banned_until: z.string().nullish(),
  deleted_at: z.string().nullish(),
});

export function createSupabaseSessionCheck(options: SupabaseSessionCheckOptions): SessionCheck {
  const cacheSeconds = options.cacheSeconds ?? DEFAULT_SESSION_CACHE_SECONDS;
  if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0 || cacheSeconds > MAX_SESSION_CACHE_SECONDS)
    throw new Error(`Session cache must be 0 to ${MAX_SESSION_CACHE_SECONDS} whole seconds`);
  const maxEntries = options.maxCacheEntries ?? 10_000;
  const endpoint = new URL("/auth/v1/user", options.supabaseUrl).href;
  const doFetch = options.fetch ?? fetch;
  // Keyed by a hash of the token, so the cache never holds a usable credential.
  const live = new Map<string, number>();
  const now = () => options.clock.now().getTime();

  async function ask(input: SessionCheckInput): Promise<boolean> {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        headers: { Authorization: `Bearer ${input.token}`, apikey: options.anonKey, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
    } catch {
      throw new AuthUnavailable();
    }
    // 401/403 (session_not_found, bad_jwt, user_banned) and 404 (user_not_found): the session is over.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw new AuthUnavailable();
    }
    let user: z.infer<typeof userSchema>;
    try {
      user = userSchema.parse(await response.json());
    } catch {
      throw new AuthUnavailable();
    }
    if (user.id !== input.actorId || user.deleted_at) return false;
    return !user.banned_until || Date.parse(user.banned_until) <= now();
  }

  return {
    async isLive(input) {
      const key = createHash("sha256").update(input.token).digest("base64url");
      const cachedUntil = live.get(key);
      if (cachedUntil !== undefined) {
        if (cachedUntil > now()) return true;
        live.delete(key);
      }
      const answer = await ask(input);
      // Only live answers are reused, never past the token's own expiry.
      const until = Math.min(now() + cacheSeconds * 1000, input.expiresAt * 1000);
      if (answer && cacheSeconds > 0 && until > now()) {
        if (live.size >= maxEntries) live.delete(live.keys().next().value!);
        live.set(key, until);
      }
      return answer;
    },
  };
}

/**
 * Local only: asks the loopback auth stub (@zs/db/testing installAuthStub), whose
 * zs_local_auth.session_is_live reads the stub's auth tables. Production never selects it:
 * entry points allow it only with a loopback database.
 */
export function createLocalStubSessionCheck(db: { tenant<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> }, clock: { now(): Date }) {
  return {
    async isLive(input: SessionCheckInput): Promise<boolean> {
      const row = await db.tenant(input.tenantId, async (tx) => (await tx.query<{ live: boolean }>(
        "SELECT zs_local_auth.session_is_live($1, $2, $3) AS live", [input.sessionId, input.actorId, clock.now()],
      )).rows[0]);
      return row?.live === true;
    },
  } satisfies SessionCheck;
}

// ---------------------------------------------------------------------------------------------
// Configuration. Entry points pass their environment object in; this module never reads it.

export const SESSION_CHECKS = ["supabase", "local-stub"] as const;
export type SessionCheckConfig =
  | { readonly method: "supabase"; readonly supabaseUrl: string; readonly anonKey: string; readonly cacheSeconds: number }
  | { readonly method: "local-stub" };

/**
 * SESSION_CHECK is a required choice. `supabase` (every hosted deploy) needs SUPABASE_URL and
 * SUPABASE_ANON_KEY; SESSION_CACHE_SECONDS (default 5, at most 30) bounds how long a live answer
 * is reused. `local-stub` reads the loopback auth stub; entry points refuse it unless their
 * database is on loopback.
 */
export const sessionCheckEnvSchema = z.object({
  SESSION_CHECK: z.enum(SESSION_CHECKS, { error: "SESSION_CHECK must be supabase or local-stub" }),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SESSION_CACHE_SECONDS: z.coerce.number().int().min(0).max(MAX_SESSION_CACHE_SECONDS).default(DEFAULT_SESSION_CACHE_SECONDS),
}).transform((env, ctx): SessionCheckConfig => {
  if (env.SESSION_CHECK === "local-stub") return { method: "local-stub" };
  let ok = true;
  const problem = env.SUPABASE_URL === undefined ? "SUPABASE_URL is required when SESSION_CHECK=supabase" : secureUrlProblem("SUPABASE_URL", env.SUPABASE_URL);
  if (problem) {
    ctx.addIssue({ code: "custom", path: ["SUPABASE_URL"], message: problem });
    ok = false;
  }
  if (!env.SUPABASE_ANON_KEY) {
    ctx.addIssue({ code: "custom", path: ["SUPABASE_ANON_KEY"], message: "SUPABASE_ANON_KEY is required when SESSION_CHECK=supabase" });
    ok = false;
  }
  if (!ok) return z.NEVER;
  return { method: "supabase", supabaseUrl: env.SUPABASE_URL!, anonKey: env.SUPABASE_ANON_KEY!, cacheSeconds: env.SESSION_CACHE_SECONDS };
});

/** Parse the session-check variables from an environment object passed in by an entry point. */
export function parseSessionCheckEnv(env: Readonly<Record<string, string | undefined>>): SessionCheckConfig {
  const parsed = sessionCheckEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(formatEnvIssues(parsed.error.issues));
  return parsed.data;
}

export function createSessionCheckFromConfig(
  config: SessionCheckConfig,
  deps: { db: Parameters<typeof createLocalStubSessionCheck>[0]; clock: { now(): Date }; fetch?: typeof fetch },
): SessionCheck {
  if (config.method === "local-stub") return createLocalStubSessionCheck(deps.db, deps.clock);
  return createSupabaseSessionCheck({
    supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, cacheSeconds: config.cacheSeconds, clock: deps.clock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
