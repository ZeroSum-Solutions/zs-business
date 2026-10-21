import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { completeGoogleConnect } from "@/lib/server/calendar-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// Google sends the owner back here (GOOGLE_REDIRECT_URL); see calendar-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => completeGoogleConnect(request, liveSetupFromEnv()));
