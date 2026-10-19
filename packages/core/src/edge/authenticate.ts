// The one authentication step every edge runs before it reads or writes: the HTTP API once
// per request, the MCP server once per tool call. Tenant and actor come only from the
// verified token, never from a request body or tool input.
import { TenantDenied } from "@zs/contracts";
import { findMembership, sessionIsLive } from "../members/access.js";
import type { TokenVerifier } from "./auth.js";
import { Unauthenticated } from "./errors.js";
import { createSession, type EdgeDependencies, type Session } from "./session.js";

/** The characters of a compact JWS; anything else is refused before verification. */
const BEARER_TOKEN = /^[A-Za-z0-9_\-.]+$/;

/**
 * Verify the token against the injected clock (Unauthenticated, 401, when it is missing,
 * forged or expired), then in one tenant transaction require that its Supabase session is
 * still live (Unauthenticated: sign-out deletes the session) and that the user is a member of
 * the tenant the token claims (TenantDenied, 403). Returns the edge session, which re-checks
 * the membership and the role each read or action needs inside its own transaction.
 */
export async function authenticate(deps: EdgeDependencies, verifier: TokenVerifier, bearerToken: string): Promise<Session> {
  if (!BEARER_TOKEN.test(bearerToken)) throw new Unauthenticated();
  const token = await verifier.verify(bearerToken);
  const access = await deps.db.tenant(token.tenantId, async (tx) => ({
    live: await sessionIsLive(tx, token.sessionId, token.actorId, deps.clock.now()),
    member: await findMembership(tx, token.tenantId, token.actorId),
  }));
  if (!access.live) throw new Unauthenticated("Session has ended");
  if (!access.member) throw new TenantDenied();
  return createSession(deps, { tenantId: token.tenantId, actorId: token.actorId });
}
