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
  // The title and description are for screen readers only; the business name stays visible.
  expect(await styleOf(dark, "h1", "position")).toBe("absolute");
  expect(await styleOf(dark, ".booker-desc", "position")).toBe("absolute");
  await expect(dark.getByRole("heading", { name: "Book a consult" })).toBeAttached();
  await expect(dark.getByText("Northside Studio", { exact: true })).toBeVisible();

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

// ---------- Fix round (PR 114): what the browser itself computes ----------

interface Problem { what: string; detail: string }

/**
 * Every visible text in the booker, measured as the browser draws it: the text colour is opaque
 * and reaches 4.5:1 against the background actually behind it (alpha layers composited), the
 * same for typed field text, and the focus ring reaches 3:1.
 */
async function unreadable(frame: Frame | Page): Promise<Problem[]> {
  return frame.evaluate(() => {
    type C = { r: number; g: number; b: number; a: number };
    const parse = (value: string): C | null => {
      let m = /^rgba?\(([^)]+)\)$/.exec(value);
      if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 }; }
      m = /^color\(srgb ([^)]+)\)$/.exec(value);
      if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0]! * 255, g: p[1]! * 255, b: p[2]! * 255, a: p[3] ?? 1 }; }
      return null;
    };
    const over = (top: C, under: C): C => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const behind = (el: Element | null): C => {
      const layers: C[] = [];
      for (let node = el; node; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let colour: C = { r: 255, g: 255, b: 255, a: 1 }; // the canvas under an unpainted root
      for (const layer of layers.reverse()) colour = over(layer, colour);
      return colour;
    };
    const lum = ({ r, g, b }: C) => {
      const [lr, lg, lb] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
    };
    const ratio = (a: C, b: C) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
    const problems: { what: string; detail: string }[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className || el.id}:${(el.textContent || (el as HTMLInputElement).id || "").trim().slice(0, 30)}`;
    const texts = [...document.querySelectorAll<HTMLElement>("h1, h2, p, small, label, legend, span, button, input:not([type=checkbox]), textarea, .booker-sub")]
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().width > 1 && !el.closest(".booker-trap") && !(el as HTMLButtonElement).disabled)
      .filter((el) => el.matches("input, textarea") || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()));
    if (texts.length === 0) problems.push({ what: "nothing", detail: "no visible text found" });
    for (const el of texts) {
      const fg = parse(getComputedStyle(el).color);
      if (!fg) { problems.push({ what: name(el), detail: `unparsed ${getComputedStyle(el).color}` }); continue; }
      if (fg.a < 1) problems.push({ what: name(el), detail: `alpha ${fg.a}` });
      const bg = behind(el);
      const r = ratio(over(fg, bg), bg);
      if (r < 4.5) problems.push({ what: name(el), detail: `${r.toFixed(2)}:1 ${getComputedStyle(el).color} on rgb(${bg.r},${bg.g},${bg.b})` });
    }
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== document.body && focused.matches(":focus-visible")) {
      const style = getComputedStyle(focused);
      const ring = parse(style.outlineColor);
      if (style.outlineStyle === "none" || !ring) problems.push({ what: `focus ${name(focused)}`, detail: "no outline" });
      else if (ratio(ring, behind(focused.parentElement)) < 3) problems.push({ what: `focus ${name(focused)}`, detail: `ring ${ratio(ring, behind(focused.parentElement)).toFixed(2)}:1` });
    }
    return problems;
  });
}

/** Walk the booker on a top-level page with these theme parameters, checking each step. */
async function walkReadable(page: Page, params: Record<string, string>) {
  await page.goto(`${ORIGIN}/book/${KEY}?${new URLSearchParams(params)}`);
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  const day = page.locator(".booker-grid button").first();
  await day.focus();
  await day.press("Tab"); // keyboard focus, so the ring is :focus-visible
  expect(await unreadable(page), "date step").toEqual([]);
  await day.click();
  await expect(page.locator(".booker-link").first()).toBeVisible();
  expect(await unreadable(page), "time step").toEqual([]);
  await page.locator(".booker-grid button").first().click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  await page.locator("#booker-name").fill("Typed name");
  await page.locator("#booker-name").press("Tab");
  expect(await unreadable(page), "details step").toEqual([]);
  // An empty submit shows the field errors; it never reaches the network (validation runs first).
  await page.locator("#booker-name").fill("");
  await page.locator(".booker-primary").click();
  await expect(page.locator(".booker-error").first()).toBeVisible();
  expect(await unreadable(page), "details with errors").toEqual([]);
}

test("the readability check itself catches faint, see-through and white-on-white text", async ({ page }) => {
  await page.goto(`${ORIGIN}/book/${KEY}`);
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  expect(await unreadable(page)).toEqual([]);
  // Bypass the gate on purpose: set tokens straight on :root from the test.
  await page.evaluate(() => document.documentElement.style.setProperty("--zs-muted", "#ffffff"));
  expect((await unreadable(page)).some((p) => /^p\.booker-sub/.test(p.what))).toBe(true);
  await page.evaluate(() => { document.documentElement.style.removeProperty("--zs-muted"); document.documentElement.style.setProperty("--zs-ink", "rgba(29, 35, 42, 0.5)"); });
  expect((await unreadable(page)).some((p) => p.detail.startsWith("alpha"))).toBe(true);
});

const COLOUR_TOKENS = ["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error"];
const every = (value: string) => Object.fromEntries(COLOUR_TOKENS.map((name) => [name, value]));

for (const value of ["transparent", "inherit", "currentcolor", "none", "notacolour", "rgb(1)", "rgb(1,2,3,)", "#ffffff00", "#0000"]) {
  test(`colour ${value} on every token is dropped and every text stays readable`, async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
    await walkReadable(page, every(value));
    expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBeNull();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(posts).toEqual([]);
  });
}

for (const [label, params] of [
  ["all tokens white", every("#ffffff")],
  ["bg=#000 alone", { bg: "#000" }],
  ["surface=#000000 alone", { surface: "#000000" }],
  ["muted white on white", { muted: "#ffffff" }],
  ["the documented plain-iframe example", { bg: "#111113", text: "#ffffff", accent: "#5b4cff" }],
] as const) {
  test(`a partial theme keeps every text readable: ${label}`, async ({ page }) => {
    await walkReadable(page, params);
  });
}

test("a dark page set alone gets light ink, not the default dark text", async ({ page }) => {
  await page.goto(`${ORIGIN}/book/${KEY}?bg=%23000`);
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe("rgb(255, 255, 255)");
  expect(await page.locator(".booker-choice").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(0, 0, 0)");
});

for (const font of ["inherit", "caption", "initial"]) {
  test(`font=${font} is dropped`, async ({ page }) => {
    await page.goto(`${ORIGIN}/book/${KEY}?font=${font}`);
    await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`);
    expect(await page.evaluate(() => document.documentElement.getAttribute("style"))).toBeNull();
  });
}

test("header=0 is ignored on a page opened on its own", async ({ page }) => {
  await page.goto(`${ORIGIN}/book/${KEY}?embed=1&header=0`);
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-header"))).toBeNull();
  expect(await page.locator("h1").evaluate((el) => getComputedStyle(el).position)).not.toBe("absolute");
  await expect(page.getByRole("heading", { name: "Book a consult" })).toBeVisible();
});

test("the first paint and a slot refresh never move focus; a click-only step change does", async ({ page }) => {
  let slotFetches = 0;
  page.on("request", (request) => { if (request.url().includes("/slots")) slotFetches += 1; });
  const { plain } = await frames(page);
  // First paint: focus stays with the host page.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  expect(await plain.evaluate(() => document.activeElement?.tagName)).toBe("BODY");

  // A slot refresh while a day button has focus keeps it there.
  const third = plain.locator(".booker-grid button").nth(2);
  await third.focus();
  const label = await third.textContent();
  const before = slotFetches;
  await plain.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => slotFetches).toBeGreaterThan(before);
  await plain.waitForTimeout(200);
  expect(await plain.evaluate(() => [document.activeElement?.tagName, document.activeElement?.textContent])).toEqual(["BUTTON", label]);

  // Assistive tech activates with a bare click event: the new step's heading takes focus.
  await plain.locator(".booker-grid button").first().evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => plain.evaluate(() => [document.activeElement?.tagName, document.activeElement?.hasAttribute("data-focus")])).toEqual(["H2", true]);
});

test("the widget mounts again after the host replaces the element's children", async ({ page }) => {
  await frames(page);
  await page.evaluate(() => document.getElementById("plain")!.replaceChildren());
  await expect(page.locator("#plain iframe")).toHaveCount(1);
  const frame = await (await page.locator("#plain iframe").elementHandle())!.contentFrame();
  await expect(frame!.getByRole("heading", { name: "Pick a day" })).toBeVisible();
});

test("an unthemed embed keeps the 480 px floor; a smaller floor is opt-in", async ({ page }) => {
  const { plain } = await frames(page);
  await expect.poll(() => page.locator("#plain iframe").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(480);
  await expectNoInnerScroll(page, "plain", plain);

  await page.evaluate((key) => {
    const small = document.createElement("div");
    small.id = "small";
    small.setAttribute("data-zs-booking", key);
    small.setAttribute("data-zs-min-height", "200");
    document.body.append(small);
  }, KEY);
  await expect(page.locator("#small iframe")).toHaveCount(1);
  expect(await page.locator("#small iframe").evaluate((el) => getComputedStyle(el).minHeight)).toBe("200px");
  const frame = await (await page.locator("#small iframe").elementHandle())!.contentFrame();
  await expect(frame!.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  // The frame follows its content, so with a 200 px floor it sits at the content's own height.
  await expect.poll(async () => {
    const outer = await page.locator("#small iframe").evaluate((el) => el.getBoundingClientRect().height);
    const inner = await frame!.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    return Math.abs(outer - Math.max(inner, 200)) <= 1;
  }).toBe(true);
});

