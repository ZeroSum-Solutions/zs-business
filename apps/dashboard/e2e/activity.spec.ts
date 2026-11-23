import { expect, test } from "@playwright/test";
import { openAccountItem } from "./helpers";

// Backlog B05: owners open Activity from the account menu; each approval card opens its receipt.
test("lists actions under the account menu and opens an approval's receipt", async ({ page }, info) => {
  await page.goto("/");
  await openAccountItem(page, "Activity");
  const list = page.getByRole("list", { name: "Actions" });
  await expect(list.getByRole("link").first()).toBeVisible();
  // Nothing scrolls sideways at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.ZS_SHOT_DIR) await page.screenshot({ path: `${process.env.ZS_SHOT_DIR}/activity-${info.project.name}.png`, fullPage: true });

  const card = page.locator("a[data-approval-card]").first();
  await expect(card).toContainText("Receipt");
  await card.click();
  await expect(page.getByRole("heading", { level: 1, name: "Receipt" })).toBeVisible();
  await expect(page.locator("dl[data-receipt]")).toContainText("Approved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.ZS_SHOT_DIR) await page.screenshot({ path: `${process.env.ZS_SHOT_DIR}/receipt-${info.project.name}.png`, fullPage: true });
});
