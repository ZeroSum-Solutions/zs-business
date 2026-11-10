import { expect, test } from "@playwright/test";
import { expectDialogInset, viewportShot } from "./helpers";

// crm.md C-25..C-32: add, rename, reorder, archive and restore pipeline stages from the board.
// Runs on the demo adapter, on a phone (390x844) and a desktop (1440x900).

const writes = (page: import("@playwright/test").Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);

async function openEditor(page: import("@playwright/test").Page) {
  await page.goto("/customers?view=pipeline");
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit stages" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit stages" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("adds, renames and reorders stages, and the board follows", async ({ page }, info) => {
  const dialog = await openEditor(page);
  await dialog.getByLabel("New stage").fill("Quote sent");
  await dialog.getByRole("button", { name: "Add stage" }).click();
  await expect(page.getByRole("status").getByText("Added Quote sent.")).toBeVisible();
  await expect(dialog.locator('[data-stage-row="Quote sent"]')).toBeVisible();

  await dialog.getByRole("button", { name: "Rename Quote sent" }).click();
  await dialog.getByLabel("New name for Quote sent").fill("Quote");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").getByText("Renamed to Quote.")).toBeVisible();

  await dialog.getByRole("button", { name: "Move Quote earlier" }).click();
  await expect(dialog.locator("[data-stage-row]").nth(4)).toHaveAttribute("data-stage-row", "Quote");
  await expect(dialog.getByRole("button", { name: "Move Quote earlier" })).toBeFocused();
  await expectDialogInset(page);
  await viewportShot(page, "pipeline-stage-editor", info.project.name);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  if (info.project.name === "desktop") {
    const headings = await page.locator("[data-stage]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-stage")));
    expect(headings).toEqual(["Inquiry", "Consultation", "Design", "Deposit", "Quote", "Delivered"]);
  }
  expect((await writes(page, "crm.stage.reorder")).map((write) => write.outcome)).toEqual(["applied"]);
});

test("archives a stage with deals into another stage, then restores it", async ({ page }) => {
  const dialog = await openEditor(page);
  const row = dialog.locator('[data-stage-row="Design"]');
  await expect(row).toContainText(/\d+ deals?/);
  await row.getByRole("button", { name: "Archive Design" }).click();
  const panel = row.getByRole("group", { name: "Archive Design" });
  await panel.getByLabel("Move its deals to").selectOption({ label: "Deposit" });
  await panel.getByRole("button", { name: "Archive Design" }).click();
  await expect(page.getByRole("status").getByText("Archived Design.")).toBeVisible();
  await expect(dialog.locator('[data-stage-row="Design"]')).toHaveCount(0);
  await expect(dialog.locator('[data-archived-stage="Design"]')).toBeVisible();

  await dialog.getByRole("button", { name: "Restore Design" }).click();
  await expect(page.getByRole("status").getByText("Restored Design.")).toBeVisible();
  await expect(dialog.locator('[data-stage-row="Design"]')).toBeVisible();
  await expect(dialog.locator('[data-archived-stage="Design"]')).toHaveCount(0);
  expect((await writes(page, "crm.stage.archive")).map((write) => write.outcome)).toEqual(["applied"]);
});

test("says so when a stage name is already in use", async ({ page }) => {
  const dialog = await openEditor(page);
  await dialog.getByLabel("New stage").fill("inquiry");
  await dialog.getByRole("button", { name: "Add stage" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Another stage already has that name.");
});
