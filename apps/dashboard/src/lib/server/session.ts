/**
 * GET /api/session: who the dashboard is acting for. The server holds the session, so it is
 * the only place that can say which business the cached data belongs to; the browser never
 * reads a token. The answer comes from the API's /v1/me with the person's own token, so it
 * also proves the session is live and the person is still a member.
 */
import { meResponseSchema } from "@zs/contracts";
import { jsonAnswer, reportSetupProblem, type LiveSetup } from "./live-config";
import { authFor, lookupSession } from "./supabase";

export interface SessionIdentity {
  tenantId: string;
  userId: string;
  role: "owner" | "staff";
}

/**
 * 200 with the identity; 401 `signed_out` (no session cookie) or `expired` (a session that
 * ended, or the retired pilot cookie); 403 `no_access` (signed in, not a member); 503
 * `unconfigured` in demo mode or `misconfigured` without the Supabase settings; 502 when
 * Supabase Auth or the API cannot be reached.
 */
export async function sessionForRequest(request: Request, setup: LiveSetup | null): Promise<Response> {
  if (!setup) return jsonAnswer(503, { error: "unconfigured" });
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return jsonAnswer(503, { error: "misconfigured" });
  }
  const config = setup.config;
  const auth = authFor(request, config);
  const lookup = await lookupSession(auth);
  if (lookup.status === "unavailable") return auth.finish(jsonAnswer(502, { error: "unavailable" }));
  if (lookup.status === "signed_out") return auth.finish(jsonAnswer(401, { error: auth.hadSession ? "expired" : "signed_out" }));

  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(`${config.apiUrl}/v1/me`, {
      headers: { Authorization: `Bearer ${lookup.session.access_token}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch {
    return auth.finish(jsonAnswer(502, { error: "unavailable" }));
  }
  if (response.status === 401) {
    auth.clearAll();
    return auth.finish(jsonAnswer(401, { error: "expired" }));
  }
  if (response.status === 403) return auth.finish(jsonAnswer(403, { error: "no_access" }));
  const me = response.ok ? meResponseSchema.safeParse(await response.json().catch(() => null)) : null;
  if (!me?.success) return auth.finish(jsonAnswer(502, { error: "unavailable" }));
  const identity: SessionIdentity = { tenantId: me.data.tenantId, userId: me.data.userId, role: me.data.role };
  return auth.finish(jsonAnswer(200, identity));
}
