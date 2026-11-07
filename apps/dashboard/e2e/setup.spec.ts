import { expect, test, type Page } from "@playwright/test";
import { mainNav, openAccountItem, shot } from "./helpers";

// industry-templates.md acceptance 6: a demo run completes setup with each template. Demo data
// starts again on a full page load, so after the first load every step moves in the app.

test.use({ timezoneId: "Europe/London" });

const TEMPLATES = [
  { id: "jewelry", label: "Jewelry: custom and bridal", stage: "Design approved", hours: "Mon–Fri 9:00 AM–5:00 PM", page: "Book a consultation", connections: ["shopify", "google_calendar"] },
  { id: "crafts", label: "Ceramics and crafts: commissions", stage: "Quote sent", hours: "Mon–Fri 9:00 AM–5:00 PM", page: "Visit the studio", connections: ["shopify", "google_calendar"] },
  { id: "agency", label: "AI and business agency", stage: "Proposal sent", hours: "Mon–Fri 9:00 AM–5:00 PM", page: "Book a discovery call", connections: ["google_calendar"] },
  { id: "fitness", label: "Gym or personal trainer", stage: "Intro booked", hours: "Mon–Fri 6:00 AM–8:00 PM", page: "Book a free intro", connections: ["google_calendar"] },
] as const;

const setupLine = (page: Page) => page.getByTestId("setup-line");

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
}

for (const template of TEMPLATES) {
  test(`an owner sets up the business with ${template.id}, from Home to Home`, async ({ page }, info) => {
    await openHome(page);
    await expect(setupLine(page)).toHaveText("Your business isn't set up yet. Choose a template");
    await setupLine(page).getByRole("link", { name: "Choose a template" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Templates" }).getByRole("listitem")).toHaveCount(4);
    if (template.id === "jewelry") await shot(page, "setup-templates", info.project.name);

    const card = page.getByTestId(`template-${template.id}`);
    await expect(card).toContainText(template.page);
    await card.getByRole("button", { name: "See the full preview" }).click();

    await expect(page.getByRole("heading", { level: 1, name: template.label })).toBeFocused();
    await expect(page.getByTestId("preview-stages")).toContainText(template.stage);
    await expect(page.getByTestId("preview-hours")).toContainText(template.hours);
    // No zone on the business profile yet: the browser's zone is the start.
    await expect(page.getByLabel("Time zone")).toHaveValue("Europe/London");
    if (template.id === "jewelry") await shot(page, "setup-preview", info.project.name);

    await page.getByRole("button", { name: "Set up with this template" }).click();
    await expect(page.getByRole("status").getByText(`Set up with ${template.label}.`)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(setupLine(page)).toHaveCount(0);

    // What it set up, from the account menu's permanent link.
    await openAccountItem(page, "Setup");
    const applied = page.getByTestId("applied-template");
    await expect(applied).toContainText(template.label);
    await expect(applied).toContainText("(London)");
    await expect(page.getByTestId("applied-page")).toContainText("Off line");
    await expect(page.getByTestId("google-not-connected")).toContainText("Google Calendar is not connected yet");
    await expect(page.getByRole("main").getByText("Sending stays off until you approve the wording.").first()).toBeVisible();

    // IT-8: the template's recommended connections come first, with its line.
    await page.getByRole("main").getByRole("link", { name: "Connections" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    for (const id of template.connections) await expect(page.getByTestId(`recommended-${id}`)).toHaveText(`Recommended for ${template.label}`);
    // The recommended lines come in the template's order, ahead of any card that is not recommended.
    const order = await page.locator('[data-testid^="recommended-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    expect(order).toEqual(template.connections.map((id) => `recommended-${id}`));
  });
}

/** Calendar does not read the setup, so a template applied elsewhere shows on the next read. */
async function setUpElsewhere(page: Page, templateId: "jewelry" | "crafts" | "agency" | "fitness") {
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.evaluate((id) => window.__zsDemo!.applyTemplateElsewhere(id, "Europe/London"), templateId);
}

test("an owner takes the new booking page live and off line again (IT-11)", async ({ page }, info) => {
  await setUpElsewhere(page, "jewelry");
  await openAccountItem(page, "Setup");
  const card = page.getByTestId("applied-page");
  const toggle = card.getByRole("switch", { name: "Take the booking page live" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByRole("status").getByText("Your booking page is live.")).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(card).toContainText("Live");
  await expect(card.getByRole("link", { name: "Open booking page" })).toHaveAttribute("href", /\/book\/zsb1_/);
  await shot(page, "setup-applied", info.project.name);
  await toggle.click();
  await expect(page.getByRole("status").getByText("Your booking page is off line.")).toBeVisible();
  await expect(toggle).not.toBeChecked();
});

test("staff see the templates read-only, and Home tells them their owner hasn't finished", async ({ page }) => {
  await openHome(page);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(setupLine(page)).toHaveText("Your owner hasn't finished setup yet.");
  await expect(setupLine(page).getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Setup" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // On /setup when the role changes: the cards stay, with nothing to choose.
  await page.evaluate(() => window.__zsDemo!.actAs("owner"));
  await openAccountItem(page, "Setup");
  await expect(page.getByRole("button", { name: "See the full preview" })).toHaveCount(4);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(page.getByRole("list", { name: "Templates" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "See the full preview" })).toHaveCount(0);
});

test("staff see what was set up but cannot take the page live", async ({ page }, info) => {
  await setUpElsewhere(page, "fitness");
  await openAccountItem(page, "Setup");
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  const toggle = page.getByRole("switch", { name: "Take the booking page live" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleDescription(/Only an owner can take the booking page live or off line\.$/);
  await expect(page.getByTestId("applied-template")).toContainText("Gym or personal trainer");
  // The page's title comes with the setup read, and its link once an owner has taken it live; staff cannot list pages.
  await expect(page.getByTestId("applied-page")).toContainText("Book a free intro");
  await expect(page.getByRole("link", { name: "Open booking page" })).toHaveCount(0);
  await page.evaluate(() => window.__zsDemo!.actAs("owner"));
  await page.getByRole("switch", { name: "Take the booking page live" }).click();
  await expect(page.getByRole("status").getByText("Your booking page is live.")).toBeVisible();
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(page.getByTestId("applied-page").getByRole("link", { name: "Open booking page" })).toHaveAttribute("href", /\/book\/zsb1_/);
  await shot(page, "setup-staff", info.project.name);
  await mainNav(page).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(setupLine(page)).toHaveCount(0);
});

test("New deal on a customer's page goes into the template's first open stage (IT-10)", async ({ page }, info) => {
  await setUpElsewhere(page, "agency");
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByLabel("Search customers").fill("okafor");
  await page.getByRole("main").getByRole("link", { name: /Marguerite Okafor/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Marguerite Okafor" })).toBeVisible();
  const deals = page.locator('[aria-labelledby="deals-title"]');
  await page.getByRole("button", { name: "New deal" }).click();
  const dialog = page.getByRole("dialog", { name: "New deal" });
  // Cancel is a plain button: it closes the dialog and adds nothing, even with a title typed.
  await dialog.getByLabel("Title").fill("Never added");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(deals.getByRole("listitem").filter({ hasText: "Never added" })).toHaveCount(0);
  await page.getByRole("button", { name: "New deal" }).click();
  await dialog.getByLabel("Title").fill("AI audit");
  await dialog.getByLabel("Value (optional)").fill("4800");
  await dialog.getByRole("button", { name: "Add deal" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").getByText("Added the deal AI audit.")).toBeVisible();
  // Agency's first stage that is neither won nor lost.
  await expect(deals.getByRole("listitem").filter({ hasText: "AI audit" })).toContainText("Lead");
  await shot(page, "setup-new-deal", info.project.name);
});
