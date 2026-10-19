/**
 * Live-mode settings, read from server-only env at request time. With no ZS_API_URL the
 * dashboard runs on demo data and needs no sign-in. With one, every person signs in with
 * Supabase Auth (an email link), and the dashboard needs SUPABASE_URL and SUPABASE_ANON_KEY.
 * The anon key is public by design, but it stays on the server: the browser never talks to
 * Supabase, only to this server, which keeps the session in httpOnly cookies.
 */

export interface LiveConfig {
  /** apps/api base URL, e.g. http://localhost:8787. */
  apiUrl: string;
  /** Supabase project URL, e.g. https://<ref>.supabase.co. */
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** DASHBOARD_TRUST_PROXY=1: a reverse proxy in front sets X-Forwarded-Host and -Proto, and appends to -For. */
  trustProxy: boolean;
  /** Used for the API and for Supabase Auth; tests pass a fake. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The live settings, or the reason live mode must not serve. */
export type LiveSetup = { ok: true; config: LiveConfig } | { ok: false; problem: string };

type Env = Record<string, string | undefined>;

export function trustProxyFromEnv(env: Env = process.env): boolean {
  return env.DASHBOARD_TRUST_PROXY?.trim() === "1";
}

function httpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/** null in demo mode (no ZS_API_URL); otherwise the settings or what is missing. */
export function liveSetupFromEnv(env: Env = process.env): LiveSetup | null {
  const apiUrl = env.ZS_API_URL?.trim();
  if (!apiUrl) return null;
  const supabaseUrl = httpUrl(env.SUPABASE_URL?.trim());
  const supabaseAnonKey = env.SUPABASE_ANON_KEY?.trim() ?? "";
  if (!supabaseUrl) return { ok: false, problem: "Live mode needs SUPABASE_URL, the http(s) URL of the Supabase project." };
  if (supabaseAnonKey.length < 20) return { ok: false, problem: "Live mode needs SUPABASE_ANON_KEY, the project's anon (publishable) key." };
  return { ok: true, config: { apiUrl: apiUrl.replace(/\/+$/, ""), supabaseUrl, supabaseAnonKey, trustProxy: trustProxyFromEnv(env) } };
}

const reported = new Set<string>();
/** Say once in the server log why live mode refuses to serve. */
export function reportSetupProblem(problem: string) {
  if (reported.has(problem)) return;
  reported.add(problem);
  console.error(`[dashboard] ${problem} Live mode refuses every request until it is set.`);
}

/** True when the browser reached this server over https (the proxy says so only if trusted). */
export function isHttps(request: Request, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto) return proto === "https";
  }
  return new URL(request.url).protocol === "https:";
}

/**
 * The origin the browser used: X-Forwarded-Host and -Proto behind a trusted proxy, else the
 * Host header (Next builds request.url from its own bind address, not the browser's host).
 */
export function publicOrigin(request: Request, trustProxy: boolean): string {
  const forwarded = trustProxy ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = forwarded || request.headers.get("host") || new URL(request.url).host;
  return `${isHttps(request, trustProxy) ? "https" : "http"}://${host}`;
}

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}
