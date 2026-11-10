import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The hosted booker (apps/api/static) shows times in the business's zone, named in words, and the
// visitor's own time only when it differs (public-intake.md P-14). A Chicago gym seen from a Pacific
// laptop must say 9:00 AM Central, not 7:00 AM.
const ORIGIN = "https://book.test";
const KEY = `zsb1_${"Zk3_-".repeat(13).slice(0, 64)}`;
const RESOURCE_ID = "2b7c9d1e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const REQUEST_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors *";

const asset = (name: string) => readFileSync(new URL(`../../api/static/${name}`, import.meta.url), "utf8");

/** 9, 10 and 11 AM Chicago (15:00Z to 17:00Z in winter; the tests pin a November clock) on the two days after `from`. */
const WINTER = new Date("2026-11-10T12:00:00.000Z");
function slotsAfter(from: string) {
  const day = new Date(from);
  day.setUTCHours(0, 0, 0, 0);
  const slots = [];
  for (const offset of [1, 2]) {
    for (const hour of [15, 16, 17]) {
      const start = new Date(day.getTime() + offset * 86_400_000 + hour * 3_600_000);
      slots.push({ startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() });
    }
  }
  return slots;
}

async function serve(page: import("@playwright/test").Page, zone: string, posted: string[]) {
  const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/book/${KEY}`) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: asset("book.html") });
    if (url.pathname === "/booker.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: asset("booker.js") });
    if (url.pathname === "/booker.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: asset("booker.css") });
    if (url.pathname === `/public/v1/pages/${KEY}`) {
      return route.fulfill(json(200, {
        businessName: "Ironside Strength",
        title: "Book a free intro session",
        description: "Meet a coach and tour the gym.",
        resources: [{ id: RESOURCE_ID, name: "Intro session", timeZone: zone, slotLengthMinutes: 60 }],
        disclosure: { version: "2026-10-01", text: "We may send updates about this booking." },
      }));
    }
    if (url.pathname === `/public/v1/pages/${KEY}/slots`) {
      return route.fulfill(json(200, { resourceId: RESOURCE_ID, timeZone: zone, zone, slots: slotsAfter(url.searchParams.get("from")!) }));
    }
    if (url.pathname === `/public/v1/pages/${KEY}/requests`) {
      const body = route.request().postData() ?? "";
      posted.push(body);
      const { startsAt } = JSON.parse(body) as { startsAt: string };
      return route.fulfill(json(201, { requestId: REQUEST_ID, status: "confirmed", resourceId: RESOURCE_ID, startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }));
    }
    return route.fulfill({ status: 404, body: "" });
  });
}

test.describe("visitor in another zone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("shows business times with the visitor's time under each, and a ten-digit US phone books as +1", async ({ page }) => {
    const posted: string[] = [];
    await page.clock.setFixedTime(WINTER);
    await serve(page, "America/Chicago", posted);
    await page.goto(`${ORIGIN}/book/${KEY}`);
    await expect(page.getByRole("heading", { name: "Pick a day" })).toBeVisible();
    await expect(page.getByText("Times are in Central Time (Chicago), local time for Ironside Strength.")).toBeVisible();
    await expect(page.getByText("America/Chicago")).toHaveCount(0);
    await page.getByRole("button", { name: /3 times$/ }).first().click();
    await expect(page.getByText("Times are in Central Time (Chicago), local time for Ironside Strength. Your time is shown under each one.")).toBeVisible();
    const first = page.locator(".booker-grid button").first();
    await expect(first).toContainText("9:00 AM");
    await expect(first).toContainText("7:00 AM your time");
    await first.click();
    await expect(page.locator(".booker-summary")).toContainText("9:00 AM – 10:00 AM Central Time (Chicago)");
    await expect(page.locator(".booker-summary")).toContainText("7:00 AM your time");
    await expect(page.getByText("For example (555) 555-0123.", { exact: false })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Dana Ruiz");
    await page.getByLabel("Email", { exact: true }).fill("dana.ruiz@example.com");
    await page.getByLabel("Phone (optional)").fill("(312) 555-0142");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
    expect((JSON.parse(posted[0]!) as { phone: string }).phone).toBe("+13125550142");
  });
});

test.describe("visitor in the business's zone", () => {
  test.use({ timezoneId: "America/Chicago" });

  test("names the zone and adds no second time", async ({ page }) => {
    await page.clock.setFixedTime(WINTER);
    await serve(page, "America/Chicago", []);
    await page.goto(`${ORIGIN}/book/${KEY}`);
    await expect(page.getByText("Times are in Central Time (Chicago), local time for Ironside Strength.")).toBeVisible();
    await page.getByRole("button", { name: /3 times$/ }).first().click();
    await expect(page.locator(".booker-grid button").first()).toHaveText("9:00 AM");
    await expect(page.getByText("your time")).toHaveCount(0);
  });
});

test.describe("business outside North America", () => {
  test.use({ timezoneId: "Europe/London" });

  test("asks for a country code and refuses a bare ten-digit number", async ({ page }) => {
    const posted: string[] = [];
    await serve(page, "Europe/London", posted);
    await page.goto(`${ORIGIN}/book/${KEY}`);
    await page.getByRole("button", { name: /3 times$/ }).first().click();
    await page.locator(".booker-grid button").first().click();
    await expect(page.getByText("Start with + and your country code.")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Ada Bell");
    await page.getByLabel("Email", { exact: true }).fill("ada.bell@example.com");
    await page.getByLabel("Phone (optional)").fill("2079460000");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByText("Please enter a full phone number with area code, or start with + and your country code.")).toBeVisible();
    expect(posted).toHaveLength(0);
  });
});

test.describe("visitor outside North America booking a US business", () => {
  test.use({ timezoneId: "America/Mexico_City" });

  test("does not read a bare ten-digit number as a US one", async ({ page }) => {
    const posted: string[] = [];
    await page.clock.setFixedTime(WINTER);
    await serve(page, "America/Chicago", posted);
    await page.goto(`${ORIGIN}/book/${KEY}`);
    await page.getByRole("button", { name: /3 times$/ }).first().click();
    await page.locator(".booker-grid button").first().click();
    await expect(page.getByText("Start with + and your country code.", { exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Luis Ortega");
    await page.getByLabel("Email", { exact: true }).fill("luis.ortega@example.com");
    await page.getByLabel("Phone (optional)").fill("5512345678");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByText("Please enter a full phone number with area code, or start with + and your country code.")).toBeVisible();
    expect(posted).toHaveLength(0);
  });
});
