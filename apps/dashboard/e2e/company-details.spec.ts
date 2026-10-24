// enrichment.md E-4, E-17 on the demo adapter: an owner looks up a customer's company from the
// customer page; staff only read. The demo keeps data in memory, so each test moves through the app.
import { expect, test, type Page } from "@playwright/test";

async function addCustomer(page: Page, name: string, email: string) {
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a customer" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}
const card = (page: Page) => page.getByRole("region", { name: "Company details" });

test("an owner looks up a company and sees the answer on the customer page", async ({ page }) => {
  await addCustomer(page, "Sam Buyer", "sam.buyer@acme-widgets.example");
  await expect(card(page).getByText(/Look up the company behind this customer/)).toBeVisible();
  await card(page).getByRole("button", { name: "Look up company" }).click();
  await expect(card(page).getByText("No company details found for this address.")).toBeVisible();
  const log = await page.evaluate(() => window.__zsDemo!.writeLog().filter((write) => write.operation === "enrichment.request"));
  expect(log).toHaveLength(1);
  expect(log[0]!.payload).toEqual({ contactId: expect.any(String) });
});

test("a free-mail customer is refused in plain words", async ({ page }) => {
  await addCustomer(page, "Pat Personal", "pat.personal@gmail.com");
  await card(page).getByRole("button", { name: "Look up company" }).click();
  await expect(card(page).getByText(/no company email address/)).toBeVisible();
});

test("staff read the card but are not offered the lookup", async ({ page }) => {
  await addCustomer(page, "Sam Staffview", "sam.staffview@acme-widgets.example");
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(card(page).getByText(/An owner can look them up/)).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Look up company" })).toHaveCount(0);
});
