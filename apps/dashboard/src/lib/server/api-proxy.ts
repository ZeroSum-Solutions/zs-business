/**
 * Same-origin proxy from the dashboard to apps/api. The browser calls /api/v1/...; this
 * server adds the bearer token from a server-only env var, so the token never ships in
 * page JS. Only the booking and CRM routes pass, only GET and POST, and only from this
 * origin: the token is ambient here, so a cross-site page must not be able to spend it.
 */
import type { ApiErrorCode } from "@zs/contracts";
import { demoErrorBody } from "../api/errors";

export interface ApiProxyConfig {
  /** apps/api base URL, e.g. http://localhost:8787. */
  apiUrl: string;
  /** Bearer JWT the server sends for the owner. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const AREAS = new Set(["booking", "crm"]);
const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key"];
const MAX_BODY_BYTES = 64 * 1024;

function reply(status: number, code: ApiErrorCode): Response {
  return Response.json(demoErrorBody(code), { status, headers: { "Cache-Control": "no-store" } });
}

/** True unless the browser says the request came from another site or origin. */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

/** Read the proxy settings from server env; null when the dashboard runs on demo data. */
export function proxyConfigFromEnv(env: Record<string, string | undefined> = process.env): ApiProxyConfig | null {
  const apiUrl = env.ZS_API_URL?.trim();
  const token = env.ZS_API_TOKEN?.trim();
  if (!apiUrl || !token) return null;
  return { apiUrl, token };
}

export async function proxyApiRequest(request: Request, path: readonly string[], config: ApiProxyConfig | null): Promise<Response> {
  if (!config) return reply(503, "Internal");
  if (request.method !== "GET" && request.method !== "POST") return reply(404, "NotFound");
  const [version, area, ...rest] = path;
  if (version !== "v1" || !area || !AREAS.has(area) || rest.length === 0 || !path.every((segment) => SEGMENT.test(segment))) {
    return reply(404, "NotFound");
  }
  if (!isSameOrigin(request)) return reply(403, "Forbidden");

  const headers = new Headers({ Authorization: `Bearer ${config.token}` });
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    // A cross-site form can only send simple content types; JSON needs a CORS preflight.
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(400, "ValidationFailed");
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return reply(413, "ValidationFailed");
  }

  const target = `${config.apiUrl.replace(/\/+$/, "")}/${path.join("/")}${new URL(request.url).search}`;
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
    return reply(502, "Internal");
  }

  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  const empty = [204, 205, 304].includes(upstream.status);
  return new Response(empty ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
}
