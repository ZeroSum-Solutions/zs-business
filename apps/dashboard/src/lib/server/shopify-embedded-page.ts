/**
 * The HTML the embedded app is served as (docs/requirements/connections.md C-21), built by one pure function so a
 * test can check it. Shopify's rules for an embedded app (shopify.dev/docs/apps/build/authentication-authorization/
 * session-tokens and /docs/apps/build/security/set-up-iframe-protection):
 *  - App Bridge (cdn.shopify.com/shopifycloud/app-bridge.js) is the first script in <head>, with no async, defer or
 *    module attribute, and the app's client ID in a `shopify-api-key` meta tag before it;
 *  - the page may be framed by that shop's admin and by admin.shopify.com, and by nothing else;
 *  - no cookie is read or set: the page asks for a session token and sends it as a bearer.
 * The look is the dashboard's own tokens (src/styles/theme.css, light) and its Manrope font stack.
 */
import { shopDomainSchema } from "@zs/contracts";
import { EMBEDDED_CLIENT_SOURCE } from "./shopify-embedded-client";

export const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
export const EMBEDDED_TITLE = "ZS Business Connections";

/** The `shop` query value when it is a real `.myshopify.com` address, else null. */
export function shopFromQuery(value: string | null): string | null {
  if (value === null) return null;
  const parsed = shopDomainSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

/** Only this shop's admin and admin.shopify.com may frame the page; an unknown shop gets no framing at all. */
export function frameAncestors(shop: string | null): string {
  return shop === null ? "frame-ancestors 'none'" : `frame-ancestors https://${shop} https://admin.shopify.com`;
}

export function embeddedPolicy(shop: string | null, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.shopify.com`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self' https://*.shopify.com https://*.shopifycloud.com",
    "img-src 'self' data: https://cdn.shopify.com",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    frameAncestors(shop),
  ].join("; ");
}

const STYLE = String.raw`
:root { color-scheme: light; --bg: #ffffff; --inset: #f6f6f8; --fg: #141418; --fg-2: #33333b; --meta: #62626c; --border: #e3e3e8;
  --primary: #3047f0; --primary-hover: #2639d8; --primary-on: #ffffff; --accent-tint: #ebeeff; --accent-ink: #2236c9;
  --warn-tint: #fff3e0; --warn-ink: #8a4b00; --danger-tint: #fdebe8; --danger: #a83020; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 16px/1.5 "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 16px; font-size: 1.375rem; line-height: 1.25; letter-spacing: -0.01em; outline: none; }
p { margin: 0 0 12px; color: var(--fg-2); }
label { display: block; margin: 16px 0 6px; font-size: 0.875rem; font-weight: 700; color: var(--fg); }
input { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid #8e8e97; border-radius: 10px; font: inherit; letter-spacing: 0.08em; text-transform: uppercase; background: var(--bg); color: var(--fg); }
input:focus-visible, .btn:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 18px; border: 0; border-radius: 9999px; background: var(--primary); color: var(--primary-on); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
.btn:hover { background: var(--primary-hover); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn.secondary { background: var(--inset); color: var(--fg); box-shadow: inset 0 0 0 1px var(--border); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 12px; }
.shop { margin: 0 0 16px; padding: 12px 16px; border-radius: 14px; background: var(--inset); }
.shop p { margin: 0; }
.shop-name { font-weight: 700; color: var(--fg); }
.shop-domain, .help { font-size: 0.875rem; color: var(--meta); }
.badge { display: inline-block; margin: 0 0 12px; padding: 2px 12px; border-radius: 9999px; font-size: 0.875rem; font-weight: 700; }
.badge.ok { background: var(--accent-tint); color: var(--accent-ink); }
.badge.warn { background: var(--warn-tint); color: var(--warn-ink); }
.badge.neutral { background: var(--inset); color: var(--fg-2); }
.note { margin: 12px 0; padding: 12px 16px; border-radius: 10px; background: var(--inset); }
.note:empty { display: none; }
.note.error { background: var(--danger-tint); color: var(--danger); }
.note.error + .btn { margin-top: 4px; }
`;

export interface EmbeddedPageInput {
  readonly clientId: string;
  readonly nonce: string;
}

export function renderEmbeddedPage({ clientId, nonce }: EmbeddedPageInput): string {
  // The client ID and nonce are fixed-alphabet values the caller has already checked; they are never page input.
  if (!/^[a-f0-9]{32}$/.test(clientId)) throw new Error("The Shopify client ID is not a 32-character hex value");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error("The nonce is not a 16 to 64 character token");
  return [
    "<!doctype html>",
    '<html lang="en-US">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta name="shopify-api-key" content="${clientId}">`,
    `<script src="${APP_BRIDGE_URL}"></script>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="design-source" content="zs-business dashboard, Direction A: apps/dashboard/src/styles/theme.css (light), Manrope stack">',
    `<title>${EMBEDDED_TITLE}</title>`,
    `<style nonce="${nonce}">${STYLE}</style>`,
    "</head>",
    "<body>",
    '<main id="app" aria-live="polite"><h1 tabindex="-1">ZS Business Connections</h1><p>Connecting to your store...</p></main>',
    `<script nonce="${nonce}">(function (document, window, fetch, shopify) {${EMBEDDED_CLIENT_SOURCE}})(document, window, window.fetch.bind(window), window.shopify);</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
