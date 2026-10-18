import { expect, test, type Page } from "@playwright/test";

test.describe("offline", () => {
  test.use({ serviceWorkers: "allow" });

  async function installWorker(page: Page) {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
    // The worker claims the page once it has cached the pages and their assets.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
  }

  const cachedPaths = (page: Page) => page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });

  test("opens styled and working offline after one visit", async ({ page, context }) => {
    await installWorker(page);
    const look = () => page.evaluate(() => {
      const main = getComputedStyle(document.querySelector("main")!);
      const body = getComputedStyle(document.body);
      return { maxWidth: main.maxWidth, paddingTop: main.paddingTop, font: body.fontFamily, background: body.backgroundColor };
    });
    const online = await look();
    const cached = await cachedPaths(page);
    expect(cached.some((item) => item.startsWith("/_next/static/") && item.endsWith(".css")), "stylesheet cached").toBe(true);
    expect(cached.some((item) => item.startsWith("/_next/static/chunks/")), "scripts cached").toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
    expect(await look()).toEqual(online);
    // Hydrated: the account menu only opens with its script running.
    await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await context.setOffline(false);
  });

  test("never stores /api responses, even ones that look cacheable", async ({ page, context }) => {
    await context.route("**/api/v1/**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "public, max-age=31536000" },
      body: JSON.stringify({ items: [] }),
    }));
    await installWorker(page);
    expect(await page.evaluate(async () => (await fetch("/api/v1/booking/resources")).status)).toBe(200);
    expect((await cachedPaths(page)).filter((item) => item.startsWith("/api/") || item.startsWith("/v1/"))).toEqual([]);

    await context.unroute("**/api/v1/**");
    await context.setOffline(true);
    const offline = await page.evaluate(() => fetch("/api/v1/booking/resources").then((response) => `status ${response.status}`, () => "failed"));
    expect(offline).toBe("failed");
    await context.setOffline(false);
  });
});
