import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const PAGES = [
  { path: "/", heading: "This week" },
  { path: "/inbox", heading: "Inbox" },
  { path: "/calendar", heading: "Calendar" },
  { path: "/customers", heading: "Customers" },
  { path: "/customers?view=pipeline", heading: "Customers" },
  { path: "/site", heading: "Site" },
  { path: "/agents", heading: "Agents" },
  { path: "/account/settings", heading: "Settings" },
  { path: "/account/connections", heading: "Connections" },
  { path: "/account/plan", heading: "Plan" },
];

async function open(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Interactive elements smaller than 44 by 44 CSS px (1px slop), ignoring hidden ones. */
function smallTargets(page: Page) {
  return page.evaluate(() => {
    const selector = "a[href], button, select, input:not([type=hidden]), textarea, [role=switch], [role=menuitem]";
    return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      // Skip what is not on screen: display none, sr-only (1px) and the skip link until focused.
      if (box.width <= 1 || box.height <= 1 || style.visibility === "hidden") return [];
      if (box.width >= 43 && box.height >= 43) return [];
      return [`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`];
    });
  });
}

/** label[for] that points at nothing, or at something that is not a form control. */
function brokenLabels(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll("label[for]")].flatMap((label) => {
    const target = document.getElementById(label.getAttribute("for")!);
    const ok = target !== null && ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "METER", "OUTPUT", "PROGRESS"].includes(target.tagName);
    return ok ? [] : [`label "${label.textContent?.trim()}" -> ${target?.tagName ?? "nothing"}`];
  }));
}

/** Disabled buttons whose reason is not on screen: they need aria-describedby to visible text. */
function silentDisabled(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button:disabled, [role=switch][disabled]")].flatMap((button) => {
    if (button.getBoundingClientRect().width <= 1 || button.getAttribute("aria-busy") === "true") return [];
    // The label itself says what to do ("Pick a time").
    if (/^Pick /.test(button.textContent ?? "")) return [];
    const reasons = (button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null && node.getBoundingClientRect().height > 0 && (node.textContent ?? "").trim() !== "");
    return reasons.length > 0 ? [] : [`"${(button.getAttribute("aria-label") ?? button.textContent ?? "").trim()}"`];
  }));
}

/** Tab through the page; report any focus ring an overflow ancestor cuts off. */
async function clippedFocusRings(page: Page, maxTabs = 45) {
  const problems = new Set<string>();
  await page.locator("body").focus();
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab");
    const issue = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      const name = `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}"`;
      if (style.outlineStyle === "none" || parseFloat(style.outlineWidth) < 2) return `${name} has no visible focus outline`;
      const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const box = element.getBoundingClientRect();
      const ring = { left: box.left - reach, right: box.right + reach, top: box.top - reach, bottom: box.bottom + reach };
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const clip = getComputedStyle(node);
        const area = node.getBoundingClientRect();
        const inner = { left: area.left + node.clientLeft, top: area.top + node.clientTop, right: area.left + node.clientLeft + node.clientWidth, bottom: area.top + node.clientTop + node.clientHeight };
        const cutX = clip.overflowX !== "visible" && (ring.left < inner.left - 1 || ring.right > inner.right + 1);
        const cutY = clip.overflowY !== "visible" && (ring.top < inner.top - 1 || ring.bottom > inner.bottom + 1);
        if (cutX || cutY) return `${name} ring clipped by ${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 3).join(".")}`;
      }
      return null;
    });
    if (issue) problems.add(issue);
  }
  return [...problems];
}

test.describe("accessibility", () => {
  for (const { path, heading } of PAGES) {
    test(`${path} has no serious axe issues, small targets, broken labels, silent disabled buttons or clipped focus`, async ({ page }) => {
      await open(page, path, heading);
      // The default rule set: every WCAG A and AA rule axe ships as stable, plus best practices.
      const axe = await new AxeBuilder({ page }).analyze();
      const serious = axe.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(", ")}`);
      expect(serious, "serious or critical axe violations").toEqual([]);
      expect(await smallTargets(page), "targets under 44px").toEqual([]);
      expect(await brokenLabels(page), "labels without a control").toEqual([]);
      expect(await silentDisabled(page), "disabled buttons without a visible reason").toEqual([]);
      expect(await clippedFocusRings(page), "focus rings").toEqual([]);
    });
  }

  // The light theme has its own colour values, so every page gets a contrast pass in it too.
  for (const { path, heading } of PAGES) {
    test(`${path} meets text contrast in the light theme`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("zs-theme", "light"));
      await open(page, path, heading);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      const failures = axe.violations.flatMap((violation) => violation.nodes.slice(0, 5).map((node) => node.target.join(" ")));
      expect(failures, "light-theme contrast").toEqual([]);
    });
  }

  test("the site editor's labels all point at controls, and its disabled buttons say why", async ({ page }) => {
    await open(page, "/site", "Site");
    await page.getByRole("button", { name: "Edit site" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await brokenLabels(page)).toEqual([]);
    expect(await silentDisabled(page)).toEqual([]);
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id)).toEqual([]);
  });

  test("an open conversation keeps one visible h1 and takes focus", async ({ page }) => {
    await open(page, "/inbox", "Inbox");
    const first = page.getByRole("main").getByRole("listitem").getByRole("link").first();
    const name = (await first.locator("span.truncate").first().textContent())!.trim();
    await first.click();
    await expect(page).toHaveURL(/\/inbox\/.+/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name })).toBeFocused();
  });

  test("toasts can be dismissed from the keyboard and stay at least ten seconds", async ({ page }, info) => {
    await page.clock.install();
    await page.goto("/customers?view=pipeline");
    if (info.project.name === "phone") await page.getByRole("button", { name: /^Design/ }).click();
    await expect(page.locator("[data-fetching]")).toHaveCount(0);
    // Record, in page time, when each toast is added and removed.
    await page.evaluate(() => {
      const log: { added?: number; removed?: number } = {};
      (window as unknown as { __toastLog: typeof log }).__toastLog = log;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.addedNodes.length > 0) log.added ??= Date.now();
          if (record.removedNodes.length > 0) log.removed ??= Date.now();
        }
      }).observe(document.querySelector("[role=status][aria-live]")!, { childList: true });
    });
    const ring = page.locator("[data-deal-id]").filter({ hasText: "Custom engagement ring, 2 ct oval" });
    await ring.getByRole("combobox").selectOption({ label: "Deposit" });
    const toast = page.getByTestId("toast").filter({ hasText: "Moved to Deposit." });
    await expect(toast).toBeVisible();
    await page.clock.runFor(11_000);
    await expect(toast).toHaveCount(0);
    const shown = await page.evaluate(() => {
      const log = (window as unknown as { __toastLog: { added: number; removed: number } }).__toastLog;
      return log.removed - log.added;
    });
    expect(shown, "ms the toast stayed").toBeGreaterThanOrEqual(10_000);

    // A second toast: reach its Dismiss button with the keyboard and close it.
    if (info.project.name === "phone") await page.getByRole("button", { name: /^Deposit/ }).click();
    await ring.getByRole("combobox").selectOption({ label: "Design" });
    const next = page.getByTestId("toast").filter({ hasText: "Moved to Design." });
    await expect(next).toBeVisible();
    const dismiss = next.getByRole("button", { name: "Dismiss" });
    await dismiss.focus();
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(next).toHaveCount(0);
  });
});
