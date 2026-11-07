/**
 * The dashboard half of a managed-tier connect flow (docs/requirements/connections.md C-4, C-5). Like the
 * Google Calendar flow (calendar-connect.ts) it binds the flow to the browser that started it, and the
 * callback stages a grant the owner confirms; unlike it, the provider's redirect carries no state, so the
 * API's signed attempt token travels in a cookie too. Three cookies, all under /api/connections
 * (connections-cookies.ts), and a handler per route:
 *
 * - POST   /api/connections/:toolkit/connect  start: binds the browser key, sets the cookies on an API 200
 * - GET    /api/connections/callback          the provider's redirect back; lands on the Connections page
 * - GET    /api/connections/callback/status   the page polls this while the provider has not answered
 * - GET    /api/connections/pending           what the grant names, for the confirm screen
 * - DELETE /api/connections/pending           the owner declines
 * - POST   /api/connections/confirm           the owner confirms
 *
 * Plain reads and the disconnect go through the generic proxy (api-proxy.ts). The page never sees the
 * attempt or the grant: they live in httpOnly cookies and reach the API only as headers set here.
 */
import { randomBytes } from "node:crypto";
import {
  CONNECT_ATTEMPT_HEADER,
  CONNECT_ATTEMPT_PATTERN,
  CONNECT_BROWSER_KEY_HEADER,
  CONNECT_GRANT_HEADER,
  CONNECT_GRANT_PATTERN,
  connectConnectionResponseSchema,
  connectErrorReasonSchema,
  toolkitSchema,
  type ApiErrorCode,
} from "@zs/contracts";
import { demoErrorBody } from "../api/errors";
import { readBoundedBody, type BodyTiming } from "./body";
import {
  ATTEMPT_COOKIE,
  BROWSER_COOKIE,
  GRANT_COOKIE,
  attemptOf,
  bindingOf,
  browserKeyOf,
  connectCookie,
  expiredConnectCookie,
  grantOf,
  namesGrant,
} from "./connections-cookies";
import { isHttps, reportSetupProblem, trustProxyFromEnv, type LiveConfig, type LiveSetup } from "./live-config";
import { isSameOrigin } from "./origin";
import { authFor, lookupSession, type AuthContext } from "./supabase";

/** Where the owner lands, with `connection` and `reason` saying what happened. */
export const CONNECTIONS_RETURN_PATH = "/account/connections";
/** The provider's redirect carries two short ids; anything longer is not from it. */
const MAX_PARAM_LENGTH = 2048;
const MAX_BODY_BYTES = 64 * 1024;
const BODY_DEADLINE_MS = 15_000;
const BODY_REFUSED = { too_large: 413, timeout: 408, failed: 400 } as const;
const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** The callback lands in a browser: nothing may cache it, and the query must not leak as a Referer. */
const LANDING_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
/** What the page is told when the API's answer is not one it knows. */
const UNAVAILABLE = "unavailable";

const reply = (status: number, code: ApiErrorCode, extra: Record<string, string> = {}) =>
  Response.json(demoErrorBody(code), { status, headers: { ...NO_STORE, ...extra } });

/** The dashboard has nothing to connect in demo mode. */
const notFound = () => reply(404, "NotFound");

interface Ready {
  readonly config: LiveConfig;
  readonly auth: AuthContext;
  readonly bearer: string;
  readonly secure: boolean;
}

/** Method, setup, same-origin check and the signed-in session, in that order; or the response that refuses. */
async function ready(request: Request, setup: LiveSetup | null, method: string): Promise<Ready | Response> {
  if (!setup) return notFound();
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return reply(503, "Internal");
  }
  const config = setup.config;
  if (request.method !== method) return reply(405, "NotFound", { Allow: method });
  if (!isSameOrigin(request, config.trustProxy)) return reply(403, "Forbidden");
  const auth = authFor(request, config);
  const lookup = await lookupSession(auth);
  if (lookup.status === "unavailable") return auth.finish(reply(502, "Internal"));
  if (lookup.status === "signed_out") return auth.finish(reply(401, "Unauthorized"));
  return { config, auth, bearer: lookup.session.access_token, secure: isHttps(request, config.trustProxy) };
}

async function callApi(
  ctx: Ready,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> },
): Promise<Response | null> {
  const headers = new Headers({ Authorization: `Bearer ${ctx.bearer}`, Accept: "application/json", ...init.headers });
  try {
    return await (ctx.config.fetch ?? fetch)(`${ctx.config.apiUrl}${path}`, {
      method: init.method,
      headers,
      ...(init.body ? { body: init.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.config.timeoutMs ?? 15_000),
    });
  } catch {
    return null;
  }
}

/**
 * The API's answer as the page gets it: its status, body and type, `Retry-After` for a refusal, and no
 * cookie of the API's own. A 401 means the API refused the session, so every cookie goes with it (C-5).
 */
async function relay(upstream: Response, ctx: Ready, cookies: readonly string[] = []): Promise<Response> {
  if (upstream.status === 401) ctx.auth.clearAll();
  const headers = new Headers(NO_STORE);
  for (const name of ["content-type", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const empty = [204, 205, 304].includes(upstream.status);
  const response = new Response(empty ? null : await upstream.arrayBuffer(), { status: upstream.status, headers });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return ctx.auth.finish(response);
}

/** A JSON body of at most 64 KiB from a request that says it is JSON (a cross-site form cannot send that). */
async function jsonBody(request: Request, timing: BodyTiming): Promise<Uint8Array<ArrayBuffer> | Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(400, "ValidationFailed");
  const read = await readBoundedBody(request, { maxBytes: MAX_BODY_BYTES, deadlineMs: BODY_DEADLINE_MS, ...timing });
  return read.ok ? read.bytes : reply(BODY_REFUSED[read.reason], "ValidationFailed");
}

/**
 * POST /api/connections/:toolkit/connect. Sends the API the connect body with `browserBinding` set from this
 * browser's key (a binding the page sent is replaced, never trusted), and answers with the provider's address
 * only. The browser key and the attempt go into cookies only when the API answered 200 with a well-formed
 * attempt, so a refused start leaves nothing behind (C-4).
 */
export async function startManagedConnect(request: Request, setup: LiveSetup | null, toolkit: string, timing: BodyTiming = {}): Promise<Response> {
  const ctx = await ready(request, setup, "POST");
  if (ctx instanceof Response) return ctx;
  if (!toolkitSchema.safeParse(toolkit).success) return ctx.auth.finish(notFound());
  const bytes = await jsonBody(request, timing);
  if (bytes instanceof Response) return ctx.auth.finish(bytes);
  let given: unknown;
  try {
    given = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return ctx.auth.finish(reply(400, "ValidationFailed"));
  }
  if (given === null || typeof given !== "object" || Array.isArray(given)) return ctx.auth.finish(reply(400, "ValidationFailed"));
  const key = browserKeyOf(request) ?? randomBytes(32).toString("base64url");
  const body = new TextEncoder().encode(JSON.stringify({ ...given, browserBinding: bindingOf(key) })) as Uint8Array<ArrayBuffer>;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency !== null) headers["Idempotency-Key"] = idempotency;

  const upstream = await callApi(ctx, `/v1/connections/${toolkit}/connect`, { method: "POST", headers, body });
  if (!upstream) return ctx.auth.finish(reply(502, "Internal"));
  if (upstream.status !== 200) return relay(upstream, ctx);
  const attempt = upstream.headers.get(CONNECT_ATTEMPT_HEADER);
  let answer: ReturnType<typeof connectConnectionResponseSchema.safeParse> | undefined;
  try {
    answer = connectConnectionResponseSchema.safeParse(await upstream.json());
  } catch {
    answer = undefined;
  }
  if (attempt === null || !CONNECT_ATTEMPT_PATTERN.test(attempt) || !answer?.success) return ctx.auth.finish(reply(502, "Internal"));
  const response = Response.json({ authorizeUrl: answer.data.authorizeUrl }, { status: 200, headers: NO_STORE });
  response.headers.append("Set-Cookie", connectCookie(BROWSER_COOKIE, key, ctx.secure));
  response.headers.append("Set-Cookie", connectCookie(ATTEMPT_COOKIE, attempt, ctx.secure));
  // Last start wins: a grant an earlier flow staged belongs to an attempt this one replaced.
  response.headers.append("Set-Cookie", expiredConnectCookie(GRANT_COOKIE, ctx.secure));
  return ctx.auth.finish(response);
}

export type CallbackOutcome =
  | { readonly connection: "connected" | "pending" }
  | { readonly connection: "confirm"; readonly grant: string }
  | { readonly connection: "error"; readonly reason: string };

/**
 * What the API's callback or status answer says. Only the outcome of its redirect is used, never its address,
 * and a reason or a grant only in a form this server knows. Anything else is "unavailable".
 */
function outcomeOf(upstream: Response): CallbackOutcome {
  // No valid attempt: the API will not say where the caller came from (C-5).
  if (upstream.status === 400) return { connection: "error", reason: "invalid_attempt" };
  const location = upstream.status === 303 ? URL.parse(upstream.headers.get("location") ?? "") : null;
  const connection = location?.searchParams.get("connection");
  if (connection === "connected" || connection === "pending") return { connection };
  const grant = upstream.headers.get(CONNECT_GRANT_HEADER);
  if (connection === "confirm" && grant !== null && CONNECT_GRANT_PATTERN.test(grant)) return { connection, grant };
  const reason = connectErrorReasonSchema.safeParse(location?.searchParams.get("reason"));
  if (connection === "error" && reason.success) return { connection, reason: reason.data };
  return { connection: "error", reason: UNAVAILABLE };
}

/** The API's callback or status route with this browser's attempt and key; null when the API cannot be reached. */
async function askCallback(config: LiveConfig, request: Request, route: "callback" | "callback/status", attempt: string): Promise<Response | null> {
  const given = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  if (route === "callback") {
    for (const name of ["connected_account_id", "session_uri"]) {
      const value = given.get(name);
      if (value !== null) query.set(name, value.slice(0, MAX_PARAM_LENGTH));
    }
  }
  const headers = new Headers({ Accept: "application/json", [CONNECT_ATTEMPT_HEADER]: attempt });
  const key = browserKeyOf(request);
  if (key !== undefined) headers.set(CONNECT_BROWSER_KEY_HEADER, key);
  try {
    return await (config.fetch ?? fetch)(`${config.apiUrl}/oauth/connections/${route}?${query}`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch {
    return null;
  }
}

/**
 * Reasons that leave the attempt standing (C-5). `attempt_changed`: the cookie holds a newer attempt that
 * this answer says nothing about. The others are failures to reach or finish the check, so the same attempt
 * may still succeed. `unavailable` is this server's own word for an answer it could not read or get.
 */
const ATTEMPT_STANDS = new Set(["attempt_changed", "rate_limited", "provider_unavailable", UNAVAILABLE]);

/**
 * The cookies an outcome leaves. A staged grant is kept for the owner to confirm; a pending answer changes
 * nothing; a flow that is over (connected, or refused for good) drops its attempt and any grant left over from
 * an earlier flow. An answer that says nothing about this attempt leaves both cookies as they are.
 */
function outcomeCookies(outcome: CallbackOutcome, secure: boolean): string[] {
  if (outcome.connection === "confirm") return [connectCookie(GRANT_COOKIE, outcome.grant, secure)];
  if (outcome.connection === "pending") return [];
  if (outcome.connection === "error" && ATTEMPT_STANDS.has(outcome.reason)) return [];
  return [expiredConnectCookie(ATTEMPT_COOKIE, secure), expiredConnectCookie(GRANT_COOKIE, secure)];
}

function landing(outcome: CallbackOutcome, cookies: readonly string[]): Response {
  const search = new URLSearchParams({ connection: outcome.connection });
  if (outcome.connection === "error") search.set("reason", outcome.reason);
  const response = new Response(null, { status: 303, headers: { Location: `${CONNECTIONS_RETURN_PATH}?${search}`, ...LANDING_HEADERS } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/**
 * GET /api/connections/callback: hand the provider's answer, this browser's attempt and its key to the API and
 * send the owner to the Connections page with the outcome. The provider's redirect is a cross-site navigation,
 * so this route needs no session: the signed attempt and the browser key are what bind it (C-5). A staged grant
 * goes into GRANT_COOKIE, never into the address.
 */
export async function completeManagedConnect(request: Request, setup: LiveSetup | null): Promise<Response> {
  if (!setup) return Response.json(demoErrorBody("NotFound"), { status: 404, headers: LANDING_HEADERS });
  if (request.method !== "GET") return reply(405, "NotFound", { Allow: "GET" });
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return landing({ connection: "error", reason: UNAVAILABLE }, []);
  }
  const secure = isHttps(request, setup.config.trustProxy);
  const attempt = attemptOf(request);
  // No attempt cookie: another browser, or an expired flow. The API would say the same.
  if (attempt === undefined) return landing({ connection: "error", reason: "invalid_attempt" }, []);
  const upstream = await askCallback(setup.config, request, "callback", attempt);
  const outcome: CallbackOutcome = upstream ? outcomeOf(upstream) : { connection: "error", reason: UNAVAILABLE };
  return landing(outcome, outcomeCookies(outcome, secure));
}

/**
 * GET /api/connections/callback/status: the page asks again while the provider has not finished (the callback
 * answered "pending"). Same-origin and signed in, like the other routes the page calls; answers
 * `{ connection, reason? }` as JSON and stages a grant the same way the callback does.
 */
export async function managedConnectStatus(request: Request, setup: LiveSetup | null): Promise<Response> {
  const ctx = await ready(request, setup, "GET");
  if (ctx instanceof Response) return ctx;
  const attempt = attemptOf(request);
  const upstream = attempt === undefined ? null : await askCallback(ctx.config, request, "callback/status", attempt);
  const outcome: CallbackOutcome = attempt === undefined
    ? { connection: "error", reason: "invalid_attempt" }
    : upstream ? outcomeOf(upstream) : { connection: "error", reason: UNAVAILABLE };
  const response = Response.json(outcome.connection === "error" ? outcome : { connection: outcome.connection }, { status: 200, headers: NO_STORE });
  for (const cookie of outcomeCookies(outcome, ctx.secure)) response.headers.append("Set-Cookie", cookie);
  return ctx.auth.finish(response);
}

/**
 * GET /api/connections/pending: what the staged grant names, for the confirm screen. The grant goes upstream
 * only from this browser's cookie. The API saying there is none (404) means the cookie is spent.
 */
export async function readPendingConnection(request: Request, setup: LiveSetup | null): Promise<Response> {
  const ctx = await ready(request, setup, "GET");
  if (ctx instanceof Response) return ctx;
  const grant = grantOf(request);
  if (grant === undefined) return ctx.auth.finish(notFound());
  const upstream = await callApi(ctx, "/v1/connections/pending", { method: "GET", headers: { [CONNECT_GRANT_HEADER]: grant } });
  if (!upstream) return ctx.auth.finish(reply(502, "Internal"));
  return relay(upstream, ctx, upstream.status === 404 ? [expiredConnectCookie(GRANT_COOKIE, ctx.secure)] : []);
}

/**
 * DELETE /api/connections/pending: the owner declines. Same origin and signed in. Both cookies go upstream (the
 * grant names the attempt that staged it, which the API prefers over the attempt cookie). The cookies are
 * dropped only once the API has answered 2xx, or 404 (nothing left to cancel), so any other refusal or a lost
 * answer reaches the page with the cookies still there to try again. Answers the API's body
 * (`{ cancelled, revokeFailed }`). With nothing to send, or no live settings, it only drops what is here.
 */
export async function cancelPendingConnection(request: Request, setup: LiveSetup | null): Promise<Response> {
  if (!setup) return notFound();
  const trustProxy = setup.ok ? setup.config.trustProxy : trustProxyFromEnv();
  if (request.method !== "DELETE") return reply(405, "NotFound", { Allow: "DELETE" });
  if (!isSameOrigin(request, trustProxy)) return reply(403, "Forbidden");
  const secure = isHttps(request, trustProxy);
  const drop = [expiredConnectCookie(GRANT_COOKIE, secure), expiredConnectCookie(ATTEMPT_COOKIE, secure)];
  const attempt = attemptOf(request);
  const grant = grantOf(request);
  if (!setup.ok || (attempt === undefined && grant === undefined)) {
    const response = new Response(null, { status: 204, headers: NO_STORE });
    for (const cookie of drop) response.headers.append("Set-Cookie", cookie);
    return response;
  }
  const ctx = await ready(request, setup, "DELETE");
  if (ctx instanceof Response) return ctx;
  const headers: Record<string, string> = {};
  if (grant !== undefined) headers[CONNECT_GRANT_HEADER] = grant;
  if (attempt !== undefined) headers[CONNECT_ATTEMPT_HEADER] = attempt;
  const upstream = await callApi(ctx, "/v1/connections/pending", { method: "DELETE", headers });
  if (!upstream) return ctx.auth.finish(reply(502, "Internal"));
  return relay(upstream, ctx, upstream.ok || upstream.status === 404 ? drop : []);
}

/**
 * POST /api/connections/confirm: the owner confirms the staged grant. The grant goes upstream only from this
 * browser's cookie. It is spent when it connected, or when the API says it is gone, foreign or no longer
 * usable (2xx, 403, 404, 409) and the body names it. The attempt cookie is left for the callback to finish. An outage or a lost answer keeps it, so the owner can try
 * again, and so does a confirm of a grant this one replaced: the page shows this one next.
 */
export async function confirmManagedConnect(request: Request, setup: LiveSetup | null, timing: BodyTiming = {}): Promise<Response> {
  const ctx = await ready(request, setup, "POST");
  if (ctx instanceof Response) return ctx;
  const grant = grantOf(request);
  if (grant === undefined) return ctx.auth.finish(notFound());
  const bytes = await jsonBody(request, timing);
  if (bytes instanceof Response) return ctx.auth.finish(bytes);
  const headers: Record<string, string> = { "Content-Type": "application/json", [CONNECT_GRANT_HEADER]: grant };
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency !== null) headers["Idempotency-Key"] = idempotency;
  const upstream = await callApi(ctx, "/v1/connections/confirm", { method: "POST", headers, body: bytes });
  if (!upstream) return ctx.auth.finish(reply(502, "Internal"));
  const spent = namesGrant(bytes, grant) && (upstream.ok || [403, 404, 409].includes(upstream.status));
  // Only the grant: the attempt stays so that a reload of the callback still answers "connected" (C-5).
  return relay(upstream, ctx, spent ? [expiredConnectCookie(GRANT_COOKIE, ctx.secure)] : []);
}
