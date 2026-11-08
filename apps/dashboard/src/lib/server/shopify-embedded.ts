/**
 * The dashboard's half of the embedded app's calls (docs/requirements/connections.md C-21): POST /api/shopify/<op>
 * forwards the App Bridge session token, as a bearer, to the API's /public/v1/shopify/embedded/<op>. The dashboard
 * checks nothing about the token and holds no state: the worker alone verifies it. No cookie is read or set, and a
 * caller's own cookies are never forwarded. The owner's claim calls are different: they carry a hub session and go
 * through the generic proxy (api-proxy.ts).
 */
import { shopifyIdTokenSchema, type ApiErrorCode } from "@zs/contracts";
import { demoErrorBody } from "../api/errors";
import { readBoundedBody, type BodyTiming } from "./body";
import { trustProxyFromEnv } from "./live-config";
import { isSameOrigin } from "./origin";

export const EMBEDDED_OPS: ReadonlySet<string> = new Set(["open", "create-hub", "sign-in", "redeem-claim"]);
const MAX_BODY_BYTES = 2048;
const BODY_DEADLINE_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const BODY_REFUSED = { too_large: 413, timeout: 408, failed: 400 } as const;
const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

// App Bridge retries a call once with a fresh token when a 401 carries this header (shopify.dev session-tokens).
const RETRY_INVALID_SESSION = { "X-Shopify-Retry-Invalid-Session-Request": "1" };

const reply = (status: number, code: ApiErrorCode, extra: Record<string, string> = {}) =>
  Response.json(demoErrorBody(code), { status, headers: { ...NO_STORE, ...(status === 401 ? RETRY_INVALID_SESSION : {}), ...extra } });

export interface EmbeddedConfig {
  readonly apiUrl: string;
  readonly trustProxy: boolean;
  readonly fetch?: typeof fetch;
}

/** The API address and proxy setting from the given variables; null when this dashboard has no live API (demo mode). */
export function embeddedConfigFrom(vars: Record<string, string | undefined>): EmbeddedConfig | null {
  const apiUrl = vars.ZS_API_URL?.trim().replace(/\/+$/, "");
  if (!apiUrl) return null;
  return { apiUrl, trustProxy: trustProxyFromEnv(vars) };
}

export async function proxyEmbedded(request: Request, op: string, config: EmbeddedConfig | null, timing: BodyTiming = {}): Promise<Response> {
  if (config === null || !EMBEDDED_OPS.has(op)) return reply(404, "NotFound");
  if (request.method !== "POST") return reply(404, "NotFound", { Allow: "POST" });
  if (!isSameOrigin(request, config.trustProxy)) return reply(403, "Forbidden");

  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  const token = shopifyIdTokenSchema.safeParse(match?.[1]);
  if (!token.success) return reply(401, "Unauthorized");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(400, "ValidationFailed");

  const read = await readBoundedBody(request, { maxBytes: MAX_BODY_BYTES, deadlineMs: BODY_DEADLINE_MS, ...timing });
  if (!read.ok) return reply(BODY_REFUSED[read.reason], "ValidationFailed");

  const headers = new Headers({ Authorization: `Bearer ${token.data}`, "Content-Type": "application/json" });
  // The API limits by caller address; behind a trusted proxy the browser's address is the first entry we were given.
  const forwarded = config.trustProxy ? request.headers.get("x-forwarded-for") : null;
  if (forwarded) headers.set("X-Forwarded-For", forwarded);

  let upstream: Response;
  try {
    upstream = await (config.fetch ?? fetch)(`${config.apiUrl}/public/v1/shopify/embedded/${op}`, {
      method: "POST",
      headers,
      body: read.bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return reply(502, "Internal");
  }
  const response = new Response([204, 205, 304].includes(upstream.status) ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: { ...NO_STORE, ...(upstream.status === 401 ? RETRY_INVALID_SESSION : {}), "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
  const retry = upstream.headers.get("retry-after");
  if (retry !== null && /^\d{1,6}$/.test(retry)) response.headers.set("Retry-After", retry);
  return response;
}
