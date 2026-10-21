import { expect, test, type Page } from "@playwright/test";

const pageColor = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
const barColor = (page: Page) => page.locator('meta[name="theme-color"]').first();

/** Hydration mismatches and other page errors, collected for the whole test. */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text()); });
  return errors;
}

test.describe("theme", () => {
  test("black is the default, and Light in Settings sticks across a reload", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/account/settings");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await pageColor(page)).toBe("rgb(6, 6, 7)");

    const theme = page.getByRole("group", { name: "Theme" });
    await theme.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await pageColor(page)).toBe("rgb(243, 243, 245)");
    await expect(barColor(page)).toHaveAttribute("content", "#f3f3f5");

    await page.reload();
    await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    await expect(barColor(page)).toHaveAttribute("content", "#f3f3f5");
    expect(errors).toEqual([]);
  });

  test("the saved theme is on the page before any script of ours runs", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("zs-theme", "light"));
    // Block the app bundles: only the inline head script can set the theme now.
    await page.route(/\/_next\/static\/.*\.js$/, (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await pageColor(page)).toBe("rgb(243, 243, 245)");
  });

  test("a choice made in another tab applies here too", async ({ page, context }) => {
    await page.goto("/");
    const other = await context.newPage();
    await other.goto("/account/settings");
    await other.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(barColor(page)).toHaveAttribute("content", "#f3f3f5");
  });

  test("Match device follows the system colour scheme, browser bars included", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => localStorage.setItem("zs-theme", "system"));
    await page.goto("/");
    expect(await pageColor(page)).toBe("rgb(243, 243, 245)");
    await expect(barColor(page)).toHaveAttribute("content", "#f3f3f5");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await pageColor(page)).toBe("rgb(6, 6, 7)");
    await expect(barColor(page)).toHaveAttribute("content", "#060607");
  });
});
