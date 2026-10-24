import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectDialogInset, mainNav, viewportShot } from "./helpers";

// booking-customer.md BC-8, BC-9: book for a customer in one step, see the name on the calendar,
// Home and the customer's page without a reload, then change and remove it. Runs on the demo
// adapter, on a phone (390x844) and a desktop (1440x900).

// Monday 08:00 in New York: the repair calendar opens at 10:00, before any seeded appointment.
const MONDAY_MORNING = new Date("2026-10-26T12:00:00.000Z");
const CUSTOMER = "Ines Achterberg";
const OTHER = "Colm Brennan";

const writes = (page: Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);

async function openRepairDay(page: Page) {
  await page.clock.setFixedTime(MONDAY_MORNING);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.getByRole("group", { name: "Calendar" }).getByRole("button", { name: "Repair intake" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible();
}

async function pickCustomer(dialog: Locator, name: string) {
  await dialog.getByLabel(/^Who is it for\?|^Choose another customer/).fill(name.split(" ")[0]!);
  await dialog.getByRole("list", { name: "Matching customers" }).getByRole("button", { name: new RegExp(name) }).click();
}

test("books for a customer in one step and shows the name on the calendar, Home and the customer's page", async ({ page }, info) => {
  await openRepairDay(page);
  const firstOpen = page.getByRole("region", { name: "Open times" }).getByRole("button", { name: /^Book / }).first();
  await expect(firstOpen).toHaveAccessibleName("Book 10:00 AM");
  await firstOpen.click();

  const dialog = page.getByRole("dialog", { name: "Book an appointment" });
  await expect(dialog).toBeVisible();
  await pickCustomer(dialog, CUSTOMER);
  await expect(dialog.getByTestId("picked-customer")).toContainText(CUSTOMER);
  await expectDialogInset(page);
  await viewportShot(page, "booking-customer-sheet", info.project.name);
  await dialog.getByRole("button", { name: `Book 10:00 AM for ${CUSTOMER}` }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").getByText(/^Booked .* for Ines Achterberg\.$/)).toBeVisible();

  // The calendar names her without a reload.
  const row = page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ hasText: CUSTOMER });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("10:00 AM");

  // booking.create carried no customer (B-17); the link was its own write at revision 0.
  expect((await writes(page, "booking.create")).map((write) => write.payload)).toEqual([
    { resourceId: expect.any(String), startsAt: expect.any(String) },
  ]);
  expect((await writes(page, "booking.contact.link")).map((write) => [write.outcome, (write.payload as { expectedRevision: number }).expectedRevision])).toEqual([["applied", 0]]);

  // Home, reached by the app's own navigation: the next appointment is hers.
  await mainNav(page).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Next appointments" })).toContainText(CUSTOMER);

  // Her page lists the appointment.
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByLabel("Search customers").fill("Ines");
  await page.getByRole("link", { name: new RegExp(CUSTOMER) }).click();
  await expect(page.getByRole("heading", { level: 1, name: CUSTOMER })).toBeVisible();
  const appointments = page.getByRole("region", { name: "Appointments" });
  await expect(appointments).toContainText("10:00 AM");
  await expect(appointments).not.toContainText("No appointments yet");
});

test("changes and removes the customer from the booking, and the lists follow", async ({ page }) => {
  await openRepairDay(page);
  await page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" }).click();
  const sheet = page.getByRole("dialog", { name: "Book an appointment" });
  await pickCustomer(sheet, CUSTOMER);
  await sheet.getByRole("button", { name: /^Book 10:00 AM for / }).click();
  await expect(sheet).toBeHidden();
  const booked = page.getByRole("region", { name: "Booked" });
  const row = booked.getByRole("listitem").filter({ hasText: CUSTOMER });
  await expect(row).toHaveCount(1);

  // Change: the booking moves to the other customer.
  await row.getByRole("button", { name: "Change customer" }).click();
  const detail = page.getByRole("dialog", { name: "Customer for this booking" });
  await expect(detail.getByTestId("booking-customer")).toContainText(CUSTOMER);
  await detail.getByRole("button", { name: "Change" }).click();
  await pickCustomer(detail, OTHER);
  await expect(detail).toBeHidden();
  const moved = booked.getByRole("listitem").filter({ hasText: OTHER });
  await expect(moved).toHaveCount(1);
  await expect(booked.getByRole("listitem").filter({ hasText: CUSTOMER })).toHaveCount(0);

  // Remove: back to no customer, and the way to link one again.
  await moved.getByRole("button", { name: "Change customer" }).click();
  await detail.getByRole("button", { name: "Remove" }).click();
  await expect(detail).toBeHidden();
  const empty = booked.getByRole("listitem").filter({ hasText: "10:00 AM" }).filter({ hasText: "No customer linked" });
  await expect(empty).toHaveCount(1);
  await expect(empty.getByRole("button", { name: "Link a customer" })).toBeVisible();

  // Each change is a compare-and-set on the revision it read: 0, then 1, then 2.
  expect((await writes(page, "booking.contact.link")).map((write) => (write.payload as { expectedRevision: number }).expectedRevision)).toEqual([0, 1]);
  expect((await writes(page, "booking.contact.unlink")).map((write) => [write.outcome, (write.payload as { expectedRevision: number }).expectedRevision])).toEqual([["applied", 2]]);

  // Home no longer names either of them.
  await mainNav(page).getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Next appointments" })).not.toContainText(OTHER);
});

test("keeps the booking when the link fails and offers Link again", async ({ page }) => {
  await openRepairDay(page);
  await page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Book an appointment" });
  await pickCustomer(dialog, CUSTOMER);
  await page.evaluate(() => window.__zsDemo!.failNextBookingLink());
  await dialog.getByRole("button", { name: /^Book 10:00 AM for / }).click();

  // The booking stands; the sheet says so and offers a retry.
  await expect(dialog.getByTestId("booked-panel")).toContainText("Booked");
  await expect(dialog.getByRole("alert")).toContainText("could not add Ines Achterberg");
  expect(await writes(page, "booking.create")).toHaveLength(1);

  await dialog.getByRole("button", { name: "Link again" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ hasText: CUSTOMER })).toHaveCount(1);
  // One booking, and the retry was the link's only write.
  expect(await writes(page, "booking.create")).toHaveLength(1);
  expect((await writes(page, "booking.contact.link")).map((write) => write.outcome)).toEqual(["applied"]);
});

test("Link again after someone else linked first reads the booking and links with its revision", async ({ page }) => {
  await openRepairDay(page);
  await page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Book an appointment" });
  await pickCustomer(dialog, CUSTOMER);
  await page.evaluate(() => window.__zsDemo!.raceNextBookingLink());
  await dialog.getByRole("button", { name: /^Book 10:00 AM for / }).click();
  await expect(dialog.getByRole("alert")).toContainText("Someone else changed this booking's customer");

  await dialog.getByRole("button", { name: "Link again" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ hasText: CUSTOMER })).toHaveCount(1);
  // The first try was stale at revision 0; the retry carried the revision it read (1).
  const links = (await writes(page, "booking.contact.link")).map((write) => [write.outcome, (write.payload as { expectedRevision: number }).expectedRevision]);
  expect(links).toEqual([["rejected", 0], ["applied", 1]]);
});

test("a website booking has no link control", async ({ page }) => {
  await page.clock.setFixedTime(MONDAY_MORNING);
  await page.goto("/calendar");
  await page.getByRole("group", { name: "Calendar" }).getByRole("button", { name: "Showroom" }).click();
  // Tomorrow has the seeded website booking from Linnea Castellanos.
  await page.getByRole("button", { name: "Next day" }).click();
  const website = page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ has: page.getByTestId("website-badge") });
  await expect(website.first()).toBeVisible();
  await expect(website.first().getByRole("button", { name: /customer/i })).toHaveCount(0);
});
