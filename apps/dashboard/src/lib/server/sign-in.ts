/**
 * Sign-in with Supabase Auth email links, and sign-out.
 *
 * POST /api/sign-in takes `{ email, next? }` as JSON from this origin and asks Supabase to
 * email a sign-in link. It never creates an account (people join by invitation) and it
 * answers 204 whether or not the address has one, so it cannot be used to find out who
 * does. Every request is reserved against the caller's address and against everyone before
 * its body is read, so nobody can make the server send unlimited email.
 *
 * GET /auth/confirm is where the link lands: it trades the link's one-time token hash for a
 * session (Supabase verifyOtp), sets the httpOnly session cookies and redirects to `next`.
 * It needs no state from the browser that asked, so a link opened on another device works.
 * The Supabase "Magic Link" email template must therefore link to
 * `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`.
 *
 * POST /api/sign-out revokes the session in Supabase (signOut, scope "local": this device
 * only) and clears the cookies. The API refuses the revoked session's access token at once.
 * When Supabase cannot be told, it answers 502 and keeps the cookies, so the browser's
 * Try again can still revoke the session instead of being told it ended when it did not.
 */
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { z } from "zod";
import { safeNextUrl } from "../safe-next";
import { readBoundedBody, type BodyTiming } from "./body";
import { isHttps, jsonAnswer, publicOrigin, reportSetupProblem, trustProxyFromEnv, type LiveSetup } from "./live-config";
import { isSameOrigin } from "./origin";
import { clientAddress, type AttemptLimiter } from "./rate-limit";
import { authFor, expiredCookies, lookupSession } from "./supabase";

const SignInBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  next: z.string().max(512).optional(),
});
const MAX_BODY_BYTES = 2048;
/** A 2 KiB body that takes longer than this is a stalled or deliberately slow client. */
const BODY_DEADLINE_MS = 10_000;
const LINK_TYPES = new Set(["email", "magiclink"]);

/** A path on this site, from a `next` value that may point anywhere. */
function nextPath(next: string | null | undefined): string {
  const url = new URL(safeNextUrl(next, "http://dashboard.invalid"));
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function requestSignInLink(
  request: Request,
  setup: LiveSetup | null,
  limiter: AttemptLimiter,
  now: Date = new Date(),
  timing: BodyTiming = {},
): Promise<Response> {
  // Demo mode has nothing to sign in to.
  if (!setup) return jsonAnswer(404, { error: "not_found" });
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return jsonAnswer(503, { error: "misconfigured" });
  }
  const config = setup.config;
  if (request.method !== "POST") return jsonAnswer(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (!isSameOrigin(request, config.trustProxy)) return jsonAnswer(403, { error: "forbidden" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return jsonAnswer(415, { error: "unsupported_media_type" });

  // Reserve before the first await: requests in flight together must all count.
  const address = clientAddress(request, config.trustProxy);
  const reservedAt = now.getTime();
  const wait = limiter.reserve(address, reservedAt);
  if (wait > 0) return jsonAnswer(429, { error: "rate_limited" }, { "Retry-After": String(wait) });

  // Read at most MAX_BODY_BYTES; a refused body stays charged, like a malformed one.
  const raw = await readBoundedBody(request, { maxBytes: MAX_BODY_BYTES, deadlineMs: BODY_DEADLINE_MS, ...timing });
  if (!raw.ok) {
    if (raw.reason === "too_large") return jsonAnswer(413, { error: "too_large" });
    if (raw.reason === "timeout") return jsonAnswer(408, { error: "timeout" });
    return jsonAnswer(400, { error: "bad_request" });
  }
  let parsed: z.infer<typeof SignInBody> | null = null;
  try {
    const body = SignInBody.safeParse(JSON.parse(new TextDecoder().decode(raw.bytes)));
    parsed = body.success ? body.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return jsonAnswer(400, { error: "invalid_email" });

  const auth = authFor(request, config);
  const emailRedirectTo = `${publicOrigin(request, config.trustProxy)}/auth/confirm?next=${encodeURIComponent(nextPath(parsed.next))}`;
  const { error } = await auth.client.auth.signInWithOtp({ email: parsed.email, options: { shouldCreateUser: false, emailRedirectTo } });
  if (error && (isAuthRetryableFetchError(error) || (error.status ?? 500) >= 500)) {
    // Nothing was sent, so the attempt is not charged.
    limiter.refund(address, reservedAt);
    return auth.finish(jsonAnswer(502, { error: "unavailable" }));
  }
  if (error?.status === 429) return auth.finish(jsonAnswer(429, { error: "rate_limited" }, { "Retry-After": "60" }));
  // Any other refusal (no such account, signups off) looks exactly like a sent link.
  return auth.finish(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
}

function redirect(location: string): Response {
  // Relative, so the browser stays on the host it used; no-referrer keeps the token hash out of logs.
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function confirmSignIn(request: Request, setup: LiveSetup | null): Promise<Response> {
  if (!setup) return redirect("/");
  const params = new URL(request.url).searchParams;
  const next = nextPath(params.get("next"));
  const failed = () => redirect(`/sign-in?error=link${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`);
  if (!setup.ok) {
    reportSetupProblem(setup.problem);
    return failed();
  }
  const tokenHash = params.get("token_hash");
  const type = params.get("type") ?? "";
  if (!tokenHash || tokenHash.length > 512 || !LINK_TYPES.has(type)) return failed();
  const auth = authFor(request, setup.config);
  const { data, error } = await auth.client.auth.verifyOtp({ token_hash: tokenHash, type: type as "email" | "magiclink" });
  if (error || !data.session) return auth.finish(failed());
  return auth.finish(redirect(next));
}

/** Clears the cookies once the session is revoked (or already gone); 502, cookies kept, when Supabase could not be told. */
export async function signOut(request: Request, setup: LiveSetup | null): Promise<Response> {
  const trustProxy = setup?.ok ? setup.config.trustProxy : trustProxyFromEnv();
  if (request.method !== "POST") return jsonAnswer(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (!isSameOrigin(request, trustProxy)) return jsonAnswer(403, { error: "forbidden" });
  if (!setup?.ok) {
    const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    for (const cookie of expiredCookies(request, isHttps(request, trustProxy))) response.headers.append("Set-Cookie", cookie);
    return response;
  }
  const auth = authFor(request, setup.config);
  const lookup = await lookupSession(auth);
  let revoked = lookup.status === "signed_out";
  if (lookup.status === "signed_in") {
    // supabase-js drops its session even when the logout call fails; keep the (possibly just
    // refreshed) cookies then, so a retry still holds a token to revoke.
    const rollback = auth.checkpoint();
    const { error } = await auth.client.auth.signOut({ scope: "local" });
    revoked = !error;
    if (!revoked) rollback();
  }
  if (!revoked) return auth.finish(jsonAnswer(502, { error: "unavailable" }));
  auth.clearAll();
  return auth.finish(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
}
