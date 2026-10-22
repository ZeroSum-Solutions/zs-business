import { expect, test } from "@playwright/test";
import { expectDialogInset, mainNav, openAccountItem, openBookingOnFirstOpenDay, shot, viewportShot } from "./helpers";

test("navigates all six areas and the account pages", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByText("Revenue this week")).toBeVisible();
  await expect(page.getByText("Wallet and usage")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next appointments" })).toBeVisible();
  await shot(page, "01-home", info.project.name);

  const areas = [
    { link: "Inbox", heading: "Inbox", file: "02-inbox" },
    { link: "Calendar", heading: "Calendar", file: "03-calendar" },
    { link: "Customers", heading: "Customers", file: "04-customers" },
    { link: "Site", heading: "Site", file: "05-site" },
    { link: "Agents", heading: "Agents", file: "06-agents" },
    { link: "Home", heading: "This week", file: null },
  ];
  for (const area of areas) {
    await mainNav(page).getByRole("link", { name: area.link }).click();
    await expect(page.getByRole("heading", { level: 1, name: area.heading })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: area.link })).toHaveAttribute("aria-current", "page");
    if (area.file) await shot(page, area.file, info.project.name);
  }

  await mainNav(page).getByRole("link", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Week of/ })).toBeVisible();
  await shot(page, "03-calendar-week", info.project.name);
  await page.getByRole("button", { name: "Day", exact: true }).click();
  for (let step = 0; step < 7 && await page.getByRole("region", { name: "Booked" }).getByRole("listitem").count() === 0; step += 1) {
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  }
  await shot(page, "03-calendar-day", info.project.name);

  await mainNav(page).getByRole("link", { name: "Inbox" }).click();
  await page.getByRole("link", { name: /Noor Haddad/ }).click();
  await expect(page.getByRole("heading", { name: "Noor Haddad" })).toBeVisible();
  await shot(page, "07-inbox-thread", info.project.name);

  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeAttached();
  await shot(page, "08-pipeline", info.project.name);

  await mainNav(page).getByRole("link", { name: "Site" }).click();
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(page.getByRole("dialog", { name: "Edit site" })).toBeVisible();
  await expectDialogInset(page);
  await shot(page, "09-site-editor", info.project.name);
  await page.keyboard.press("Escape");

  await openAccountItem(page, "Settings");
  await shot(page, "10-settings", info.project.name);
  await openAccountItem(page, "Connections");
  await expect(page.getByText("Reconnect needed")).toBeVisible();
  await shot(page, "11-connections", info.project.name);
  await openAccountItem(page, "Plan");
  await shot(page, "12-plan", info.project.name);
});

test("books a slot, then shows a plain conflict when the time was just taken", async ({ page }, info) => {
  await page.goto("/calendar");
  const booking = await openBookingOnFirstOpenDay(page);
  const first = booking.slots.first();
  const firstTime = (await first.textContent()) ?? "";
  await first.click();
  await booking.dialog.getByRole("button", { name: `Book ${firstTime}` }).click();
  await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();
  await expect(booking.dialog).toBeHidden();

  // Second booking: someone else takes the chosen time before we save.
  const { dialog, slots } = await openBookingOnFirstOpenDay(page);
  const target = slots.first();
  const startsAt = await target.getAttribute("data-starts-at");
  const resourceId = await dialog.getAttribute("data-resource-id");
  const label = (await target.textContent()) ?? "";
  await target.click();
  await page.evaluate(([resource, start]) => window.__zsDemo!.bookAsSomeoneElse(resource!, start!), [resourceId, startsAt]);
  await dialog.getByRole("button", { name: `Book ${label}` }).click();

  await expect(dialog.getByRole("alert")).toHaveText("That time was just taken. Pick another slot.");
  await expect(dialog.locator(`[data-starts-at="${startsAt}"]`)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Pick a time" })).toBeDisabled();
  await expectDialogInset(page);
  await viewportShot(page, "13-booking-conflict", info.project.name);
});

test("adds a customer, then finds the existing record for a duplicate email", async ({ page }, info) => {
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a customer" });
  await expectDialogInset(page);
  await dialog.getByLabel("Name").fill("Lior Benzaquen");
  await dialog.getByLabel("Email").fill("lior.benzaquen@example.com");
  await dialog.getByLabel("Phone").fill("+1 646 555 0177");
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Lior Benzaquen" })).toBeVisible();

  await page.getByRole("link", { name: "Customers" }).first().click();
  await page.getByLabel("Search customers").fill("benzaq");
  await expect(page.getByRole("link", { name: /Lior Benzaquen/ })).toBeVisible();

  await page.getByRole("button", { name: "Add customer" }).click();
  await dialog.getByLabel("Name").fill("M. Okafor");
  await dialog.getByLabel("Email").fill("Marguerite.Okafor@example.com");
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/existing=1/);
  await expect(page.getByText("Already a customer. This is their existing record")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Marguerite Okafor" })).toBeVisible();
  await shot(page, "14-duplicate-contact", info.project.name);
});

test("moves a deal, and reloads when someone else changed it", async ({ page }, info) => {
  await page.goto("/customers?view=pipeline");
  const phone = info.project.name === "phone";
  const card = (title: string) => page.locator("[data-deal-id]").filter({ hasText: title });

  if (phone) await page.getByRole("button", { name: /^Design/ }).click();
  const ring = card("Custom engagement ring, 2 ct oval");
  await ring.getByRole("combobox").selectOption({ label: "Deposit" });
  await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();

  if (phone) await page.getByRole("button", { name: /^Deposit/ }).click();
  const pendant = card("Sapphire pendant redesign");
  await expect(pendant).toBeVisible();
  // Let the refetch after the first move land, or it could pick up the outside edit first.
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  const dealId = await pendant.getAttribute("data-deal-id");
  await page.evaluate((id) => window.__zsDemo!.editDealElsewhere(id!), dealId);
  await pendant.getByRole("combobox").selectOption({ label: "Delivered" });
  await expect(page.getByRole("region", { name: "Pipeline" }).getByRole("alert")).toHaveText("Someone changed Sapphire pendant redesign. Reloaded.");
  await expect(pendant.getByRole("combobox")).toHaveValue(/.+/);
  await expect(pendant.locator("option:checked")).toHaveText("Deposit");
  await viewportShot(page, "15-deal-conflict", info.project.name);

  // After the reload the move goes through.
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await pendant.getByRole("combobox").selectOption({ label: "Delivered" });
  await expect(page.getByRole("status").getByText("Moved to Delivered.")).toBeVisible();
});

test("cancels the plan in two clicks", async ({ page }, info) => {
  await page.goto("/");
  await openAccountItem(page, "Plan");
  await page.getByRole("button", { name: "Cancel plan" }).click();
  await page.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(page.getByText(/Your plan is cancelled/)).toBeVisible();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  // The pressed button is gone, so focus moves to the outcome instead of falling to the page.
  await expect(page.getByRole("status").filter({ hasText: "Your plan is cancelled" })).toBeFocused();
  await expect(page.getByRole("main")).not.toContainText(/refund|export/i);
  await shot(page, "16-plan-cancelled", info.project.name);
});

test("shows the pipeline setup states, and switches between several pipelines", async ({ page }) => {
  const id = (n: number) => `2a4c6e80-1b3d-4f5a-9c7e-${String(n).padStart(12, "0")}`;
  const setPipelines = (pipelines: unknown[]) => page.evaluate(async (next) => {
    window.__zsDemo!.setPipelines(next as never);
    await window.__zsQueryClient!.invalidateQueries();
  }, pipelines);
  await page.goto("/customers?view=pipeline");
  await expect(page.locator("[data-deal-id]").first()).toBeVisible();
  const board = page.getByRole("main");

  await setPipelines([]);
  await expect(board.getByText("No pipeline yet")).toBeVisible();
  await expect(page.locator("[data-deal-id]")).toHaveCount(0);

  await setPipelines([{ id: id(1), name: "Sales", stages: [] }]);
  await expect(board.getByText("Sales has no stages yet")).toBeVisible();
  // The section is labelled "Pipeline" too, so look for the picker by its role.
  await expect(page.getByRole("combobox", { name: "Pipeline", exact: true })).toHaveCount(0);

  await setPipelines([
    { id: id(1), name: "Sales", stages: [{ id: id(11), name: "Inquiry", position: 0 }] },
    { id: id(2), name: "Repairs", stages: [{ id: id(21), name: "Received", position: 0 }, { id: id(22), name: "Returned", position: 1 }] },
  ]);
  const choice = page.getByRole("combobox", { name: "Pipeline", exact: true });
  await expect(choice).toHaveValue(id(1));
  await expect(page.locator('[data-stage="Inquiry"]')).toBeAttached();
  await choice.selectOption({ label: "Repairs" });
  await expect(page.locator('[data-stage="Received"]')).toBeAttached();
  await expect(page.locator('[data-stage="Returned"]')).toBeAttached();
  await expect(page.locator('[data-stage="Inquiry"]')).toHaveCount(0);
});
