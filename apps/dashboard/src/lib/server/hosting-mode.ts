/**
 * Build and server must agree on the hosting mode. next.config.ts bakes NEXT_PUBLIC_API_MODE
 * into the build from ZS_API_URL; the server reads ZS_API_URL again at run time. A demo
 * build started with live settings would leave the browser on the demo adapter without a
 * word, and a live build started without them would send every call to a proxy that cannot
 * serve. Either way every request gets a 500 that says why, and the server log says it once.
 */
export function hostingModeProblem(builtMode: string | undefined, env: Record<string, string | undefined>): string | null {
  const builtLive = builtMode === "live";
  const serverLive = Boolean(env.ZS_API_URL?.trim());
  if (builtLive && !serverLive)
    return "This dashboard was built for live mode (ZS_API_URL set at build time), but the server has no ZS_API_URL. Set it, or rebuild without it for demo mode.";
  if (!builtLive && serverLive)
    return "This dashboard was built for demo mode (no ZS_API_URL at build time), but the server has ZS_API_URL set, so the browser would show demo data. Rebuild with ZS_API_URL set.";
  return null;
}

const reported = new Set<string>();
/** Logs a mismatch once per process and returns it, or null when build and server agree. */
export function reportHostingMode(builtMode: string | undefined, env: Record<string, string | undefined>, log: (line: string) => void = console.error): string | null {
  const problem = hostingModeProblem(builtMode, env);
  if (problem && !reported.has(problem)) {
    reported.add(problem);
    log(`[dashboard] Hosting mode mismatch: ${problem} Every request gets a 500 until build and server agree.`);
  }
  return problem;
}

/** The refusal for every request while the modes disagree; null when they agree. */
export function hostingModeGuard(builtMode: string | undefined, env: Record<string, string | undefined>, log?: (line: string) => void): Response | null {
  const problem = reportHostingMode(builtMode, env, log);
  if (!problem) return null;
  return new Response(`Dashboard misconfigured. ${problem}\n`, {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * A route handler behind the guard. The /api routes run it themselves because src/proxy.ts
 * skips them: a proxy in front of a route makes Next buffer the whole request body first, so
 * the routes' own body limits could not answer before the body arrived.
 */
export function withHostingModeGuard<Args extends unknown[]>(handler: (...args: Args) => Response | Promise<Response>) {
  return (...args: Args): Response | Promise<Response> =>
    hostingModeGuard(process.env.NEXT_PUBLIC_API_MODE, process.env) ?? handler(...args);
}
