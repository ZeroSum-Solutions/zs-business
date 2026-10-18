/**
 * Who the dashboard is acting for. The server holds the API token, so it is the only place
 * that can say which tenant the cached data belongs to; the browser asks /api/session and
 * never reads a token itself. The API still verifies the token on every call — this only
 * reads its claims to label the cache.
 */
import { z } from "zod";

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
  | { status: "signed_out" }
  | { status: "unconfigured" };

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
  if (result.status === "signed_out") return Response.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  return Response.json({ error: "unconfigured" }, { status: 503, headers: NO_STORE });
}
