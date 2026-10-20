import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { CALENDAR_UNAVAILABLE, defaultMessage, demoErrorBody } from "../../src/lib/api/errors";
import { expectDialogInset, mainNav, openBookingOnFirstOpenDay, shot, viewportShot } from "../helpers";
import { LIVE } from "./env";
import { expect, lastSignInLink, ownerEmail, signInRequest, test } from "./fixtures";

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

/** The next GET of the deal list through the proxy, i.e. the refetch a move triggers. */
function waitForDealsRead(page: Page) {
  return page.waitForResponse((response) => response.request().method() === "GET" && response.url().startsWith(`${LIVE.webUrl}/api/v1/crm/deals`));
}

const apiError = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "x", details } });

test("renders all six areas from the live API", async ({ page }, info) => {
  // The browser only ever talks to the dashboard's origin, and never holds a token.
  const apiCalls: string[] = [];
  const withAuth: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(LIVE.apiUrl)) apiCalls.push(request.url());
    if (request.headers().authorization) withAuth.push(request.url());
  });
  let proxied = 0;
  page.on("response", (response) => {
    if (response.url().startsWith(`${LIVE.webUrl}/api/v1/`) && response.ok()) proxied += 1;
  });
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

  expect(proxied, "reads went through the same-origin proxy").toBeGreaterThan(0);
  expect(apiCalls, "direct calls to the API").toEqual([]);
  expect(withAuth, "browser requests with an Authorization header").toEqual([]);
  const html = await page.content();
  expect(html).not.toContain(process.env.ZS_LIVE_TOKEN!);
});

test("refuses anonymous callers and old pilot cookies with 401, and never spends a token for them", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "API-only check; one project is enough");
  // No Cookie, Authorization or Origin: the request that used to read every contact.
  for (const path of ["/api/v1/crm/contacts", "/api/v1/booking/resources", "/api/v1/crm/deals", "/api/v1/members"]) {
    const response = await request.get(`${LIVE.webUrl}${path}`);
    expect(response.status(), path).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe("Unauthorized");
  }
  expect((await request.get(`${LIVE.webUrl}/api/session`)).status()).toBe(401);
  // The retired access-code gate's cookie opens nothing, and the answer expires it.
  const pilot = await request.get(`${LIVE.webUrl}/api/v1/crm/contacts`, { headers: { Cookie: "zs_dashboard_session=v1.9999999999.abc.def" } });
  expect(pilot.status()).toBe(401);
  expect(pilot.headers()["set-cookie"]).toMatch(/zs_dashboard_session=;.*Max-Age=0/);
  // A bearer token from the caller is no way in either.
  const bearer = await request.get(`${LIVE.webUrl}/api/v1/crm/contacts`, { headers: { Authorization: `Bearer ${process.env.ZS_LIVE_TOKEN}` } });
  expect(bearer.status()).toBe(401);

  // An address with no account gets the same answer as the owner's, and no link.
  const unknown = await request.post(`${LIVE.webUrl}/api/sign-in`, { headers: { Origin: LIVE.webUrl }, data: { email: "nobody@example.com" } });
  expect(unknown.status()).toBe(204);
  expect(unknown.headers()["set-cookie"] ?? "", "no session cookie").not.toMatch(/(^|\n)zs-auth(\.\d+)?=[^;]/);
  expect(await lastSignInLink("nobody@example.com")).toBeNull();
  await signInRequest(request);
  expect((await request.get(`${LIVE.webUrl}/api/v1/crm/contacts`)).status()).toBe(200);
  const session = await request.get(`${LIVE.webUrl}/api/session`);
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ role: "owner" });
});

test("signs an anonymous visitor in by email link, and out again for good", async ({ anonymousPage: page }, info) => {
  await page.goto("/customers");
  await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toHaveCount(0);
  const link = page.getByRole("link", { name: "Sign in", exact: true });
  await expect(link).toHaveAttribute("href", "/sign-in?next=%2Fcustomers");
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Halden & Rowe" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await shot(page, "18-sign-in", info.project.name, PREFIX);
  const serious = async () => (await new AxeBuilder({ page }).analyze()).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id);
  expect(await serious()).toEqual([]);

  await page.getByLabel("Email").fill("not an email");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Enter your email address, like name@example.com.");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter your email address, like name@example.com.");
  expect(await serious()).toEqual([]);

  // No account behind the address: the page says the same as for the owner.
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toContainText("nobody@example.com");
  expect(await lastSignInLink("nobody@example.com")).toBeNull();
  expect(await serious()).toEqual([]);
  await page.getByRole("button", { name: "Use a different email" }).click();

  const before = await lastSignInLink();
  await page.getByLabel("Email").fill(ownerEmail());
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  const emailed = await lastSignInLink();
  expect(emailed).not.toBe(before);
  expect(new URL(emailed!).pathname).toBe("/auth/confirm");
  await page.goto(emailed!);
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toBeVisible();
  const cookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("zs-auth"));
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie.httpOnly, cookie.name).toBe(true);
    expect(cookie.sameSite, cookie.name).toBe("Strict");
    expect(cookie.path, cookie.name).toBe("/");
  }
  expect(await page.evaluate(() => document.cookie)).not.toContain("zs-auth");

  // A link works once.
  await page.goto(emailed!);
  await expect(page).toHaveURL(/\/sign-in\?error=link/);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("That sign-in link has expired or was already used. Ask for a new one below.");
  await page.goto("/customers");
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toBeVisible();

  // Sign out ends the session in Supabase Auth: the cookies a thief copied before are refused.
  const copied = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("zs-auth"));
  await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toBeVisible();
  await expect.poll(async () => (await page.context().cookies()).some((cookie) => cookie.name.startsWith("zs-auth"))).toBe(false);
  expect((await page.request.get("/api/v1/crm/contacts")).status()).toBe(401);
  const replay = await page.request.get("/api/v1/crm/contacts", { headers: { Cookie: copied.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } });
  expect(replay.status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toBeVisible();

  // `next` only ever leads to a page on this site: a tab would turn "/\t/x" into "//x".
  await page.goto(`/sign-in?next=${encodeURIComponent("/\t/evil.example/")}`);
  await page.getByLabel("Email").fill(ownerEmail());
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  await page.goto((await lastSignInLink())!);
  await page.waitForURL(`${LIVE.webUrl}/`);
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
});

test("never follows next off the site, even when it resolves to a path of two slashes", async ({ anonymousPage: page }) => {
  const offSite: string[] = [];
  await page.context().route((url) => url.origin !== LIVE.webUrl, (route) => {
    offSite.push(route.request().url());
    return route.abort();
  });
  for (const next of ["/.//evil.example/", "/foo/..//evil.example/", "/%2e//evil.example/"]) {
    // Raw, not encoded: the query string carries the value exactly as an attacker would link it.
    await page.goto(`/sign-in?next=${next}`);
    await page.getByLabel("Email").fill(ownerEmail());
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
    // The emailed link goes back to this site's /auth/confirm, whatever next said.
    const emailed = new URL((await lastSignInLink())!);
    expect(emailed.origin, next).toBe(LIVE.webUrl);
    expect(emailed.pathname, next).toBe("/auth/confirm");
    await page.goto(emailed.href);
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
    const landed = new URL(page.url());
    expect(landed.origin, next).toBe(LIVE.webUrl);
    expect(landed.pathname, next).not.toMatch(/^[/\\]{2}/);
    // And an attacker who edits next in a link gets no further.
    emailed.searchParams.set("next", next);
    await page.goto(emailed.href);
    expect(new URL(page.url()).origin, next).toBe(LIVE.webUrl);
  }
  expect(offSite).toEqual([]);
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
  await expect(card(moving.title)).toBeVisible();
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  // The refetch after the move must land before the outside edit, or it could pick that up.
  const refetched = waitForDealsRead(page);
  await card(moving.title).getByRole("combobox").selectOption({ label: "Deposit" });
  await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();
  await refetched;

  if (phoneProject) await page.getByRole("button", { name: new RegExp(`^${stale.from}`) }).click();
  const target = card(stale.title);
  await expect(target).toBeVisible();
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

test("refuses tokens with the wrong role, no issuer, too long a lifetime, an ended session or no membership", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "API-only check; one project is enough");
  const refused = JSON.parse(process.env.ZS_LIVE_REFUSED_TOKENS ?? "{}") as Record<string, string>;
  expect(Object.keys(refused).sort()).toEqual(["anonRole", "noIssuedAt", "noIssuer", "seedSevenDay", "signedOut", "tooLong"]);
  const resources = (token: string) =>
    request.get(`${LIVE.apiUrl}/v1/booking/resources`, { headers: { Authorization: `Bearer ${token}` } });
  for (const [name, token] of Object.entries(refused)) {
    const response = await resources(token);
    expect(response.status(), name).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code, name).toBe("Unauthorized");
  }
  expect((await resources(process.env.ZS_LIVE_TOKEN!)).status()).toBe(200);
  // A live session for a person who belongs to no business: authenticated, but forbidden.
  const outsider = await resources(process.env.ZS_LIVE_OUTSIDER_TOKEN!);
  expect(outsider.status()).toBe(403);
  expect(((await outsider.json()) as { error: { code: string } }).error.code).toBe("Forbidden");
  // Staff can use the calendar, but not the team list.
  const staff = { Authorization: `Bearer ${process.env.ZS_LIVE_OTHER_TOKEN}` };
  expect((await request.get(`${LIVE.apiUrl}/v1/booking/resources`, { headers: staff })).status()).toBe(200);
  expect((await request.get(`${LIVE.apiUrl}/v1/members`, { headers: staff })).status()).toBe(403);

  // The dashboard's proxy sends the signed-in person's token, so it must refuse other sites
  // (SameSite=Strict already keeps the cookie off cross-site requests).
  await signInRequest(request);
  const crossSite = await request.post(`${LIVE.webUrl}/api/v1/crm/contacts`, {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    data: { email: "evil@example.com" },
  });
  expect(crossSite.status()).toBe(403);
  // Without DASHBOARD_TRUST_PROXY=1 a caller's X-Forwarded-Host does not count as the host.
  const forgedHost = await request.post(`${LIVE.webUrl}/api/v1/crm/contacts`, {
    headers: { Origin: "https://evil.example", "X-Forwarded-Host": "evil.example", "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    data: { email: "evil@example.com" },
  });
  expect(forgedHost.status()).toBe(403);
  const sameOrigin = await request.get(`${LIVE.webUrl}/api/v1/booking/resources`);
  expect(sameOrigin.status()).toBe(200);
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
  await page.route(`${LIVE.webUrl}/api/v1/booking/slots?*`, (route) => {
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

test("retries a booking whose answer was lost with the same key, and the API replays it", async ({ page }) => {
  const keys: string[] = [];
  let dropped = false;
  // The first booking request reaches the API, which commits it; its answer never arrives.
  await page.route(`${LIVE.webUrl}/api/v1/booking/bookings`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    return route.abort("connectionreset");
  });
  await page.goto("/calendar");
  const { dialog, slots } = await openBookingOnFirstOpenDay(page);
  await slots.first().click();
  await dialog.getByRole("button", { name: /^Book / }).click();
  await expect(dialog.getByText("You look offline. Check your connection and try again.")).toBeVisible();
  await dialog.getByRole("button", { name: /^Book / }).click();
  await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
});

test("labels sample areas and turns off writes that would not reach the API", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  // Usage and the connections checklist still read the sample workspace; results are live.
  for (const card of ["Wallet and usage", "Connections"]) {
    await expect(page.getByRole("region", { name: card }).getByTestId("sample-badge")).toBeVisible();
  }
  for (const card of ["Next appointments", "Revenue this week"]) {
    await expect(page.getByRole("region", { name: card }).getByTestId("sample-badge")).toHaveCount(0);
  }
  if (info.project.name === "desktop") await expect(page.getByTestId("sample-note")).toHaveText("Some areas show sample data until their API ships.");

  // Bookings, customers, the Inbox and the site are live: no sample marker.
  for (const path of ["/calendar", "/customers", "/inbox", "/site"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("main").getByTestId("sample-badge")).toHaveCount(0);
  }

  const header = (name: string) => page.getByRole("main").locator("header").filter({ has: page.getByRole("heading", { level: 1, name }) });
  for (const [path, name] of [["/agents", "Agents"], ["/account/settings", "Settings"], ["/account/connections", "Connections"], ["/account/plan", "Plan"]] as const) {
    await page.goto(path);
    await expect(header(name).getByTestId("sample-badge"), name).toBeVisible();
  }

  // Plan: no cancel that only changes the sample, and the reason is on screen.
  const cancel = page.getByRole("button", { name: "Cancel plan" });
  await expect(cancel).toBeDisabled();
  await expect(cancel).toHaveAccessibleDescription(/Not available yet/);
  await expect(page.getByText(/^Not available yet/)).toBeVisible();

  await page.goto("/agents");
  await expect(page.getByRole("switch", { name: "Pause all agents" })).toBeDisabled();
  for (const button of await page.getByRole("button", { name: /^(Approve and send|Discard)$/ }).all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(/Not available yet/);
  }

  await page.goto("/account/settings");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  for (const toggle of await page.getByRole("switch").all()) await expect(toggle).toBeDisabled();
});

test("reloads and allows a retry when the API reports a concurrent update", async ({ page }, info) => {
  const title = info.project.name === "phone" ? "Engagement ring, oval sapphire halo" : "Signet ring with family crest";
  await page.route(`${LIVE.webUrl}/api/v1/crm/deals/*/stage`, (route) =>
    route.fulfill({ status: 409, json: apiError("Conflict", { reason: "concurrent_update" }) }));
  await page.goto("/customers?view=pipeline");
  if (info.project.name === "phone") await page.getByRole("button", { name: /^Design/ }).click();
  const card = page.locator("[data-deal-id]").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(page.locator("[data-fetching]")).toHaveCount(0);

  const reloaded = waitForDealsRead(page);
  await card.getByRole("combobox").selectOption({ label: "Deposit" });
  await reloaded;
  await expect(page.getByRole("region", { name: "Pipeline" }).getByRole("alert")).toHaveText("Someone changed this deal. Reloaded.");
  await expect(card.locator("option:checked")).toHaveText("Design");
  await expect(card.getByRole("combobox")).toBeEnabled();

  // The retry goes through once the API stops refusing it.
  await page.unroute(`${LIVE.webUrl}/api/v1/crm/deals/*/stage`);
  await card.getByRole("combobox").selectOption({ label: "Deposit" });
  await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();
});

test("keeps a deal unmovable, and says so, when the reload after a conflict fails", async ({ page }, info) => {
  const title = info.project.name === "phone" ? "Engagement ring, oval sapphire halo" : "Signet ring with family crest";
  const stage = `${LIVE.webUrl}/api/v1/crm/deals/*/stage`;
  await page.route(stage, (route) => route.fulfill({ status: 409, json: apiError("Conflict", { reason: "stale_revision" }) }));
  await page.goto("/customers?view=pipeline");
  if (info.project.name === "phone") await page.getByRole("button", { name: /^Design/ }).click();
  const card = page.locator("[data-deal-id]").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(page.locator("[data-fetching]")).toHaveCount(0);

  // Every reload of the deal list is cut off.
  let abort = true;
  await page.route(`${LIVE.webUrl}/api/v1/crm/deals?*`, (route) => (abort ? route.abort("connectionreset") : route.continue()));
  await card.getByRole("combobox").selectOption({ label: "Deposit" });
  const note = page.locator("#deal-reload-needed");
  await expect(note).toContainText("Someone changed this deal, but the board could not reload.", { timeout: 10_000 });
  await expect(page.getByText("Someone changed this deal. Reloaded.")).toHaveCount(0);
  await expect(card.getByRole("combobox")).toBeDisabled();
  await expect(card.locator("option:checked")).toHaveText("Design");

  abort = false;
  await page.unroute(stage);
  await note.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Pipeline" }).getByRole("alert")).toHaveText("Someone changed this deal. Reloaded.");
  await expect(card.getByRole("combobox")).toBeEnabled();
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await card.getByRole("combobox").selectOption({ label: "Deposit" });
  await expect(page.getByRole("status").getByText("Moved to Deposit.")).toBeVisible();
});

test("does not retry a 429 and asks the owner to wait", async ({ page }) => {
  let calls = 0;
  await page.route(`${LIVE.webUrl}/api/v1/crm/contacts?*`, (route) => {
    calls += 1;
    return route.fulfill({ status: 429, json: apiError("Internal") });
  });
  await page.goto("/customers");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(defaultMessage("rate_limited"));
  await page.waitForTimeout(1_500);
  expect(calls).toBe(1);
});

test("shows a signed-out screen, not Try again, when the API answers 401", async ({ page }) => {
  await page.route(`${LIVE.webUrl}/api/v1/**`, (route) => route.fulfill({ status: 401, json: apiError("Unauthorized") }));
  await page.goto("/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Your session ended" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toHaveCount(0);
});

test("pages a long customer list, searches all of it, and opens a customer it has not loaded", async ({ page }) => {
  const tenantId = "7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const fake = (index: number) => ({
    id: `5e0c1a2b-7d3f-4c8a-9b1e-${String(index).padStart(12, "0")}`, tenantId,
    displayName: `Customer ${String(index).padStart(4, "0")}`, email: null, phone: "+16465550100",
    consent: { email: null, sms: null }, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
  });
  // 2,500 customers, more than the old 2,000-row cap; the API pages and searches them.
  const searches: string[] = [];
  await page.route(`${LIVE.webUrl}/api/v1/crm/contacts?*`, (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search") ?? "";
    searches.push(search);
    // This stand-in's cursor is a row index; the dashboard only passes it back.
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const all = Array.from({ length: 2_500 }, (_, index) => fake(index + 1)).filter((item) => item.displayName.includes(search));
    const more = start + limit < all.length;
    return route.fulfill({ json: { items: all.slice(start, start + limit), limit, offset: 0, nextOffset: null, nextCursor: more ? String(start + limit) : null } });
  });
  await page.goto("/customers");
  const rows = page.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(50);
  await page.getByRole("button", { name: "Show more customers" }).click();
  await expect(rows).toHaveCount(100);

  await page.getByLabel("Search customers").pressSequentially("2499", { delay: 40 });
  await expect(page.getByRole("link", { name: /Customer 2499/ })).toBeVisible();
  await expect(rows).toHaveCount(1);
  // Typing waits for a pause: one search request, not one per key.
  expect(searches.filter((search) => search !== "")).toEqual(["2499"]);

  // The single-contact route answers for itself; an unknown customer is "not found".
  await page.goto(`/customers/${randomUUID()}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("We could not find that customer.");
});

test("says sign-out did not finish and offers Try again until the server confirms it, and a 401 posts nothing", async ({ page }) => {
  // Each POST /api/sign-out: first held then 502, then a network error, then the real server.
  const posts: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${LIVE.webUrl}/api/sign-out`, async (route) => {
    posts.push(route.request().method());
    if (posts.length === 1) {
      await held;
      return route.fulfill({ status: 502, json: { error: "unavailable" } });
    }
    if (posts.length === 2) return route.abort("failed");
    return route.continue();
  });

  // A 401 from the API ends the session on screen at once and never posts a sign-out.
  const unauthorized = `${LIVE.webUrl}/api/v1/**`;
  await page.route(unauthorized, (route) => route.fulfill({ status: 401, json: apiError("Unauthorized") }));
  await page.goto("/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Your session ended" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  await page.unroute(unauthorized);
  // The 401 was made up here, so the session is still live.
  await page.reload();
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  // While the request runs: the pages are gone, the screen says it is working on it, and
  // nothing says the session ended.
  await expect(page.getByRole("heading", { level: 1, name: "Signing out" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Ending your session…");
  await expect(page.getByRole("button", { name: "Signing out…" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("link", { name: /Maren Ashby/ })).toHaveCount(0);
  await expect(page.getByTestId("signed-out")).toHaveCount(0);
  expect(posts).toEqual(["POST"]);
  release();

  // 502: Supabase could not be told.
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toHaveText("Sign-out did not finish. Try again.");
  await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toHaveCount(0);
  await expect(page.getByTestId("signed-out")).toHaveCount(0);
  const serious = (await new AxeBuilder({ page }).analyze()).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id);
  expect(serious).toEqual([]);

  // A network error: the server may never have heard the request.
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await tryAgain.click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(alert).toHaveText("Sign-out did not finish. Try again.");
  await expect(tryAgain).toBeFocused();
  await expect(page.getByTestId("signed-out")).toHaveCount(0);
  // Neither failure reached the server, so the session really is still live: the screen was
  // right not to say it ended.
  expect((await page.request.get("/api/session")).status()).toBe(200);

  // The retry reaches the real server, which ends the session and answers 204.
  const answered = page.waitForResponse((response) => response.url() === `${LIVE.webUrl}/api/sign-out`);
  await tryAgain.click();
  expect((await answered).status()).toBe(204);
  await expect(page.getByRole("heading", { level: 1, name: "You are signed out" })).toBeVisible();
  await expect(page.getByTestId("signing-out")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(posts).toEqual(["POST", "POST", "POST"]);
  await expect.poll(async () => (await page.context().cookies()).some((cookie) => cookie.name.startsWith("zs-auth"))).toBe(false);
  expect((await page.request.get("/api/v1/crm/contacts")).status()).toBe(401);
});
