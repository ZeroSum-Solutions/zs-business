import { expect, test, type Locator, type Page } from "@playwright/test";
import { openBookingOnFirstOpenDay } from "./helpers";

const OFFLINE = "You look offline. Check your connection and try again.";

const writeLog = (page: Page) => page.evaluate(() => window.__zsDemo!.writeLog());

async function slotStarts(dialog: Locator): Promise<string[]> {
  return dialog.getByTestId("slot-list").getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-starts-at")!));
}

test.describe("idempotent retries", () => {
  test("retries a deal move after a lost response with the same key", async ({ page }, info) => {
    await page.goto("/customers?view=pipeline");
    if (info.project.name === "phone") await page.getByRole("button", { name: /^Design/ }).click();
    const ring = page.locator("[data-deal-id]").filter({ hasText: "Custom engagement ring, 2 ct oval" });
    await expect(page.locator("[data-fetching]")).toHaveCount(0);

    // The server saves the move, then the connection drops: the answer and the reload are lost.
    await page.evaluate(() => window.__zsDemo!.loseNextResponse({ goOffline: true }));
    await ring.getByRole("combobox").selectOption({ label: "Deposit" });
    await expect(page.getByRole("region", { name: "Pipeline" }).getByText(OFFLINE).first()).toBeVisible();
    await expect(page.locator("[data-fetching]")).toHaveCount(0);
    await expect(ring.locator("option:checked")).toHaveText("Design");

    // Back online, the owner tries the same move again: it replays, it is not a conflict.
    await page.evaluate(() => window.__zsDemo!.setOffline(false));
    await ring.getByRole("combobox").selectOption({ label: "Deposit" });
    await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Pipeline" }).getByRole("alert")).toHaveCount(0);

    const moves = (await writeLog(page)).filter((write) => write.operation === "crm.deal.move-stage");
    expect(moves.map((write) => write.outcome)).toEqual(["applied", "replayed"]);
    expect(moves[0]!.idempotencyKey).toBeTruthy();
    expect(moves[1]!.idempotencyKey).toBe(moves[0]!.idempotencyKey);
  });

  test("books another calendar at the same instant with a new key after a lost response", async ({ page }) => {
    await page.goto("/calendar");
    const calendar = (name: string) => page.getByRole("button", { name, exact: true });

    // Find a start both calendars offer on the same day.
    const showroom = await openBookingOnFirstOpenDay(page);
    const dayButtons = (dialog: Locator) => dialog.getByRole("group").first().getByRole("button");
    const day = await dayButtons(showroom.dialog).evaluateAll((buttons) => buttons.findIndex((button) => button.getAttribute("aria-pressed") === "true"));
    const showroomStarts = await slotStarts(showroom.dialog);
    await showroom.dialog.getByRole("button", { name: "Close" }).first().click();
    await calendar("Repair intake").click();
    await page.getByRole("button", { name: "Book appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Book an appointment" });
    await dayButtons(dialog).nth(day).click();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
    const startsAt = (await slotStarts(dialog)).find((start) => showroomStarts.includes(start));
    expect(startsAt, "a start both calendars offer").toBeTruthy();

    // Repair intake: saved, but the answer is lost.
    await page.evaluate(() => window.__zsDemo!.loseNextResponse());
    await dialog.locator(`[data-starts-at="${startsAt}"]`).click();
    await dialog.getByRole("button", { name: /^Book / }).click();
    await expect(dialog.getByText(OFFLINE)).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).first().click();

    // Showroom at the same instant is a different booking, so it must not reuse that key.
    await calendar("Showroom").click();
    await page.getByRole("button", { name: "Book appointment" }).click();
    await dayButtons(dialog).nth(day).click();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(dialog.getByText(OFFLINE)).toHaveCount(0);
    await dialog.locator(`[data-starts-at="${startsAt}"]`).click();
    await dialog.getByRole("button", { name: /^Book / }).click();
    await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();

    const bookings = (await writeLog(page)).filter((write) => write.operation === "booking.create");
    expect(bookings.map((write) => write.outcome)).toEqual(["applied", "applied"]);
    expect(bookings[1]!.idempotencyKey).not.toBe(bookings[0]!.idempotencyKey);
  });

  test("retries a booking after a lost response and gets the booking it already made", async ({ page }) => {
    await page.goto("/calendar");
    const { dialog, slots } = await openBookingOnFirstOpenDay(page);
    await slots.first().click();
    await page.evaluate(() => window.__zsDemo!.loseNextResponse());
    await dialog.getByRole("button", { name: /^Book / }).click();
    await expect(dialog.getByText(OFFLINE)).toBeVisible();
    // The slot list may not have refreshed; the same choice is still selected.
    await dialog.getByRole("button", { name: /^Book / }).click();
    await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();

    const bookings = (await writeLog(page)).filter((write) => write.operation === "booking.create");
    expect(bookings.map((write) => write.outcome)).toEqual(["applied", "replayed"]);
    expect(bookings[1]!.idempotencyKey).toBe(bookings[0]!.idempotencyKey);
  });

  test("retries a new customer after a lost response without a second record", async ({ page }) => {
    await page.goto("/customers");
    await page.getByRole("button", { name: "Add customer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a customer" });
    await dialog.getByLabel("Name").fill("Ines Vautrin");
    await dialog.getByLabel("Email").fill("ines.vautrin@example.com");
    await page.evaluate(() => window.__zsDemo!.loseNextResponse());
    await dialog.getByRole("button", { name: "Save customer" }).click();
    await expect(dialog.getByText(OFFLINE)).toBeVisible();
    await dialog.getByRole("button", { name: "Save customer" }).click();
    // A replay answers "created", as the first attempt did, so the owner lands on the new record.
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ines Vautrin" })).toBeVisible();

    const saves = (await writeLog(page)).filter((write) => write.operation === "crm.contact.create-or-find");
    expect(saves.map((write) => write.outcome)).toEqual(["applied", "replayed"]);
    expect(saves[1]!.idempotencyKey).toBe(saves[0]!.idempotencyKey);
  });
});
