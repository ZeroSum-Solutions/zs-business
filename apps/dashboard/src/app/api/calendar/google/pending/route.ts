import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { discardPendingGrant } from "@/lib/server/calendar-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// The owner declines a Google grant the callback staged; see calendar-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE = withHostingModeGuard((request: Request) => discardPendingGrant(request, liveSetupFromEnv()));
