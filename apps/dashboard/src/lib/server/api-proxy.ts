/**
 * Same-origin proxy from the dashboard to apps/api. The browser calls /api/v1/...; this
 * server reads the person's Supabase session from httpOnly cookies, refreshes it when it is
 * about to expire, and sends that person's own access token upstream. The API then checks
 * the token, that its session is still live and that the person is a member of the business.
 * A caller's own Authorization header is ignored. Only the booking, CRM, intake, member,
 * approval, source, inbox, home, agent, business, site, calendar and website-task (/v1/browser) routes and /v1/me are
 * forwarded (for example /v1/approvals/:id/approve, /v1/inbox/threads, PUT /v1/business, PUT /v1/agents/followup/settings
 * and a run's file download, GET /v1/browser/runs/:id/artifacts/:artifactId); never the runner's /browser-runner/v1. Only
 * from this origin: other sites cannot make a signed-in browser spend its session here. Starting a
 * Google Calendar connection also binds the flow to this browser, and reading or confirming a
 * staged grant sends the API the grant this browser holds (calendar-connect.ts).
 */
import { DOCUMENT_INTAKE_APPLY_PATH, INTAKE_APPLY_BODY_LIMIT, PENDING_GRANT_HEADER, type ApiErrorCode } from "@zs/contracts";
import { demoErrorBody } from "../api/errors";
import { readBoundedBody, type BodyTiming } from "./body";
import { bindConnectStart, expiredGrantCookie, isConnectStart, namesGrant, pendingGrantOf, readsPendingGrant } from "./calendar-connect";
import { reportSetupProblem, type LiveSetup } from "./live-config";
import { isSameOrigin } from "./origin";
import { authFor, lookupSession, type AuthContext } from "./supabase";

export { isSameOrigin } from "./origin";
export { liveSetupFromEnv } from "./live-config";

const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Areas with sub-paths, and the single-segment routes. */
const AREAS = new Set(["booking", "crm", "intake", "members", "approvals", "sources", "inbox", "home", "agents", "sites", "calendar", "transcriptions", "document-intake", "browser"]);
const SINGLE = new Set(["me", "members", "approvals", "sources", "sites", "business", "transcriptions", "browser"]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
/** Methods that carry a JSON body. */
const WITH_BODY = new Set(["POST", "PUT"]);
const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key"];
/** Passed back as the API set them: a website-task file is a download, never rendered here. */
const RESPONSE_HEADERS = ["content-type", "content-disposition", "x-content-type-options"];
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
  // Only from this browser's cookie; a caller's own header never gets through (REQUEST_HEADERS).
  const readsGrant = readsPendingGrant(request.method, path);
  const grant = readsGrant ? pendingGrantOf(request) : undefined;
  if (grant !== undefined) headers.set(PENDING_GRANT_HEADER, grant);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (WITH_BODY.has(request.method)) {
    // A cross-site form can only send simple content types; JSON needs a CORS preflight.
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return auth.finish(reply(400, "ValidationFailed"));
    // Never more than the route's limit in memory, and never a slow upload held open for long. The intake
    // apply request lists up to 5,000 row IDs (document-intake.md DL-13); every other route keeps 64 KiB.
    const maxBytes = DOCUMENT_INTAKE_APPLY_PATH.test(`/${path.join("/")}`) ? INTAKE_APPLY_BODY_LIMIT : MAX_BODY_BYTES;
    const read = await readBoundedBody(request, { maxBytes, deadlineMs: BODY_DEADLINE_MS, ...timing });
    if (!read.ok) return auth.finish(reply(BODY_REFUSED[read.reason], "ValidationFailed"));
    body = read.bytes;
  }
  let setCookie: string | null = null;
  if (body && isConnectStart(request.method, path)) {
    const bound = bindConnectStart(request, body, config.trustProxy);
    if (!bound) return auth.finish(reply(400, "ValidationFailed"));
    body = bound.body;
    setCookie = bound.cookie;
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
  const response = await relay(upstream, auth);
  // The browser keeps its key only for a flow the API started.
  if (setCookie && upstream.ok) response.headers.append("Set-Cookie", setCookie);
  // A grant that connected, or that the API says is gone, foreign or no longer usable, is spent.
  // An outage or a lost answer keeps it, so the owner can try again, and so does a confirm of a
  // grant this one replaced: the page shows this one next.
  const confirmsThis = request.method !== "POST" || namesGrant(body, grant ?? "");
  if (grant !== undefined && confirmsThis && (upstream.ok && request.method === "POST" || [403, 404, 409].includes(upstream.status)))
    response.headers.append("Set-Cookie", expiredGrantCookie(request, config.trustProxy));
  return response;
}

async function relay(upstream: Response, auth: AuthContext): Promise<Response> {
  // The API refused the session (signed out elsewhere, expired, revoked): drop its cookies.
  if (upstream.status === 401) auth.clearAll();
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const empty = [204, 205, 304].includes(upstream.status);
  return auth.finish(new Response(empty ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders }));
}
