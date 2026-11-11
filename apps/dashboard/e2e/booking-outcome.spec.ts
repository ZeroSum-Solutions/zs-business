import { expect, test, type Page } from "@playwright/test";
import { viewportShot } from "./helpers";

// booking.md B-37..B-43: mark a started appointment Completed or No-show from the calendar and see the mark on it.
// Runs on the demo adapter, on a phone (390x844) and a desktop (1440x900).

// The repair calendar's seeded appointment starts Monday 3:00 PM in New York (19:00 UTC).
const AFTER_START = new Date("2026-10-26T21:00:00.000Z");
const BEFORE_START = new Date("2026-10-26T12:00:00.000Z");

const writes = (page: Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);

async function openRepairDay(page: Page, now: Date) {
  await page.clock.setFixedTime(now);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await page.getByRole("group", { name: "Calendar" }).getByRole("button", { name: "Repair intake" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible();
}

test("marks a started appointment Completed, then changes it to No-show", async ({ page }, info) => {
  await openRepairDay(page, AFTER_START);
  const row = page.getByRole("region", { name: "Booked" }).getByRole("listitem").filter({ has: page.getByTestId("outcome-control") });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("outcome-badge")).toHaveCount(0);
  const group = row.getByRole("group", { name: /^Outcome of the appointment at / });
  const completed = group.getByRole("button", { name: "Completed" });
  const noShow = group.getByRole("button", { name: "No-show" });
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expect(noShow).toHaveAttribute("aria-pressed", "false");
  // A touch target at phone width.
  expect((await completed.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await completed.click();
  await expect(page.getByRole("status").getByText(/^Marked .* completed\. A review request can follow\.$/)).toBeVisible();
  await expect(row.getByTestId("outcome-badge")).toHaveAttribute("data-outcome", "completed");
  await expect(row.getByTestId("outcome-badge")).toHaveText("Completed");
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await viewportShot(page, "booking-outcome-completed", info.project.name);

  await noShow.click();
  await expect(page.getByRole("status").getByText(/^Marked .* as a no-show\. A review request that has not gone out yet will not be sent\.$/)).toBeVisible();
  await expect(row.getByTestId("outcome-badge")).toHaveAttribute("data-outcome", "no_show");
  await expect(noShow).toHaveAttribute("aria-pressed", "true");
  await expect(completed).toHaveAttribute("aria-pressed", "false");

  const marks = await writes(page, "booking.outcome.set");
  expect(marks.map((write) => [write.outcome, write.payload])).toEqual([
    ["applied", { bookingId: expect.any(String), outcome: "completed" }],
    ["applied", { bookingId: expect.any(String), outcome: "no_show" }],
  ]);
  // Pressing the mark that is already set sends nothing.
  await noShow.click();
  expect(await writes(page, "booking.outcome.set")).toHaveLength(2);
});

test("an appointment that has not started shows no outcome control", async ({ page }) => {
  await openRepairDay(page, BEFORE_START);
  await expect(page.getByRole("region", { name: "Booked" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByTestId("outcome-control")).toHaveCount(0);
  expect(await writes(page, "booking.outcome.set")).toEqual([]);
});
