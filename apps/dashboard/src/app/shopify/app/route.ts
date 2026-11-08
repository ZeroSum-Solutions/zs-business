import { randomBytes } from "node:crypto";
import { withHostingModeGuard } from "@/lib/server/hosting-mode";
import { embeddedPolicy, renderEmbeddedPage, shopFromQuery } from "@/lib/server/shopify-embedded-page";

// The app URL Shopify opens inside the admin (connections.md C-21). A route handler, not a page: it must send its own
// frame-ancestors policy for the shop that is asking, load App Bridge as the first script and set no cookie.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withHostingModeGuard((request: Request) => {
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim() ?? "";
  if (!/^[a-f0-9]{32}$/.test(clientId)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const nonce = randomBytes(18).toString("base64url");
  const shop = shopFromQuery(new URL(request.url).searchParams.get("shop"));
  return new Response(renderEmbeddedPage({ clientId, nonce }), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": embeddedPolicy(shop, nonce),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
