import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { liveSetupFromEnv } from "@/lib/server/live-config";
import { signInLimiterFromEnv } from "@/lib/server/rate-limit";
import { requestSignInLink } from "@/lib/server/sign-in";

// Reads SUPABASE_URL and SUPABASE_ANON_KEY at request time; never inlined.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The limits live in the API's shared Postgres limiter, so they hold across every server instance.
export const POST = withHostingModeGuard((request: Request) => requestSignInLink(request, liveSetupFromEnv(), signInLimiterFromEnv()));
