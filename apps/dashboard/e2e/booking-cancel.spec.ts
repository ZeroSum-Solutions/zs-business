import { expect, test, type Page } from "@playwright/test";
import { expectDialogInset, viewportShot } from "./helpers";

// booking.md B-29..B-35: cancel a booking from the calendar, tell the customer or not, and see the time
// open up again. Runs on the demo adapter, on a phone (390x844) and a desktop (1440x900).

// Monday 08:00 in New York: the repair calendar opens at 10:00, before any seeded appointment.
const MONDAY_MORNING = new Date("2026-10-26T12:00:00.000Z");
const CUSTOMER = "Ines Achterberg";

const writes = (page: Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);

async function openRepairDay(page: Page) {
  await page.clock.setFixedTime(MONDAY_MORNING);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.getByRole("group", { name: "Calendar" }).getByRole("button", { name: "Repair intake" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible();
}

async function bookTenAm(page: Page, customer: string | null) {
  await page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" }).click();
  const sheet = page.getByRole("dialog", { name: "Book an appointment" });
  if (customer) {
    await sheet.getByLabel(/^Who is it for\?/).fill(customer.split(" ")[0]!);
    await sheet.getByRole("list", { name: "Matching customers" }).getByRole("button", { name: new RegExp(customer) }).click();
    await sheet.getByRole("button", { name: `Book 10:00 AM for ${customer}` }).click();
  } else {
    await sheet.getByRole("button", { name: "Book 10:00 AM" }).click();
  }
  await expect(sheet).toBeHidden();
}

test("cancels a booking for a customer, emails them, and opens the time again", async ({ page }, info) => {
  await openRepairDay(page);
  await bookTenAm(page, CUSTOMER);
  const booked = page.getByRole("region", { name: "Booked" });
  const row = booked.getByRole("listitem").filter({ hasText: CUSTOMER });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" })).toHaveCount(0);

  await row.getByRole("button", { name: "Cancel the booking at 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(CUSTOMER);
  await expect(dialog.getByRole("switch", { name: new RegExp(`Email ${CUSTOMER}`) })).toBeChecked();
  await dialog.getByLabel("Reason (your team sees it, the customer does not)").fill("Shop closed for the day");
  await expectDialogInset(page);
  await viewportShot(page, "booking-cancel-sheet", info.project.name);
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("status").getByText(/^Cancelled .*\. An email to .* is queued\.$/)).toBeVisible();
  await expect(booked.getByRole("listitem").filter({ hasText: CUSTOMER })).toHaveCount(0);
  // The freed time is open again.
  await expect(page.getByRole("region", { name: "Open times" }).getByRole("button", { name: "Book 10:00 AM" })).toBeVisible();
  const cancels = await writes(page, "booking.cancel");
  expect(cancels.map((write) => [write.outcome, write.payload])).toEqual([
    ["applied", { bookingId: expect.any(String), reason: "Shop closed for the day", notifyCustomer: true }],
  ]);
});

test("cancels without telling the customer when the switch is off", async ({ page }) => {
  await openRepairDay(page);
  await bookTenAm(page, CUSTOMER);
  const row = page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ hasText: CUSTOMER });
  await row.getByRole("button", { name: "Cancel the booking at 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await dialog.getByRole("switch", { name: new RegExp(`Email ${CUSTOMER}`) }).click();
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").getByText(/No email was sent\.$/)).toBeVisible();
  expect((await writes(page, "booking.cancel")).map((write) => write.payload)).toEqual([
    { bookingId: expect.any(String), reason: null, notifyCustomer: false },
  ]);
});

test("a booking with no customer says no email will be sent, and Keep booking changes nothing", async ({ page }) => {
  await openRepairDay(page);
  await bookTenAm(page, null);
  const booked = page.getByRole("region", { name: "Booked" });
  const row = booked.getByRole("listitem").filter({ hasText: "No customer linked" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Cancel the booking at 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await expect(dialog).toContainText("no email will be sent");
  await expect(dialog.getByRole("switch")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Keep booking" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(1);
  expect(await writes(page, "booking.cancel")).toEqual([]);
});

test("cancelling a booking with no customer sends the default and the server answers no customer", async ({ page }) => {
  await openRepairDay(page);
  await bookTenAm(page, null);
  const booked = page.getByRole("region", { name: "Booked" });
  const row = booked.getByRole("listitem").filter({ hasText: "No customer linked" });
  await row.getByRole("button", { name: "Cancel the booking at 10:00 AM" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  await expect(dialog).toBeHidden();
  await expect(booked.getByRole("listitem").filter({ hasText: "No customer linked" })).toHaveCount(0);
  expect((await writes(page, "booking.cancel")).map((write) => write.payload)).toEqual([
    { bookingId: expect.any(String), reason: null, notifyCustomer: true },
  ]);
});
