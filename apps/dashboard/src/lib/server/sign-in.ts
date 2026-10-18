/**
 * POST /api/sign-in and /api/sign-out for the pilot gate (see pilot-gate.ts). Sign-in takes
 * `{ code }` as JSON from this origin only, compares it in constant time, and on a match
 * sets the signed session cookie. Every attempt is reserved against the caller's address and
 * against everyone before its body is read, so a burst of parallel requests cannot outrun
 * the limit; a full limit answers 429, and only a successful sign-in gives its attempt back.
 */
import { z } from "zod";
import { isSameOrigin } from "./origin";
import {
  accessCodeMatches,
  AttemptLimiter,
  clearedSessionCookie,
  clientAddress,
  isHttps,
  issueSessionValue,
  reportGateProblem,
  sessionCookie,
  trustProxyFromEnv,
  type PilotGateSetup,
} from "./pilot-gate";

const SignInBody = z.object({ code: z.string().min(1).max(256) });
const MAX_BODY_BYTES = 1024;

function answer(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function signIn(request: Request, setup: PilotGateSetup | null, limiter: AttemptLimiter, now: Date = new Date()): Promise<Response> {
  // Demo mode has no gate and nothing to sign in to.
  if (!setup) return answer(404, "not_found");
  if (!setup.ok) {
    reportGateProblem(setup.problem);
    return answer(503, "misconfigured");
  }
  const config = setup.config;
  if (request.method !== "POST") return answer(405, "method_not_allowed", { Allow: "POST" });
  if (!isSameOrigin(request, config.trustProxy)) return answer(403, "forbidden");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return answer(415, "unsupported_media_type");

  // Reserve before the first await: requests in flight together must all count.
  const address = clientAddress(request, config.trustProxy);
  const reservedAt = now.getTime();
  const wait = limiter.reserve(address, reservedAt);
  if (wait > 0) return answer(429, "rate_limited", { "Retry-After": String(wait) });

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return answer(413, "too_large");
  let parsed: z.infer<typeof SignInBody> | null = null;
  try {
    const body = SignInBody.safeParse(JSON.parse(new TextDecoder().decode(raw)));
    parsed = body.success ? body.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return answer(400, "invalid_body");

  if (!accessCodeMatches(parsed.code.trim(), config)) return answer(401, "wrong_code");
  limiter.refund(address, reservedAt);
  const session = issueSessionValue(config, now);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(session.value, config.ttlSeconds, isHttps(request, config.trustProxy)) },
  });
}

/** Clears the cookie. Works in every mode and whatever the cookie holds, so sign-out never fails. */
export function signOut(request: Request, env: Record<string, string | undefined> = process.env): Response {
  const trustProxy = trustProxyFromEnv(env);
  if (request.method !== "POST") return answer(405, "method_not_allowed", { Allow: "POST" });
  if (!isSameOrigin(request, trustProxy)) return answer(403, "forbidden");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": clearedSessionCookie(isHttps(request, trustProxy)) } });
}
