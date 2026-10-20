import { liveSetupFromEnv, proxyApiRequest } from "@/lib/server/api-proxy";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";

// Reads ZS_API_URL and the Supabase settings at request time; none is ever inlined into page JS.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ path: string[] }> };

const handle = withHostingModeGuard(async (request: Request, context: Context) => {
  const { path } = await context.params;
  return proxyApiRequest(request, path, liveSetupFromEnv());
});

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
