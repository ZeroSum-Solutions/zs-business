import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { completeManagedConnect } from "@/lib/server/connections-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// The provider sends the owner back here (the redirect URL given at connect); see connections-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => completeManagedConnect(request, liveSetupFromEnv()));
