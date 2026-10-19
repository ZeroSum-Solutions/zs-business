import { expect, type Locator, type Page } from "@playwright/test";

export const SHOTS = "e2e/__screenshots__";

/** Full-page screenshot after loading settles, with a no-sideways-scroll check. */
export async function shot(page: Page, name: string, project: string, prefix = "") {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // No sideways scrolling: on phones an overflow widens the layout viewport past the device.
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  // 1px of slop: fractional layout can round scrollWidth up by one.
  expect(widths[0], `${name} overflows horizontally`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(widths[1]).toBe(page.viewportSize()!.width);
  // Pin the fixed side nav and tab bar to the page so full-page captures show them once, in place.
  await page.screenshot({
    path: `${SHOTS}/${prefix}${project}-${name}.png`,
    fullPage: true,
    style: "aside, nav.fixed { position: absolute !important; }",
  });
}

/** Viewport screenshot, for open sheets and dialogs. */
export async function viewportShot(page: Page, name: string, project: string, prefix = "") {
  await page.screenshot({ path: `${SHOTS}/${prefix}${project}-${name}.png` });
}

/** The sheet body keeps the header's inset: nothing scrolls it sideways or runs to the edge. */
export async function expectDialogInset(page: Page) {
  const dialog = page.getByRole("dialog").filter({ visible: true });
  const metrics = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>('[data-slot="dialog-body"]')!;
    const box = element.getBoundingClientRect();
    const lefts = [...body.children].map((child) => child.getBoundingClientRect().left - box.left);
    return { scrollLeft: body.scrollLeft, overflow: body.scrollWidth - body.clientWidth, minLeft: Math.min(...lefts) };
  });
  expect(metrics.scrollLeft).toBe(0);
  // 1px of slop for subpixel rounding.
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.minLeft).toBeGreaterThanOrEqual(15);
}

export function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "Main" }).filter({ visible: true });
}

export async function openAccountItem(page: Page, item: "Settings" | "Connections" | "Plan") {
  await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
  await expect(page.getByRole("heading", { level: 1, name: item })).toBeVisible();
}

/** Open the booking sheet and move to the first day that has open times. */
export async function openBookingOnFirstOpenDay(page: Page): Promise<{ dialog: Locator; slots: Locator }> {
  await page.getByRole("button", { name: "Book appointment" }).click();
  const dialog = page.getByRole("dialog", { name: "Book an appointment" });
  await expect(dialog).toBeVisible();
  // Today may be closed or fully booked.
  const dayButtons = dialog.getByRole("group").first().getByRole("button");
  const slots = dialog.getByTestId("slot-list").getByRole("button");
  for (let index = 0; index < 7; index += 1) {
    await dayButtons.nth(index).click();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
    if (await slots.count() > 0) break;
  }
  await expect(slots.first()).toBeVisible();
  return { dialog, slots };
}

/** The element is on screen and nothing (the bottom tabs, the top bar) covers its center. */
export async function expectUnobscured(target: Locator, label = "element") {
  await expect(target).toBeInViewport();
  const hit = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { ok: top !== null && (top === element || element.contains(top)), covering: top?.outerHTML.slice(0, 120) ?? null };
  });
  expect(hit.ok, `${label} is covered by ${hit.covering}`).toBe(true);
}

/**
 * Step the Calendar's day view forward, on each calendar in turn, until a website booking
 * shows. Returns its row. Website bookings land on whichever calendar the visitor picked.
 * Each step waits for the new day's heading and data, so a stale list is never read.
 */
export async function findWebsiteBooking(page: Page, name: string | RegExp, maxDays = 14): Promise<Locator> {
  const calendars = page.getByRole("group", { name: "Calendar" }).getByRole("button");
  const heading = page.locator('h2[aria-live="polite"]');
  const step = async (direction: "Next day" | "Previous day") => {
    const before = await heading.textContent();
    await page.getByRole("button", { name: direction }).click();
    await expect(heading).not.toHaveText(before ?? "");
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  };
  await page.getByRole("button", { name: "Day", exact: true }).click();
  const count = await calendars.count();
  for (let index = 0; index < Math.max(count, 1); index += 1) {
    if (count > 0) {
      await calendars.nth(index).click();
      await expect(calendars.nth(index)).toHaveAttribute("aria-pressed", "true");
    }
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    for (let day = 0; day < maxDays; day += 1) {
      const row = page.locator('li[data-source="website"]').filter({ hasText: name });
      if (await row.count() > 0) return row.first();
      if (day < maxDays - 1) await step("Next day");
    }
    // Back to the first day before trying the next calendar.
    for (let day = 0; day < maxDays - 1; day += 1) await step("Previous day");
  }
  throw new Error(`No website booking for ${String(name)} in the next ${maxDays} days`);
}
