/**
 * Who the dashboard is acting for. The server holds the API token, so it is the only place
 * that can say which tenant the cached data belongs to; the browser asks /api/session and
 * never reads a token itself. The API still verifies the token on every call — this only
 * reads its claims to label the cache.
 */
import { z } from "zod";
import { proxyConfigFromEnv } from "./api-proxy";
import { checkSession, reportGateProblem } from "./pilot-gate";

const Claims = z.object({
  sub: z.string().min(1),
  exp: z.number().optional(),
  app_metadata: z.object({ tenant_id: z.string().min(1) }),
});

export interface SessionIdentity {
  tenantId: string;
  userId: string;
}

export type SessionResult =
  | { status: "signed_in"; identity: SessionIdentity }
  | { status: "signed_out"; reason?: "expired" }
  | { status: "unconfigured" }
  | { status: "misconfigured" };

function decodePayload(token: string): unknown {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function readSession(token: string | undefined, now: Date = new Date()): SessionResult {
  const value = token?.trim();
  if (!value) return { status: "unconfigured" };
  const claims = Claims.safeParse(decodePayload(value));
  if (!claims.success) return { status: "signed_out" };
  if (claims.data.exp !== undefined && claims.data.exp * 1000 <= now.getTime()) return { status: "signed_out" };
  return { status: "signed_in", identity: { tenantId: claims.data.app_metadata.tenant_id, userId: claims.data.sub } };
}

const NO_STORE = { "Cache-Control": "no-store" };

export function sessionResponse(result: SessionResult): Response {
  if (result.status === "signed_in") return Response.json(result.identity, { headers: NO_STORE });
  if (result.status === "signed_out") return Response.json({ error: result.reason ?? "signed_out" }, { status: 401, headers: NO_STORE });
  return Response.json({ error: result.status }, { status: 503, headers: NO_STORE });
}

/**
 * GET /api/session. In live mode the pilot session cookie comes first: without a valid one
 * the answer is 401 and the token's claims are never read. A missing cookie is "signed_out";
 * a forged, stale or expired one is "expired".
 */
export function sessionForRequest(request: Request, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Response {
  const config = proxyConfigFromEnv(env);
  if (!config) return sessionResponse({ status: "unconfigured" });
  if (!config.gate.ok) {
    reportGateProblem(config.gate.problem);
    return sessionResponse({ status: "misconfigured" });
  }
  const cookie = checkSession(request, config.gate.config, now);
  if (cookie === "missing") return sessionResponse({ status: "signed_out" });
  if (cookie !== "valid") return sessionResponse({ status: "signed_out", reason: "expired" });
  return sessionResponse(readSession(config.token, now));
}
