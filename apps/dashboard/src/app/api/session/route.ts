import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { liveSetupFromEnv } from "@/lib/server/live-config";
import { sessionForRequest } from "@/lib/server/session";

// Reads the env at request time; answers only with the business and person the API names
// for this browser's own session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => sessionForRequest(request, liveSetupFromEnv()));
