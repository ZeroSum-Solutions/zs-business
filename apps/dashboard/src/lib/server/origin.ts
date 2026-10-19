/**
 * Same-origin check for the dashboard's own routes. Live mode spends the signed-in person's
 * session on every proxied call, so a request another site makes the browser send must not pass.
 */

/**
 * True unless the request came from another site or origin. A browser marks every fetch
 * with Sec-Fetch-Site, and anything but "same-origin" is refused. The Origin is compared with
 * the host the browser asked for, not with request.url: Next builds that URL from its own bind
 * address (http://localhost:<port>), which differs from the browser's host on 127.0.0.1 or
 * behind a reverse proxy. X-Forwarded-Host counts only with DASHBOARD_TRUST_PROXY=1, since a
 * caller can send any X-Forwarded-Host and `next start` keeps it; otherwise Host decides.
 */
export function isSameOrigin(request: Request, trustProxy: boolean): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const forwarded = trustProxy ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = forwarded || request.headers.get("host") || new URL(request.url).host;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}
