import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { cancelPendingConnection, readPendingConnection } from "@/lib/server/connections-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// Reads or declines the grant the callback staged; see connections-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => readPendingConnection(request, liveSetupFromEnv()));
export const DELETE = withHostingModeGuard((request: Request) => cancelPendingConnection(request, liveSetupFromEnv()));
