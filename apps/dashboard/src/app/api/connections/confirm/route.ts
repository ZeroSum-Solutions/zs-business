import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { confirmManagedConnect } from "@/lib/server/connections-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// The owner confirms the staged grant; see connections-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withHostingModeGuard((request: Request) => confirmManagedConnect(request, liveSetupFromEnv()));
