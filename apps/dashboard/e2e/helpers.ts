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
