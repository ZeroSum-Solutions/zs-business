import { expect, test } from "@playwright/test";

// UI audit U2: what only a browser shows on Calendar and Customers. Focus after an action
// removed the focused control, layout at 390px, and the offline note.

test.describe("calendar", () => {
  test("after booking an open time, focus lands on the Booked heading, not the page (U2-3)", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
    const open = page.getByRole("region", { name: "Open times" }).getByRole("button", { name: /^Book / });
    // Today may be closed or fully booked.
    for (let day = 0; day < 7 && (await open.count()) === 0; day += 1) {
      await page.getByRole("button", { name: "Next day" }).click();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    }
    const slot = open.first();
    await slot.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Book an appointment" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Book \d/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeFocused();
  });

  test("the booking sheet never offers a past day first (U2-12)", async ({ page }) => {
    await page.goto("/calendar");
    await page.getByRole("button", { name: "Previous day" }).click();
    await page.getByRole("button", { name: "Book appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Book an appointment" });
    const first = dialog.getByRole("group").first().getByRole("button").first();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    const fromPastDay = await first.textContent();
    // Opened from today, the sheet starts on the same day.
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await page.getByRole("button", { name: "Today" }).click();
    await page.getByRole("button", { name: "Book appointment" }).click();
    await expect(first).toHaveText(fromPastDay!);
  });

  test("shows the offline note as soon as the browser is offline, not loading bars (V-5)", async ({ page, context }) => {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible();
    await context.setOffline(true);
    // A day not read yet: its reads wait for the network.
    await page.getByRole("button", { name: "Next day" }).click();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("You look offline");
    await context.setOffline(false);
    await expect(page.getByRole("heading", { level: 2, name: "Booked" })).toBeVisible();
  });

  test("keeps the date on one line beside the day buttons, and the embed code uncut (V-6, V-11)", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "phone layout");
    await page.goto("/calendar");
    await page.getByRole("button", { name: "Previous day" }).click();
    const today = page.getByRole("button", { name: "Today" });
    await expect(today).toBeVisible();
    const date = page.locator("main h2[aria-live]");
    const lineHeight = await date.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect((await date.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
    const embed = page.getByLabel("Embed code to paste into your website").first();
    await expect(embed).toBeVisible();
    const sizes = await embed.evaluate((element) => [element.scrollHeight, element.clientHeight]);
    expect(sizes[0]!).toBeLessThanOrEqual(sizes[1]! + 1);
  });
});

test.describe("customers", () => {
  test("after a stage move, focus stays on the moved deal's stage select (U2-4)", async ({ page }, info) => {
    await page.goto("/customers?view=pipeline");
    if (info.project.name === "phone") await page.getByRole("button", { name: /^Design/ }).click();
    await expect(page.locator("[data-fetching]")).toHaveCount(0);
    const ring = page.locator("[data-deal-id]").filter({ hasText: "Custom engagement ring, 2 ct oval" });
    const select = ring.getByRole("combobox");
    await select.focus();
    await select.selectOption({ label: "Deposit" });
    await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();
    await expect(ring.getByRole("combobox")).toBeFocused();
    await expect(ring).toBeVisible();
    // On a phone the stage filter followed the deal.
    if (info.project.name === "phone") await expect(page.getByRole("button", { name: /^Deposit/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("shows every stage chip on a phone without sideways scrolling (V-15)", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "phone layout");
    await page.goto("/customers?view=pipeline");
    const chips = page.getByRole("group", { name: "Stage" }).getByRole("button");
    await expect(chips.first()).toBeVisible();
    for (const chip of await chips.all()) await expect(chip).toBeInViewport({ ratio: 1 });
  });

  test("puts deal value errors right under the fields (V-20)", async ({ page }) => {
    await page.goto("/customers?view=pipeline");
    await page.getByRole("button", { name: /^Edit details of / }).first().click();
    const dialog = page.getByRole("dialog", { name: "Deal details" });
    await dialog.getByLabel("Currency").fill("JPY");
    await dialog.getByLabel("Value").fill("12,500.50");
    await dialog.getByRole("button", { name: "Save details" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toHaveText("Enter a whole amount like 1250.");
    await expect(dialog.getByLabel("Value")).toHaveAccessibleDescription(/Enter a whole amount like 1250\./);
    const [error, help] = await Promise.all([alert.boundingBox(), dialog.getByText("Leave the value empty if it is not known yet.").boundingBox()]);
    expect(error!.y).toBeLessThan(help!.y);
  });

  test("the phone field shows its example as a hint, and an empty save marks email and phone (V-7)", async ({ page }) => {
    await page.goto("/customers");
    await page.getByRole("button", { name: "Add customer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a customer" });
    const phone = dialog.getByLabel("Phone");
    await expect(phone).not.toHaveAttribute("placeholder");
    await expect(phone).toHaveAccessibleDescription("With country code, like +1 212 555 0142.");
    await dialog.getByRole("button", { name: "Save customer" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Add an email or a phone number.");
    await expect(dialog.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expect(phone).toHaveAttribute("aria-invalid", "true");
  });

  test("a search shows its results right under the search box (V-9)", async ({ page }) => {
    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "Website bookings to review" })).toBeVisible();
    await page.getByLabel("Search customers").fill("zzzz");
    await expect(page.getByText("No customers match")).toBeInViewport();
    await expect(page.getByRole("heading", { name: "Website bookings to review" })).toHaveCount(0);
  });

  test("an unknown customer says so in a heading, with a way back and no retry (U2-13)", async ({ page }) => {
    await page.goto("/customers/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { level: 1, name: "Customer not found" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to customers" })).toBeVisible();
  });
});
