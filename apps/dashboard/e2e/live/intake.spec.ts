import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { findWebsiteBooking, mainNav, shot, viewportShot } from "../helpers";
import { LIVE } from "./env";
import { expect, test } from "./fixtures";

const PREFIX = "live-";
/**
 * A client's own website: another origin that only pastes the widget snippet. It is served
 * from loopback, because Chromium's Private Network Access rules block a public page from
 * loading a script from the loopback API; a deployed API is public, so that rule never applies.
 */
async function serveClientSite(html: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** The booking link from the Calendar card, as the owner would copy it. */
async function bookingKey(page: Page): Promise<string> {
  await page.goto("/calendar");
  const card = page.getByTestId("booking-page");
  const link = card.getByRole("link", { name: "Open booking page" });
  const href = (await link.getAttribute("href")) ?? "";
  expect(href.startsWith(`${LIVE.apiUrl}/book/zsb1_`)).toBe(true);
  await expect(card.getByLabel("Embed code to paste into your website")).toHaveValue(new RegExp(`${LIVE.apiUrl}/embed\\.js`));
  return new URL(href).pathname.split("/").at(-1)!;
}

test("books through the widget on a client's site, then the owner links the possible match", async ({ page, context }, info) => {
  const key = await bookingKey(page);
  // One changed character in the tag: the same missing page as an unpublished one.
  const forged = `${key.slice(0, -2)}${key.at(-2) === "A" ? "B" : "A"}${key.at(-1)}`;
  expect((await page.request.get(`${LIVE.apiUrl}/book/${forged}`)).status()).toBe(404);
  expect((await page.request.get(`${LIVE.apiUrl}/public/v1/pages/${forged}`)).status()).toBe(404);

  // The client's page holds nothing but the snippet the dashboard hands out.
  const site = await context.newPage();
  const clientSite = await serveClientSite(`<!doctype html><html lang="en"><head><title>Halden &amp; Rowe</title></head><body>
      <h1>Halden &amp; Rowe</h1>
      <div data-zs-booking="${key}"></div>
      <script src="${LIVE.apiUrl}/embed.js" async></script>
    </body></html>`);
  try {
    await site.goto(clientSite.url);
    const widget = site.frameLocator(`iframe[src^="${LIVE.apiUrl}/book/${key}"]`);
    await expect(widget.getByRole("heading", { name: "Pick a day" })).toBeVisible();

    // First free day, first free time; an email the business already has makes a possible match.
    await widget.getByRole("button", { name: /\d+ times?$/ }).first().click();
    await widget.locator(".booker-grid button").first().click();
    await expect(widget.getByRole("heading", { name: "Your details" })).toBeVisible();
    await widget.getByLabel("Name", { exact: true }).fill("M. Ashby");
    await widget.getByLabel("Email", { exact: true }).fill("maren.ashby@example.com");
    await widget.getByLabel("Email me updates").check();
    await widget.getByRole("button", { name: "Confirm booking" }).click();
    await expect(widget.getByRole("heading", { name: "You're booked" })).toBeVisible();
    // The iframe grew to its content through the height message.
    const height = await site.locator("iframe").evaluate((frame) => frame.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(320);
    await viewportShot(site, "19-widget-booked", info.project.name, PREFIX);
  } finally {
    await site.close();
    await clientSite.close();
  }

  // Calendar: the slot is held, marked as from the website and waiting for review.
  await page.reload();
  const row = await findWebsiteBooking(page, "M. Ashby");
  await expect(row.getByTestId("website-badge")).toHaveText("Website · to review");
  await shot(page, "20-calendar-website", info.project.name, PREFIX);

  // Customers: the owner confirms it is the existing customer.
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  const request = page.getByRole("region", { name: "Website bookings to review" }).getByTestId("website-request").filter({ hasText: "M. Ashby" });
  await expect(request).toBeVisible();
  await shot(page, "21-website-requests", info.project.name, PREFIX);
  await request.getByRole("button", { name: "Same person as Maren Ashby" }).click();
  await expect(page.getByRole("status").getByText("Linked the booking to Maren Ashby.")).toBeVisible();
  await expect(request).toHaveCount(0);

  // Calendar still caches the pre-link days; a slow refetch must not let the old name pass for
  // the current one, so the day stays busy until fresh data lands.
  await page.route("**/api/v1/booking/bookings**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await mainNav(page).getByRole("link", { name: "Calendar" }).click();
  const linked = await findWebsiteBooking(page, "Maren Ashby");
  await expect(linked.getByTestId("website-badge")).toHaveText("Website");
});
