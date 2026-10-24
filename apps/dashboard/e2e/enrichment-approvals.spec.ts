// enrichment.md E-14 on the demo adapter: an owner approves or rejects the company details a lookup
// found; only an approved detail reaches the customer. The demo keeps data in memory, so each test
// moves through the app by its links instead of reloading.
import { expect, test, type Page } from "@playwright/test";

async function openReview(page: Page) {
  await page.goto("/customers");
  await page.getByRole("link", { name: /Company details to review/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Company details to review" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const decisions = (page: Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);
const group = (page: Page, name: string) => page.getByRole("region", { name });
const companyCard = (page: Page) => page.getByRole("region", { name: "Company details" });

test("an owner approves one detail and it reaches the customer's company details", async ({ page }) => {
  await openReview(page);
  const approve = page.getByRole("button", { name: "Approve Company for Colm Brennan" });
  await approve.click();
  await expect(approve).toHaveCount(0);
  await expect(group(page, "Colm Brennan").getByText("Brennan Studio")).toHaveCount(0);
  expect(await decisions(page, "enrichment.proposal.approve")).toHaveLength(1);
  expect(await decisions(page, "enrichment.proposal.reject")).toHaveLength(0);

  await group(page, "Colm Brennan").getByRole("link", { name: "Colm Brennan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Colm Brennan" })).toBeVisible();
  await expect(companyCard(page).getByText("Brennan Studio")).toBeVisible();
});

test("an owner rejects one detail and the customer keeps the old value", async ({ page }) => {
  await openReview(page);
  const reject = page.getByRole("button", { name: "Reject Industry for Celeste Vandermeer" });
  await reject.click();
  await expect(reject).toHaveCount(0);
  expect(await decisions(page, "enrichment.proposal.reject")).toHaveLength(1);
  expect(await decisions(page, "enrichment.proposal.approve")).toHaveLength(0);

  await group(page, "Celeste Vandermeer").getByRole("link", { name: "Celeste Vandermeer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Celeste Vandermeer" })).toBeVisible();
  await expect(companyCard(page).getByText("Art dealer")).toBeVisible();
  await expect(companyCard(page).getByText("Fine art advisory")).toHaveCount(0);
});

test("an owner approves two selected details together", async ({ page }) => {
  await openReview(page);
  const rows = page.getByTestId("enrichment-proposal");
  const before = await rows.count();
  await page.getByRole("checkbox", { name: "Select Industry for Colm Brennan" }).check();
  await page.getByRole("checkbox", { name: "Select Founded for Celeste Vandermeer" }).check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Approve selected" }).click();
  await expect(rows).toHaveCount(before - 2);
  await expect(page.getByRole("button", { name: "Approve Industry for Colm Brennan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve Founded for Celeste Vandermeer" })).toHaveCount(0);
  expect(await decisions(page, "enrichment.proposal.approve")).toHaveLength(2);
  await expect(page.getByText("Select details to decide them together.")).toBeVisible();
});

test("staff read the list but are not offered a decision", async ({ page }) => {
  await openReview(page);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(page.getByText(/An owner approves or rejects each detail/)).toBeVisible();
  await expect(group(page, "Colm Brennan").getByText("Brennan Studio")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Reject/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});
