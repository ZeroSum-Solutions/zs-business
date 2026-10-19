import { expect, test } from "@playwright/test";

// The night New York falls back: 1:30 AM happens at 05:30Z (EDT) and again at 06:30Z (EST).
const OCCURRENCES = [
  { label: "1:30 AM EDT", startsAt: "2026-11-01T05:30:00.000Z" },
  { label: "1:30 AM EST", startsAt: "2026-11-01T06:30:00.000Z" },
];

test("books each of the two 1:30 AMs of a fall-back night and sends its own instant", async ({ page }) => {
  // The day before, so both occurrences are still ahead.
  await page.clock.setSystemTime(new Date("2026-10-31T16:00:00Z"));
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Repair intake", exact: true }).click();
  // Open the calendars on Sunday from midnight to 4 AM, across the change.
  await page.evaluate(() => window.__zsDemo!.setOpenHours(7, [0, 240]));

  for (const occurrence of OCCURRENCES) {
    await page.getByRole("button", { name: "Book appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Book an appointment" });
    await dialog.getByRole("button", { name: "Sun Nov 1" }).click();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);

    // Each repeated time names its zone in the visible label and the accessible name.
    const slot = dialog.getByRole("button", { name: occurrence.label, exact: true });
    await expect(slot).toHaveText(occurrence.label);
    await expect(slot).toHaveAttribute("data-starts-at", occurrence.startsAt);
    await expect(dialog.getByRole("button", { name: /^1:30 AM$/ })).toHaveCount(0);
    await slot.click();

    // The confirmation says which one, and the request carries that instant.
    await dialog.getByRole("button", { name: `Book ${occurrence.label}`, exact: true }).click();
    await expect(page.getByRole("status").getByText(`Booked Sun, Nov 1 at ${occurrence.label}.`)).toBeVisible();
    await expect(dialog).toBeHidden();
  }

  const bookings = (await page.evaluate(() => window.__zsDemo!.writeLog()))
    .filter((write) => write.operation === "booking.create");
  expect(bookings.map((write) => [write.outcome, (write.payload as { startsAt: string }).startsAt]))
    .toEqual(OCCURRENCES.map((occurrence) => ["applied", occurrence.startsAt]));
});
