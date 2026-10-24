// business-profile.md acceptance test, on the demo adapter. The demo keeps its data in memory and
// forgets it on a full page load, so these tests move through the app and never `page.goto` twice.
import { expect, test, type Page } from "@playwright/test";
import { mainNav, openAccountItem } from "./helpers";

const DEMO_NAME = "Halden & Rowe Fine Jewelry";

const businessCard = (page: Page) => page.getByRole("region", { name: "Business" });
const writes = (page: Page) => page.evaluate(() => window.__zsDemo!.writeLog().filter((write) => write.operation === "business.profile.update"));

async function openSettings(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await openAccountItem(page, "Settings");
  await expect(businessCard(page).getByLabel("Business name")).toHaveValue(DEMO_NAME);
}

test("an owner saves the business form and the Home header shows the new name", async ({ page }) => {
  await openSettings(page);
  const card = businessCard(page);
  const save = card.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  await expect(card.getByText(/This is sample data\. Saving works here/)).toBeVisible();

  await card.getByLabel("Business name").fill("Halden & Rowe London");
  await card.getByLabel("Legal name").fill("Halden & Rowe Ltd");
  await card.getByLabel("Time zone").selectOption("Europe/London");
  await card.getByLabel("Currency").selectOption("EUR");
  await expect(save).toBeEnabled();
  await save.click();

  const toast = page.getByRole("status").filter({ hasText: "Saved in this demo only" });
  await expect(toast).toContainText("sample data");
  await expect(toast).not.toContainText("saved to your business");
  await expect(save).toBeDisabled();

  const log = await writes(page);
  expect(log).toHaveLength(1);
  expect(log[0]!.outcome).toBe("applied");
  expect(log[0]!.payload).toMatchObject({
    expectedRevision: 1,
    changes: { displayName: "Halden & Rowe London", legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR" },
  });

  await mainNav(page).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Halden & Rowe London\s*, home$/ }).filter({ visible: true })).toBeVisible();
});

test("a new deal starts at the business currency and a priced deal keeps its own (BP-8)", async ({ page }) => {
  await openSettings(page);
  await businessCard(page).getByLabel("Currency").selectOption("EUR");
  await businessCard(page).getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved in this demo only" })).toBeVisible();

  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeAttached();

  await page.getByRole("button", { name: "Edit details of Matching wedding bands" }).click();
  const empty = page.getByRole("dialog", { name: "Deal details" });
  await expect(empty.getByLabel("Currency")).toHaveValue("EUR");
  await empty.getByRole("button", { name: "Cancel" }).click();
  await expect(empty).toBeHidden();

  await page.getByRole("button", { name: "Edit details of Emerald cocktail ring commission" }).click();
  const priced = page.getByRole("dialog", { name: "Deal details" });
  await expect(priced.getByLabel("Currency")).toHaveValue("USD");
});

test("holds the fields while a save is in flight, so a later edit is not wiped by its answer", async ({ page }) => {
  await openSettings(page);
  const card = businessCard(page);
  await card.getByLabel("Legal name").fill("Halden & Rowe Ltd");
  await page.evaluate(() => window.__zsDemo!.delayNextWrite(800));
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.getByLabel("Business phone")).toBeDisabled();
  await expect(card.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(card.getByLabel("Business phone")).toBeEnabled();
  await expect(card.getByLabel("Legal name")).toHaveValue("Halden & Rowe Ltd");
});

test("refuses a phone field that holds only punctuation instead of clearing the number", async ({ page }) => {
  await openSettings(page);
  const card = businessCard(page);
  await card.getByLabel("Business phone").fill("+44 20 7946 0000");
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved in this demo only" })).toBeVisible();
  await card.getByLabel("Business phone").fill("---");
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.getByText("Enter a phone number with country code, like +1 212 555 0142.")).toBeVisible();
  expect(await writes(page)).toHaveLength(1);
});

test("staff see the form read-only with the reason", async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  const card = businessCard(page);
  await expect(card.getByText("Only an owner can change business details.")).toBeVisible();
  await expect(card.getByLabel("Business name")).toBeDisabled();
  await expect(card.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(await writes(page)).toEqual([]);
});

test("a save made after another owner's is refused and the form takes their values (BP-4)", async ({ page }) => {
  await openSettings(page);
  const card = businessCard(page);
  await page.evaluate(() => window.__zsDemo!.editBusinessElsewhere({ legalName: "Other Owner Ltd" }));
  await card.getByLabel("Business name").fill("Halden & Rowe Studio");
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.getByTestId("business-stale")).toBeVisible();
  await expect(card.getByLabel("Legal name")).toHaveValue("Other Owner Ltd");
  await expect(card.getByLabel("Business name")).toHaveValue(DEMO_NAME);
});
