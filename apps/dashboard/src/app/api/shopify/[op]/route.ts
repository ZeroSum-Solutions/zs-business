import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { embeddedConfigFrom, proxyEmbedded } from "@/lib/server/shopify-embedded";

// The embedded app's calls (connections.md C-21): the App Bridge session token goes to the API as a bearer.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withHostingModeGuard(async (request: Request, context: { params: Promise<{ op: string }> }) => {
  const { op } = await context.params;
  return proxyEmbedded(request, op, embeddedConfigFrom(process.env));
});
