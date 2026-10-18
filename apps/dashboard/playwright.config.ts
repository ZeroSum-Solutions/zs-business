import { defineConfig } from "@playwright/test";

const PORT = 3217;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // Keep the service worker out of the way of route assertions.
    serviceWorkers: "block",
  },
  projects: [
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Production build on the in-memory demo adapter (no API URL).
    command: `pnpm build && pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NEXT_PUBLIC_API_URL: "" },
  },
});
