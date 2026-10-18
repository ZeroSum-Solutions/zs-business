import { defineConfig } from "@playwright/test";

const PORT = 3217;

export default defineConfig({
  testDir: "./e2e",
  // The live journeys run from playwright.live.config.ts against the real API.
  testIgnore: "live/**",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    // Loopback, not "localhost": that name can resolve to another interface or IPv6 first.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // Keep the service worker out of the way of route assertions.
    serviceWorkers: "block",
  },
  projects: [
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Production build on the in-memory demo adapter (no API URL or token).
    command: `pnpm build && pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Always this build: a server left over from another branch would test the wrong code.
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ZS_API_URL: "", ZS_API_TOKEN: "" },
  },
});
