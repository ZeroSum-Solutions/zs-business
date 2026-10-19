import { reportHostingMode } from "@/lib/server/hosting-mode";

/**
 * At server start: say in the log right away when build and server disagree on the mode.
 * src/proxy.ts refuses the pages, and each /api route refuses itself (withHostingModeGuard).
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") reportHostingMode(process.env.NEXT_PUBLIC_API_MODE, process.env);
}
