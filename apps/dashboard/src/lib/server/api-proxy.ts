/**
 * Same-origin proxy from the dashboard to apps/api. The browser calls /api/v1/...; this
 * server reads the person's Supabase session from httpOnly cookies, refreshes it when it is
 * about to expire, and sends that person's own access token upstream. The API then checks
 * the token, that its session is still live and that the person is a member of the business.
 * A caller's own Authorization header is ignored. Only the booking, CRM, intake, member,
 * approval, source and site routes and /v1/me are forwarded (for example /v1/approvals and
 * /v1/approvals/:id/approve), only from this origin: other sites cannot make a signed-in
 * browser spend its session here.
 */
import type { ApiErrorCode } from "@zs/contracts";
import { demoErrorBody } from "../api/errors";
import { readBoundedBody, type BodyTiming } from "./body";
import { reportSetupProblem, type LiveSetup } from "./live-config";
import { isSameOrigin } from "./origin";
import { authFor, lookupSession, type AuthContext } from "./supabase";

export { isSameOrigin } from "./origin";
export { liveSetupFromEnv } from "./live-config";

const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Areas with sub-paths, and the single-segment routes. */
const AREAS = new Set(["booking", "crm", "intake", "members", "approvals", "sources", "sites"]);
const SINGLE = new Set(["me", "members", "approvals", "sources", "sites"]);
const METHODS = new Set(["GET", "POST", "DELETE"]);
const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key"];
const MAX_BODY_BYTES = 64 * 1024;
/** How long a request body may take to arrive. */
const BODY_DEADLINE_MS = 15_000;
const BODY_REFUSED = { too_large: 413, timeout: 408, failed: 400 } as const;

function reply(status: number, code: ApiErrorCode): Response {
  return Response.json(demoErrorBody(code), { status, headers: { "Cache-Control": "no-store" } });
}

function routeAllowed(path: readonly string[]): boolean {
  const [version, area, ...rest] = path;
  if (version !== "v1" || !area || !path.every((segment) => SEGMENT.test(segment))) return false;
  return rest.length === 0 ? SINGLE.has(area) : AREAS.has(area);
}

export async function proxyApiRequest(request: Request, path: readonly string[], setup: LiveSetup | null, timing: BodyTiming = {}): Promise<Response> {
  if (!setup) return reply(503, "Internal");
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return reply(503, "Internal");
  }
  const config = setup.config;
  if (!METHODS.has(request.method) || !routeAllowed(path)) return reply(404, "NotFound");
  if (!isSameOrigin(request, config.trustProxy)) return reply(403, "Forbidden");

  const auth = authFor(request, config);
  const lookup = await lookupSession(auth);
  if (lookup.status === "unavailable") return auth.finish(reply(502, "Internal"));
  if (lookup.status === "signed_out") return auth.finish(reply(401, "Unauthorized"));

  const headers = new Headers({ Authorization: `Bearer ${lookup.session.access_token}` });
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.method === "POST") {
    // A cross-site form can only send simple content types; JSON needs a CORS preflight.
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return auth.finish(reply(400, "ValidationFailed"));
    // Never more than MAX_BODY_BYTES in memory, and never a slow upload held open for long.
    const read = await readBoundedBody(request, { maxBytes: MAX_BODY_BYTES, deadlineMs: BODY_DEADLINE_MS, ...timing });
    if (!read.ok) return auth.finish(reply(BODY_REFUSED[read.reason], "ValidationFailed"));
    body = read.bytes;
  }

  const target = `${config.apiUrl}/${path.join("/")}${new URL(request.url).search}`;
  let upstream: Response;
  try {
    upstream = await (config.fetch ?? fetch)(target, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch {
    return auth.finish(reply(502, "Internal"));
  }
  return relay(upstream, auth);
}

async function relay(upstream: Response, auth: AuthContext): Promise<Response> {
  // The API refused the session (signed out elsewhere, expired, revoked): drop its cookies.
  if (upstream.status === 401) auth.clearAll();
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  const empty = [204, 205, 304].includes(upstream.status);
  return auth.finish(new Response(empty ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders }));
}
