import { expect, test, type Page } from "@playwright/test";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";

const allKeys = (page: Page) => page.evaluate(() => window.__zsQueryClient!.getQueryCache().getAll().map((query) => query.queryKey));
/** Keys of queries that hold an answer. Signed out, disabled observers may register empty ones. */
const cachedKeys = (page: Page) => page.evaluate(() => window.__zsQueryClient!.getQueryCache().getAll()
  .filter((query) => query.state.data !== undefined || query.state.error !== null)
  .map((query) => query.queryKey));

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
}

test.describe("signed-in identity", () => {
  test("names the business and the person from the session, with the real role", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
    // Members have no display name yet, so the greeting names nobody.
    await expect(page.getByText(/^(Good (morning|afternoon|evening)|Hello)\./)).toBeVisible();
    await openAccountMenu(page);
    await expect(page.getByRole("menu")).toContainText("mara@haldenrowe.example, Owner · Halden & Rowe Fine Jewelry");
    await page.keyboard.press("Escape");

    await page.evaluate(() => window.__zsDemo!.actAs("staff"));
    await openAccountMenu(page);
    await expect(page.getByRole("menu")).toContainText("jonah@haldenrowe.example, Staff · Halden & Rowe Fine Jewelry");
    await expect(page.getByRole("menu")).not.toContainText("Owner");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__zsDemo!.actAs("owner"));
  });

  test("names no business on the sign-in page or in the tab title", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Halden");
    await expect(page).toHaveTitle("Sign in | Zero Sum Business");
    await page.goto("/nope-xyz");
    await expect(page).toHaveTitle("Page not found | Zero Sum Business");
  });
});

test.describe("session and cache", () => {
  test("scopes every cached query to the signed-in tenant", async ({ page }) => {
    await page.goto("/customers");
    await expect(page.getByRole("link", { name: /Marguerite Okafor/ })).toBeVisible();
    await page.goto("/customers?view=pipeline");
    await expect(page.locator("[data-deal-id]").first()).toBeVisible();
    const keys = await allKeys(page);
    expect(keys.length).toBeGreaterThan(2);
    for (const key of keys) expect(key[0], JSON.stringify(key)).toBe(DEMO_TENANT_ID);
  });

  test("signing out empties the cache and shows a signed-out screen", async ({ page }) => {
    await page.goto("/customers");
    await expect(page.getByRole("link", { name: /Marguerite Okafor/ })).toBeVisible();
    expect((await cachedKeys(page)).length).toBeGreaterThan(0);
    // The Inbox tab counts threads that wait for a reply or a review.
    await expect(page.getByLabel(/need attention/).filter({ visible: true })).toHaveCount(1);

    await openAccountMenu(page);
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Marguerite Okafor/ })).toHaveCount(0);
    await expect(page.getByLabel(/need attention/)).toHaveCount(0);
    await expect.poll(() => cachedKeys(page)).toEqual([]);

    // The cache stays empty when the owner moves around while signed out.
    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: "Calendar" }).click();
    await expect(page.getByTestId("signed-out")).toBeVisible();
    expect(await cachedKeys(page)).toEqual([]);
    // Whatever registers while signed out is under no tenant.
    for (const key of await allKeys(page)) expect(key[0]).toBe("signed-out");

    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
    await expect(page.getByTestId("signed-out")).toHaveCount(0);
  });

  test("a 401 ends the session instead of offering Try again", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.evaluate(() => window.__zsDemo!.expireSession());

    await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: "Customers" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your session ended" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
    await expect.poll(() => cachedKeys(page)).toEqual([]);
  });
});
