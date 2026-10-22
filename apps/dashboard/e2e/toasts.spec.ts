import { expect, test, type Page } from "@playwright/test";
import { mainNav } from "./helpers";

// Toasts close by themselves, stay out of an open sheet's way and do not follow the owner to
// another page (U3 V-1, V-2, UV-2, U3-13, A-5). The rules are unit-tested in test/toast-queue.test.ts.

async function publishTagline(page: Page, tagline: string) {
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill(tagline);
  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(editor).toBeHidden();
}

test("a toast stays on its page: moving to another page clears it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/site");
  await publishTagline(page, "Open late on Fridays");
  const toast = page.getByTestId("toast").filter({ hasText: "Published. Your site is live." });
  await expect(toast).toBeVisible();
  await page.clock.fastForward(3_000);
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("opening a sheet clears page toasts, so none sits over its actions", async ({ page }) => {
  await page.goto("/site");
  await publishTagline(page, "Open late on Fridays");
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await expect(editor.getByRole("button", { name: "Publish" })).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("one site answer at a time: a newer one replaces the last", async ({ page }) => {
  await page.goto("/site");
  await publishTagline(page, "First");
  await publishTagline(page, "Second");
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await page.getByRole("button", { name: "Make live version 1" }).click();
  await page.getByRole("dialog", { name: "Make version 1 live?" }).getByRole("button", { name: "Make version 1 live" }).click();
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveText(/Version 1 is live again\./);
});
