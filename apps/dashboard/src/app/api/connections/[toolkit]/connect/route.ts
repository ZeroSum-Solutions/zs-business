import { liveSetupFromEnv } from "@/lib/server/api-proxy";
import { startManagedConnect } from "@/lib/server/connections-connect";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// Starts a managed-tier connection and binds it to this browser; see connections-connect.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ toolkit: string }> };

export const POST = withHostingModeGuard(async (request: Request, context: Context) => {
  const { toolkit } = await context.params;
  return startManagedConnect(request, liveSetupFromEnv(), toolkit);
});
