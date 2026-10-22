import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectUnobscured, openAccountItem } from "./helpers";

test.describe("sheets", () => {
  const cases: { name: string; path: string; opener: (page: Page) => Locator; dialog: string }[] = [
    { name: "add customer", path: "/customers", opener: (page) => page.getByRole("button", { name: "Add customer" }), dialog: "Add a customer" },
    { name: "booking", path: "/calendar", opener: (page) => page.getByRole("button", { name: "Book appointment" }), dialog: "Book an appointment" },
    { name: "site editor", path: "/site", opener: (page) => page.getByRole("button", { name: "Edit site" }), dialog: "Edit site" },
  ];
  for (const sheet of cases) {
    test(`returns focus to the opener after Escape: ${sheet.name}`, async ({ page }) => {
      await page.goto(sheet.path);
      const opener = sheet.opener(page);
      await opener.click();
      const dialog = page.getByRole("dialog", { name: sheet.dialog });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    });
  }
});

test("keeps Confirm cancel clear of the bottom tabs", async ({ page }) => {
  await page.goto("/");
  await openAccountItem(page, "Plan");
  await page.getByRole("button", { name: "Cancel plan" }).click();
  const confirm = page.getByRole("button", { name: "Confirm cancel" });
  await expectUnobscured(confirm, "Confirm cancel");
  await expect(confirm).toBeFocused();
});

// One test per page, so a slow page cannot spend the others' time budget.
for (const path of ["/", "/inbox", "/calendar", "/customers", "/site", "/agents", "/account/settings", "/account/connections", "/account/plan"]) {
  test(`keeps the last control clear of the bottom tabs when scrolled to: ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    const last = page.locator("main").locator("a[href], button, input, select, textarea").filter({ visible: true }).last();
    // Align the control with the bottom edge, as scrolling down to it does: the page's
    // scroll padding must keep it above the tab bar.
    await last.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await expectUnobscured(last, path);
  });
}
