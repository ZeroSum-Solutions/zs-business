// Hosted booking page and widget assets (public-intake.md P-14). Original code, read once at
// start-up from apps/api/static. The page loads only same-origin script and style, so the CSP
// can forbid inline code while still allowing any website to frame it.
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`../../static/${name}`, import.meta.url), "utf8");

/** No inline script or style, no third-party origin, framable from anywhere (the widget). */
export const BOOKING_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors *",
].join("; ");

export function bookerAssets() {
  const common = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  return {
    pageHtml: read("book.html"),
    missingHtml: read("missing.html"),
    bookerJs: read("booker.js"),
    bookerCss: read("booker.css"),
    embedJs: read("embed.js"),
    pageHeaders: { ...common, "Content-Security-Policy": BOOKING_PAGE_CSP, "Cache-Control": "no-store" },
    scriptHeaders: { ...common, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
    styleHeaders: { ...common, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" },
  };
}
