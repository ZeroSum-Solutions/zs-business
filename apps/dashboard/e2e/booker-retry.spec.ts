import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

// The hosted booker (apps/api/static) on a fake origin with a mocked public API, so the
// retry rules can be checked without the real server: a lost or 5xx reply keeps the key and
// the exact body, and a definitive answer ends the attempt.
const ORIGIN = "https://book.test";
const KEY = `zsb1_${"Qx7_-".repeat(13).slice(0, 64)}`;
const RESOURCE_ID = "6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b";
const REQUEST_ID = "0b9e8d7c-6f5a-4b3c-8d2e-1f0a9b8c7d6e";
// Same policy the API sends with the page (apps/api/src/public/assets.ts), so it runs as in production.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors *";

const asset = (name: string) => readFileSync(new URL(`../../api/static/${name}`, import.meta.url), "utf8");

interface Posted { key: string | null; body: string }

/** Free times on the two days after `from`, in UTC, so the test never depends on today's date. */
function slotsAfter(from: string, taken: ReadonlySet<string>) {
  const day = new Date(from);
  day.setUTCHours(0, 0, 0, 0);
  const slots = [];
  for (const offset of [1, 2]) {
    for (const hour of [9, 10, 11]) {
      const start = new Date(day.getTime() + offset * 86_400_000 + hour * 3_600_000);
      const startsAt = start.toISOString();
      if (taken.has(startsAt)) continue;
      slots.push({ startsAt, endsAt: new Date(start.getTime() + 3_600_000).toISOString(), localStart: startsAt.slice(0, 19) });
    }
  }
  return slots;
}

/** Serve the page and assets; answer each POST with the next handler in `replies`. */
async function mockBooker(page: Page, replies: ((route: Route, posted: Posted) => Promise<void>)[]) {
  const posted: Posted[] = [];
  const taken = new Set<string>();
  let slotFetches = 0;
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `/book/${KEY}`) {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: asset("book.html") });
    }
    if (url.pathname === "/booker.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: asset("booker.js") });
    if (url.pathname === "/booker.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: asset("booker.css") });
    if (url.pathname === `/public/v1/pages/${KEY}`) {
      return json(route, 200, {
        businessName: "Halden & Rowe",
        title: "Book a fitting",
        description: null,
        resources: [{ id: RESOURCE_ID, name: "Fitting", timeZone: "UTC", slotLengthMinutes: 60 }],
        disclosure: { version: "2026-10-01", text: "We may send updates about this booking." },
      });
    }
    if (url.pathname === `/public/v1/pages/${KEY}/slots`) {
      slotFetches += 1;
      return json(route, 200, { resourceId: RESOURCE_ID, timeZone: "UTC", zone: "UTC", slots: slotsAfter(url.searchParams.get("from")!, taken) });
    }
    if (url.pathname === `/public/v1/pages/${KEY}/requests` && request.method() === "POST") {
      const entry = { key: request.headers()["idempotency-key"] ?? null, body: request.postData() ?? "" };
      posted.push(entry);
      const reply = replies[posted.length - 1];
      if (!reply) throw new Error(`unexpected POST #${posted.length}`);
      return reply(route, entry);
    }
    return route.fulfill({ status: 404, body: "" });
  });

  return {
    posted,
    slotFetches: () => slotFetches,
    /** The slot is now held, as it would be after the first request committed. */
    take: (startsAt: string) => taken.add(startsAt),
    confirmed: (route: Route, entry: Posted) => {
      const { resourceId, startsAt } = JSON.parse(entry.body) as { resourceId: string; startsAt: string };
      taken.add(startsAt);
      return json(route, 201, { requestId: REQUEST_ID, status: "confirmed", resourceId, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() });
    },
    slotUnavailable: (route: Route, entry: Posted) => {
      taken.add((JSON.parse(entry.body) as { startsAt: string }).startsAt);
      return json(route, 409, { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "slot_unavailable" } } });
    },
  };
}

async function pickTimeAndFill(page: Page, timeIndex = 0) {
  await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
  await page.getByRole("button", { name: /\d+ times?$/ }).first().click();
  await page.locator(".booker-grid button").nth(timeIndex).click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Ines Varga");
  await page.getByLabel("Email", { exact: true }).fill("ines.varga@example.com");
  await page.getByLabel("Email me updates").check();
}

test.use({ timezoneId: "UTC" });

for (const failure of ["gateway 502", "lost connection"] as const) {
  test(`retries a committed request after a ${failure} with the same key and body`, async ({ page }) => {
    const mock = await mockBooker(page, [
      async (route, entry) => {
        // The request commits and holds the slot, then the reply never makes it back.
        mock.take((JSON.parse(entry.body) as { startsAt: string }).startsAt);
        if (failure === "gateway 502") await route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" });
        else await route.abort("connectionreset");
      },
      (route, entry) => mock.confirmed(route, entry),
    ]);
    await page.goto(`${ORIGIN}/book/${KEY}`);
    await pickTimeAndFill(page);
    await page.getByRole("button", { name: "Confirm booking" }).click();

    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("may already have gone through");
    await expect(page.getByRole("alert")).toContainText("will not book you twice");
    // The details are shown as sent, not as an editable form.
    await expect(page.getByText("Name: Ines Varga")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);

    // A focus refresh meanwhile must not call the slot lost: it holds off until the retry answers.
    const fetchesBefore = mock.slotFetches();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: "That time is no longer available" })).toHaveCount(0);
    expect(mock.slotFetches()).toBe(fetchesBefore);
    await expect(retry).toBeVisible();

    await retry.click();
    await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
    expect(mock.posted).toHaveLength(2);
    expect(mock.posted[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(mock.posted[1]!.key).toBe(mock.posted[0]!.key);
    expect(mock.posted[1]!.body).toBe(mock.posted[0]!.body);
  });
}

test("a definitive slot_unavailable ends the attempt; the next time gets a new key", async ({ page }) => {
  const mock = await mockBooker(page, [
    (route, entry) => mock.slotUnavailable(route, entry),
    (route, entry) => mock.confirmed(route, entry),
  ]);
  await page.goto(`${ORIGIN}/book/${KEY}`);
  await pickTimeAndFill(page);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { name: "That time is no longer available" })).toBeVisible();
  await page.getByRole("button", { name: "See free times" }).click();
  await page.getByRole("button", { name: /\d+ times?$/ }).first().click();
  await page.locator(".booker-grid button").first().click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();

  expect(mock.posted).toHaveLength(2);
  const [first, second] = mock.posted.map((entry) => ({ key: entry.key, startsAt: (JSON.parse(entry.body) as { startsAt: string }).startsAt }));
  expect(second!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(second!.key).not.toBe(first!.key);
  expect(second!.startsAt).not.toBe(first!.startsAt);
});
