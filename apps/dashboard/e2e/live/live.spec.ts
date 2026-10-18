import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CALENDAR_UNAVAILABLE, demoErrorBody } from "../../src/lib/api/errors";
import { expectDialogInset, mainNav, openBookingOnFirstOpenDay, shot, viewportShot } from "../helpers";
import { LIVE } from "./env";

const PREFIX = "live-";

/** A second person in the same business, writing straight to the API. */
function someoneElse(request: APIRequestContext) {
  const token = process.env.ZS_LIVE_OTHER_TOKEN;
  if (!token) throw new Error("Run through e2e:live so global setup can mint the tokens");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async book(resourceId: string, startsAt: string) {
      const response = await request.post(`${LIVE.apiUrl}/v1/booking/bookings`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: { resourceId, startsAt },
      });
      expect(response.status()).toBe(201);
    },
    /** Re-save the deal in its current stage: the revision moves on, the stage does not. */
    async touchDeal(title: string) {
      const page = await request.get(`${LIVE.apiUrl}/v1/crm/deals?limit=100`, { headers });
      expect(page.ok()).toBe(true);
      const deal = ((await page.json()) as { items: { id: string; title: string; pipelineId: string; stageId: string; revision: number }[] })
        .items.find((item) => item.title === title);
      if (!deal) throw new Error(`No seeded deal "${title}"`);
      const response = await request.post(`${LIVE.apiUrl}/v1/crm/deals/${deal.id}/stage`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: { pipelineId: deal.pipelineId, stageId: deal.stageId, expectedRevision: deal.revision },
      });
      expect(response.status()).toBe(200);
    },
  };
}

test("renders all six areas from the live API", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Next appointments" })).toBeVisible();
  await shot(page, "01-home", info.project.name, PREFIX);

  const areas = [
    { link: "Inbox", heading: "Inbox", file: "02-inbox" },
    { link: "Calendar", heading: "Calendar", file: "03-calendar" },
    { link: "Customers", heading: "Customers", file: "04-customers" },
    { link: "Site", heading: "Site", file: "05-site" },
    { link: "Agents", heading: "Agents", file: "06-agents" },
  ];
  for (const area of areas) {
    await mainNav(page).getByRole("link", { name: area.link }).click();
    await expect(page.getByRole("heading", { level: 1, name: area.heading })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: area.link })).toHaveAttribute("aria-current", "page");
    if (area.link === "Calendar") {
      // Both seeded calendars come from GET /v1/booking/resources.
      await expect(page.getByRole("button", { name: "Showroom", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Repair intake", exact: true })).toBeVisible();
    }
    if (area.link === "Customers") {
      // Seeded by apps/api seed:demo, not the dashboard's demo adapter.
      await expect(page.getByRole("link", { name: /Maren Ashby/ })).toBeVisible();
    }
    await shot(page, area.file, info.project.name, PREFIX);
  }

  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Pipeline" }).click();
  // Stages come from GET /v1/crm/pipelines.
  for (const stage of ["Inquiry", "Consultation", "Design", "Deposit", "Delivered"]) {
    await expect(page.getByRole("region", { name: "Pipeline" }).getByText(stage, { exact: true }).first()).toBeAttached();
  }
  await shot(page, "08-pipeline", info.project.name, PREFIX);
});

test("books a slot, then shows the conflict when another person took the time", async ({ page, request }, info) => {
  await page.goto("/calendar");
  const booking = await openBookingOnFirstOpenDay(page);
  const first = booking.slots.first();
  const firstTime = (await first.textContent()) ?? "";
  await first.click();
  await booking.dialog.getByRole("button", { name: `Book ${firstTime}` }).click();
  await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();
  await expect(booking.dialog).toBeHidden();

  const { dialog, slots } = await openBookingOnFirstOpenDay(page);
  const target = slots.first();
  const startsAt = (await target.getAttribute("data-starts-at"))!;
  const resourceId = (await dialog.getAttribute("data-resource-id"))!;
  const label = (await target.textContent()) ?? "";
  await target.click();
  await someoneElse(request).book(resourceId, startsAt);
  await dialog.getByRole("button", { name: `Book ${label}` }).click();

  await expect(dialog.getByRole("alert")).toHaveText("That time was just taken. Pick another slot.");
  await expect(dialog.locator(`[data-starts-at="${startsAt}"]`)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Pick a time" })).toBeDisabled();
  await expectDialogInset(page);
  await viewportShot(page, "13-booking-conflict", info.project.name, PREFIX);
});

test("adds a customer, then finds the existing record for a duplicate email", async ({ page }, info) => {
  const phoneProject = info.project.name === "phone";
  const name = phoneProject ? "Lior Benzaquen" : "Ottilie Marchand";
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a customer" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Email").fill(`${name.toLowerCase().replace(" ", ".")}@example.com`);
  await dialog.getByLabel("Phone").fill(phoneProject ? "+1 646 555 0177" : "+1 646 555 0178");
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await page.getByRole("link", { name: "Customers" }).first().click();
  await page.getByLabel("Search customers").fill(name.split(" ")[1]!.slice(0, 5));
  await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();

  await page.getByRole("button", { name: "Add customer" }).click();
  await dialog.getByLabel("Name").fill("M. Ashby");
  await dialog.getByLabel("Email").fill("Maren.Ashby@example.com");
  await dialog.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/existing=1/);
  await expect(page.getByText(/^Already a customer\./)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Maren Ashby" })).toBeVisible();
  await shot(page, "14-duplicate-contact", info.project.name, PREFIX);
});

test("moves a deal, and reloads when someone else changed it", async ({ page, request }, info) => {
  const phoneProject = info.project.name === "phone";
  // Each project uses its own seeded deals: both run against one database.
  const moving = phoneProject
    ? { title: "Engagement ring, oval sapphire halo", from: "Design" }
    : { title: "Signet ring with family crest", from: "Design" };
  const stale = phoneProject
    ? { title: "Heirloom brooch restoration", from: "Deposit" }
    : { title: "Pearl strand restring and clasp", from: "Consultation" };
  const card = (title: string) => page.locator("[data-deal-id]").filter({ hasText: title });

  await page.goto("/customers?view=pipeline");
  if (phoneProject) await page.getByRole("button", { name: new RegExp(`^${moving.from}`) }).click();
  await card(moving.title).getByRole("combobox").selectOption({ label: "Deposit" });
  await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();

  if (phoneProject) await page.getByRole("button", { name: new RegExp(`^${stale.from}`) }).click();
  const target = card(stale.title);
  await expect(target).toBeVisible();
  // Let the refetch after the first move land, or it could pick up the outside edit first.
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await someoneElse(request).touchDeal(stale.title);
  await target.getByRole("combobox").selectOption({ label: "Delivered" });
  await expect(page.getByRole("region", { name: "Pipeline" }).getByRole("alert")).toHaveText("Someone changed this deal. Reloaded.");
  await expect(target.locator("option:checked")).toHaveText(stale.from);
  await viewportShot(page, "15-deal-conflict", info.project.name, PREFIX);

  // After the reload the move goes through with the new revision.
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await target.getByRole("combobox").selectOption({ label: "Delivered" });
  await expect(page.getByRole("status").getByText("Moved to Delivered.")).toBeVisible();
});

test("refuses tokens with the wrong role, no issuer or too long a lifetime", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "API-only check; one project is enough");
  const refused = JSON.parse(process.env.ZS_LIVE_REFUSED_TOKENS ?? "{}") as Record<string, string>;
  expect(Object.keys(refused).sort()).toEqual(["anonRole", "noIssuer", "seedSevenDay", "tooLong"]);
  const resources = (token: string) =>
    request.get(`${LIVE.apiUrl}/v1/booking/resources`, { headers: { Authorization: `Bearer ${token}` } });
  for (const [name, token] of Object.entries(refused)) {
    const response = await resources(token);
    expect(response.status(), name).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code, name).toBe("Unauthorized");
  }
  expect((await resources(process.env.ZS_LIVE_TOKEN!)).status()).toBe(200);
});

test("answers slots for an unknown calendar with 403 and says so in the booking sheet", async ({ page, request }, info) => {
  const unknown = randomUUID();
  const response = await request.get(`${LIVE.apiUrl}/v1/booking/slots`, {
    headers: { Authorization: `Bearer ${process.env.ZS_LIVE_TOKEN}` },
    params: { resourceId: unknown, from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" },
  });
  expect(response.status()).toBe(403);
  // The demo adapter sends this exact body for the same request.
  expect(await response.json()).toEqual(demoErrorBody("Forbidden"));

  // Point the sheet's slot reads at a calendar this business does not own.
  await page.route(`${LIVE.apiUrl}/v1/booking/slots?*`, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("resourceId", unknown);
    return route.continue({ url: url.toString() });
  });
  await page.goto("/calendar");
  // The page's own open-times panel and the booking sheet both read slots.
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(CALENDAR_UNAVAILABLE);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByRole("button", { name: "Book appointment" }).click();
  const dialog = page.getByRole("dialog", { name: "Book an appointment" });
  await expect(dialog.getByRole("alert")).toHaveText(CALENDAR_UNAVAILABLE);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expectDialogInset(page);
  // Let the sheet finish opening, so the capture does not show the page through it.
  await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  await viewportShot(page, "17-calendar-unavailable", info.project.name, PREFIX);
});
