import { readFileSync } from "node:fs";
import { expect, test, type Frame, type Page } from "@playwright/test";

// public-intake.md P-16: the host page themes the embedded booker with --zs-booking-* custom
// properties; the frame grows with its content and never scrolls inside itself. Runs under the
// booking page's real CSP (no inline style), at 390 px (phone) and 1440 px (desktop).
const SITE = "https://site.test";
const ORIGIN = "https://book.test";
const KEY = `zsb1_${"Th3m_".repeat(13).slice(0, 64)}`;
const RESOURCE_ID = "2b7c9d1e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors *";
const NOW = new Date("2026-11-10T12:00:00.000Z");

const asset = (name: string) => readFileSync(new URL(`../../api/static/${name}`, import.meta.url), "utf8");

const HOST = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 16px; background: #000; }
  .dark {
    --zs-booking-bg: #111113; --zs-booking-surface: #000000; --zs-booking-text: #ffffff;
    --zs-booking-muted: #8a8a93; --zs-booking-accent: #5b4cff; --zs-booking-accent-text: #ffffff;
    --zs-booking-border: #2a2a30; --zs-booking-link: #a99fff; --zs-booking-error: #ff6b5e;
    --zs-booking-radius: 12px; --zs-booking-font: Geist, -apple-system, "Segoe UI", sans-serif;
  }
</style></head><body>
<div id="plain" data-zs-booking="${KEY}"></div>
<div id="dark" class="dark" data-zs-booking="${KEY}" data-zs-header="hidden"></div>
<script src="${ORIGIN}/embed.js" async></script>
</body></html>`;

function slots() {
  const day = new Date(NOW);
  day.setUTCHours(0, 0, 0, 0);
  return [1, 2, 3].flatMap((offset) => [15, 16, 17, 18].map((hour) => {
    const start = new Date(day.getTime() + offset * 86_400_000 + hour * 3_600_000);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1_800_000).toISOString() };
  }));
}

async function serve(page: Page) {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${SITE}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: HOST }));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const js = { contentType: "text/javascript; charset=utf-8" };
    if (url.pathname === `/book/${KEY}`) return route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: asset("book.html") });
    if (url.pathname === "/booker.js") return route.fulfill({ ...js, body: asset("booker.js") });
    if (url.pathname === "/embed.js") return route.fulfill({ ...js, body: asset("embed.js") });
    if (url.pathname === "/booker.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: asset("booker.css") });
    if (url.pathname === `/public/v1/pages/${KEY}`) {
      return route.fulfill(json({
        businessName: "Northside Studio", title: "Book a consult", description: "A short call to plan your first visit.",
        resources: [{ id: RESOURCE_ID, name: "Consult", timeZone: "America/Chicago", slotLengthMinutes: 30 }],
        disclosure: { version: "v1", text: "We may send updates about this booking." },
      }));
    }
    if (url.pathname === `/public/v1/pages/${KEY}/slots`) return route.fulfill(json({ resourceId: RESOURCE_ID, slots: slots() }));
    return route.fulfill({ status: 404, body: "" });
  });
}

async function frames(page: Page): Promise<{ plain: Frame; dark: Frame }> {
  const frameOf = async (id: string) => {
    const handle = await page.locator(`#${id} iframe`).elementHandle();
    const frame = await handle!.contentFrame();
    await expect(frame!.getByRole("heading", { name: "Pick a day" })).toBeVisible();
    return frame!;
  };
  return { plain: await frameOf("plain"), dark: await frameOf("dark") };
}

const styleOf = (frame: Frame, selector: string, property: string) =>
  frame.locator(selector).first().evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);

/** The frame's content fits it: no inner scroll bar, now and after the content shrinks. */
async function expectNoInnerScroll(page: Page, id: string, frame: Frame) {
  await expect.poll(async () => {
    const outer = await page.locator(`#${id} iframe`).evaluate((el) => el.getBoundingClientRect().height);
    const inner = await frame.evaluate(() => document.documentElement.scrollHeight);
    return inner <= Math.ceil(outer) + 1;
  }).toBe(true);
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test.use({ timezoneId: "America/Chicago" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await serve(page);
  await page.goto(`${SITE}/`);
});

test("an embed that sets nothing keeps today's look", async ({ page }) => {
  const { plain } = await frames(page);
  expect(await styleOf(plain, "body", "background-color")).toBe("rgb(255, 255, 255)");
  expect(await styleOf(plain, "body", "color")).toBe("rgb(29, 35, 42)");
  expect(await styleOf(plain, "body", "font-family")).toBe(`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`);
  expect(await styleOf(plain, ".booker-choice", "border-color")).toBe("rgb(216, 221, 227)");
  expect(await styleOf(plain, ".booker-choice", "border-radius")).toBe("8px");
  expect(await styleOf(plain, "h1", "position")).not.toBe("absolute");
  expect(await plain.evaluate(() => document.documentElement.getAttribute("style"))).toBeNull();
});

test("the host's --zs-booking-* properties theme the frame under its CSP", async ({ page }) => {
  const { dark } = await frames(page);
  expect(await styleOf(dark, "body", "background-color")).toBe("rgb(17, 17, 19)");
  expect(await styleOf(dark, "body", "color")).toBe("rgb(255, 255, 255)");
  expect(await styleOf(dark, "body", "font-family")).toBe(`Geist, -apple-system, "Segoe UI", sans-serif`);
  expect(await styleOf(dark, ".booker-choice", "background-color")).toBe("rgb(0, 0, 0)");
  expect(await styleOf(dark, ".booker-choice", "border-color")).toBe("rgb(42, 42, 48)");
  expect(await styleOf(dark, ".booker-choice", "border-radius")).toBe("12px");
  expect(await styleOf(dark, ".booker-choice small", "color")).toBe("rgb(138, 138, 147)");
  expect(await styleOf(dark, ":root", "color-scheme")).toBe("dark");
  // The header is for screen readers only; the heading is still there.
  expect(await styleOf(dark, "h1", "position")).toBe("absolute");
  await expect(dark.getByRole("heading", { name: "Book a consult" })).toBeAttached();

  await dark.locator(".booker-grid button").first().click();
  await expect(dark.locator(".booker-link")).toBeVisible();
  expect(await styleOf(dark, ".booker-link", "color")).toBe("rgb(169, 159, 255)");
  await dark.locator(".booker-grid button").first().click();
  expect(await styleOf(dark, ".booker-primary", "background-color")).toBe("rgb(91, 76, 255)");
  expect(await styleOf(dark, ".booker-primary", "color")).toBe("rgb(255, 255, 255)");
  expect(await styleOf(dark, "#booker-name", "background-color")).toBe("rgb(0, 0, 0)");
  expect(await styleOf(dark, "#booker-name", "color")).toBe("rgb(255, 255, 255)");
});

test("a hostile value in the page URL is dropped", async ({ page }) => {
  const evil: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).hostname === "evil.test") evil.push(request.url()); });
  const query = new URLSearchParams({ bg: "red;}body{background:url(https://evil.test/x)}", font: `x";}*{color:red}`, accent: "url(https://evil.test/a)" });
  await page.goto(`${ORIGIN}/book/${KEY}?${query}`);
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBeNull();
  expect(evil).toEqual([]);
});

test("each step fits its content, with 44 px targets and visible focus", async ({ page }) => {
  const { plain, dark } = await frames(page);
  for (const [id, frame] of [["plain", plain], ["dark", dark]] as const) {
    await expectNoInnerScroll(page, id, frame);
    const dateHeight = await page.locator(`#${id} iframe`).evaluate((el) => el.getBoundingClientRect().height);

    const day = frame.locator(".booker-grid button").first();
    await day.focus();
    await day.press("Tab");
    expect(await frame.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      return [active.tagName, getComputedStyle(active).outlineStyle];
    })).toEqual(["BUTTON", "solid"]);
    await day.click();
    await expectNoInnerScroll(page, id, frame);
    await frame.locator(".booker-grid button").first().click();
    await expect(frame.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expectNoInnerScroll(page, id, frame);

    const small = await frame.evaluate(() => [...document.querySelectorAll<HTMLElement>("button, input:not([type=checkbox]), textarea, .booker-check")]
      .filter((el) => el.offsetParent !== null && !el.closest(".booker-trap"))
      .map((el) => ({ text: el.textContent?.trim() || el.id, ...el.getBoundingClientRect().toJSON() as DOMRect }))
      .filter((box) => box.height < 44 || box.width < 44));
    expect(small).toEqual([]);

    // Back to the shorter day list: the frame shrinks again instead of keeping its tallest height.
    await frame.getByRole("button", { name: "Choose another time" }).click();
    await frame.getByRole("button", { name: "Back to days" }).click();
    await expect.poll(() => page.locator(`#${id} iframe`).evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(dateHeight + 1);
    await expectNoInnerScroll(page, id, frame);
  }
});

test("an element added after embed.js loaded is mounted too (single-page sites)", async ({ page }) => {
  await frames(page);
  await page.evaluate((key) => {
    const late = document.createElement("div");
    late.id = "late";
    late.setAttribute("data-zs-booking", key);
    document.body.append(late);
  }, KEY);
  await expect(page.locator("#late iframe")).toHaveCount(1);
});
