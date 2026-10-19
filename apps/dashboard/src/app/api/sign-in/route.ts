import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { liveSetupFromEnv } from "@/lib/server/live-config";
import { AttemptLimiter, attemptLimitsFromEnv } from "@/lib/server/rate-limit";
import { requestSignInLink } from "@/lib/server/sign-in";

// Reads SUPABASE_URL and SUPABASE_ANON_KEY at request time; never inlined.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One limiter per server process: enough for a single dashboard server.
const limiter = new AttemptLimiter(attemptLimitsFromEnv());

export const POST = withHostingModeGuard((request: Request) => requestSignInLink(request, liveSetupFromEnv(), limiter));
