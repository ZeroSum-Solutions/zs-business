import { proxyApiRequest, proxyConfigFromEnv } from "@/lib/server/api-proxy";

// Reads ZS_API_URL and ZS_API_TOKEN at request time; neither is ever inlined into page JS.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context) {
  const { path } = await context.params;
  return proxyApiRequest(request, path, proxyConfigFromEnv());
}

export { handle as GET, handle as POST };
