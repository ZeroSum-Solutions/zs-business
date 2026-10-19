// Hosted booking page and widget assets (public-intake.md P-14). Original code, read once at
// start-up from apps/api/static. The page loads only same-origin script and style, so the CSP
// can forbid inline code while still allowing any website to frame it.
import { existsSync, readFileSync } from "node:fs";

// The Vercel bundle carries a copy next to index.mjs (scripts/build-vercel.mjs); from source,
// src/public sits two levels below apps/api/static.
const STATIC_DIRS = [new URL("./static/", import.meta.url), new URL("../../static/", import.meta.url)];
const read = (name: string) => {
  const dir = STATIC_DIRS.find((candidate) => existsSync(new URL(name, candidate))) ?? STATIC_DIRS[1]!;
  return readFileSync(new URL(name, dir), "utf8");
};

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
