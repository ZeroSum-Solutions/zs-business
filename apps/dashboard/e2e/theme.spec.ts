import { expect, test } from "@playwright/test";

const pageColor = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

test.describe("theme", () => {
  test("black is the default, and Light in Settings sticks across a reload", async ({ page }) => {
    await page.goto("/account/settings");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await pageColor(page)).toBe("rgb(6, 6, 7)");

    const theme = page.getByRole("group", { name: "Theme" });
    await theme.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await pageColor(page)).toBe("rgb(243, 243, 245)");
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", "#f3f3f5");

    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  });

  test("Match device follows the system colour scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => localStorage.setItem("zs-theme", "system"));
    await page.goto("/");
    expect(await pageColor(page)).toBe("rgb(243, 243, 245)");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await pageColor(page)).toBe("rgb(6, 6, 7)");
  });
});
