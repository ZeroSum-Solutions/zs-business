import { defineConfig } from "@playwright/test";
import { LIVE } from "./e2e/live/env";

/**
 * The same journeys as the demo e2e, against the real API and a throwaway local database.
 * `e2e/live/global-setup.ts` starts and stops the whole stack. Phone and desktop share one
 * database, so the projects run one after the other.
 */
export default defineConfig({
  testDir: "./e2e/live",
  globalSetup: "./e2e/live/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: LIVE.webUrl,
    // Off: a live trace records the proxy's requests and could hold a token.
    trace: "off",
    serviceWorkers: "block",
  },
  projects: [
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
