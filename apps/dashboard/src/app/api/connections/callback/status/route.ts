import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { managedConnectStatus } from "@/lib/server/connections-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// The Connections page asks again while the provider has not finished; see connections-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => managedConnectStatus(request, liveSetupFromEnv()));
