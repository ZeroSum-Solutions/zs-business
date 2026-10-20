import { randomUUID } from "node:crypto";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { findWebsiteBooking, mainNav, shot } from "../helpers";
import { LIVE } from "./env";
import { expect, ownerEmail, signInThroughPage, STAFF_EMAIL, test } from "./fixtures";

const PREFIX = "live-";

/** The booking link from the Calendar card, as the owner would copy it. */
async function bookingKey(page: Page): Promise<string> {
  await page.goto("/calendar");
  const href = (await page.getByTestId("booking-page").getByRole("link", { name: "Open booking page" }).getAttribute("href")) ?? "";
  expect(href.startsWith(`${LIVE.apiUrl}/book/zsb1_`)).toBe(true);
  return new URL(href).pathname.split("/").at(-1)!;
}

/** Home's tiles as the owner sees them. A full load, so no cached answer from earlier is shown. */
async function homeTiles(page: Page) {
  await page.goto("/");
  const value = async (id: string, source?: string) => {
    const tile = page.getByTestId(`tile-${id}`);
    const text = source
      ? (await tile.locator(`[data-source=${source}]`).locator("span.tabular").textContent()) ?? ""
      : (await tile.getByTestId("tile-value").textContent()) ?? "";
    return Number(text.trim().split(" ")[0]!.replaceAll(",", ""));
  };
  await expect(page.getByTestId("tile-bookings").getByTestId("tile-value")).toHaveText(/^\d[\d,]*$/);
  return {
    leads: await value("leads"),
    websiteLeads: await value("leads", "website"),
    bookings: await value("bookings"),
    websiteBookings: await value("bookings", "website"),
  };
}

/** A visitor books on the hosted booking page, with notes. */
async function bookAsVisitor(browser: Browser, key: string, name: string, email: string, notes: string) {
  const visitor = await browser.newContext();
  try {
    const booker = await visitor.newPage();
    await booker.goto(`${LIVE.apiUrl}/book/${key}`);
    await expect(booker.getByRole("heading", { name: "Pick a day" })).toBeVisible();
    await booker.getByRole("button", { name: /\d+ times?$/ }).first().click();
    await booker.locator(".booker-grid button").first().click();
    await expect(booker.getByRole("heading", { name: "Your details" })).toBeVisible();
    await booker.getByLabel("Name", { exact: true }).fill(name);
    await booker.getByLabel("Email", { exact: true }).fill(email);
    await booker.getByLabel("Notes (optional)").fill(notes);
    await booker.getByRole("button", { name: "Confirm booking" }).click();
    await expect(booker.getByRole("heading", { name: "You're booked" })).toBeVisible();
  } finally {
    await visitor.close();
  }
}

/** A second browser signed in as the staff member, at the same screen size as the test's project. */
async function staffPage(browser: Browser, info: TestInfo) {
  const { viewport, isMobile, hasTouch, deviceScaleFactor } = info.project.use;
  const context = await browser.newContext({
    baseURL: LIVE.webUrl, serviceWorkers: "block",
    ...(viewport ? { viewport } : {}), ...(isMobile ? { isMobile } : {}), ...(hasTouch ? { hasTouch } : {}),
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
  });
  const page = await context.newPage();
  await signInThroughPage(page, "/", STAFF_EMAIL);
  return { page, close: () => context.close() };
}

test("a website booking shows in Calendar, Customers, Inbox and Home, and an owner queues a reply", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  // A different visitor per project: phone and desktop share the database, reset between tests.
  const tag = randomUUID().slice(0, 6);
  const name = `Odile Ferrant ${tag}`;
  const notes = `Could we look at emerald settings before the visit? (${tag})`;
  const before = await homeTiles(page);
  await expect(page.getByRole("region", { name: "Revenue this week" })).toBeVisible();

  await bookAsVisitor(browser, await bookingKey(page), name, `odile.${tag}@example.com`, notes);

  // Calendar: the booking holds its slot, from the website, for a brand-new customer.
  await page.goto("/calendar");
  const row = await findWebsiteBooking(page, name);
  await expect(row.getByTestId("website-badge")).toHaveText("Website");

  // Customers: the visitor became a customer (P-7 new_contact).
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByLabel("Search customers").fill(tag);
  await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();

  // Inbox: one thread for the customer, the notes as their message, the booking linked to its day.
  await mainNav(page).getByRole("link", { name: "Inbox" }).click();
  const threadLink = page.getByRole("link", { name: new RegExp(name) });
  await expect(threadLink.getByText("Needs reply")).toBeVisible();
  await threadLink.click();
  const pane = page.getByRole("article");
  await expect(pane.getByRole("heading", { level: 2, name })).toBeFocused();
  const request = pane.locator("[data-entry=request]");
  await expect(request).toContainText(notes);
  await expect(request).toContainText("Website request · Booking page");
  const threadUrl = page.url();
  await request.getByRole("link").click();
  await expect(page).toHaveURL(/\/calendar\?date=\d{4}-\d{2}-\d{2}&calendar=/);
  await expect(page.locator('li[data-source="website"]').filter({ hasText: name })).toBeVisible();

  // Staff draft a reply; it waits for an owner. Staff never see or ask for Home results.
  const staff = await staffPage(browser, info);
  try {
    const resultsCalls: string[] = [];
    staff.page.on("request", (call) => { if (call.url().includes("/api/v1/home/")) resultsCalls.push(call.url()); });
    await staff.page.goto("/");
    await expect(staff.page.getByRole("heading", { name: "Next appointments" })).toBeVisible();
    await expect(staff.page.getByRole("region", { name: "Revenue this week" })).toHaveCount(0);
    await expect(staff.page.getByTestId("tile-leads")).toHaveCount(0);
    await staff.page.goto(threadUrl);
    const staffPane = staff.page.getByRole("article");
    await staffPane.getByLabel(`Reply to ${name}`).fill(`Hello from the front desk (${tag}).`);
    await staffPane.getByRole("button", { name: "Save draft" }).click();
    await expect(staff.page.getByRole("status").getByText("Draft saved. An owner approves it before it is queued to send.")).toBeVisible();
    const staffDraft = staffPane.locator("[data-entry=reply]").filter({ hasText: "front desk" });
    await expect(staffDraft.getByTestId("reply-status")).toHaveText("Draft");
    await expect(staffDraft).toContainText("Waiting for an owner to approve it before it is queued to send.");
    await expect(staffDraft.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
    await expect(staffDraft.getByRole("button", { name: "Discard" })).toBeVisible();
    expect(resultsCalls, "staff requests for Home results").toEqual([]);
  } finally {
    await staff.close();
  }

  // The owner drafts and approves a reply: it is queued for delivery, not sent.
  await page.goto(threadUrl);
  await expect(pane.locator("[data-entry=reply]").filter({ hasText: "front desk" })).toContainText(`Drafted by ${STAFF_EMAIL}`);
  await pane.getByLabel("Subject (optional)").fill("Emerald settings");
  await pane.getByLabel(`Reply to ${name}`).fill(`Hi Odile, we will have emerald settings ready (${tag}).`);
  await pane.getByRole("button", { name: "Save draft" }).click();
  const mine = pane.locator("[data-entry=reply]").filter({ hasText: "emerald settings ready" });
  await expect(mine.getByTestId("reply-status")).toHaveText("Draft");
  await expect(mine).toContainText("Emerald settings");
  await expect(mine).toContainText(`Drafted by ${ownerEmail()}`);
  await mine.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByRole("status").getByText("Approved. The reply is queued for delivery.")).toBeVisible();
  await expect(mine.getByTestId("reply-status")).toHaveText("Approved and queued");
  await expect(mine).toContainText(`Approved by ${ownerEmail()}`);
  await expect(pane.locator("header").getByText("Needs reply")).toHaveCount(0);
  // The staff draft still waits; the owner may discard it.
  const staffDraft = pane.locator("[data-entry=reply]").filter({ hasText: "front desk" });
  await staffDraft.getByRole("button", { name: "Discard" }).click();
  await expect(staffDraft).toHaveCount(0);
  await shot(page, "22-inbox-thread", info.project.name, PREFIX);

  // Home: counted in this week's bookings and leads, both from the website.
  const after = await homeTiles(page);
  expect(after).toEqual({
    leads: before.leads + 1, websiteLeads: before.websiteLeads + 1,
    bookings: before.bookings + 1, websiteBookings: before.websiteBookings + 1,
  });
  await expect(page.getByTestId("results-ranges")).toContainText("This week: ");
  await shot(page, "23-home-results", info.project.name, PREFIX);
});

test("sets a deal's value and lead source, and reloads after someone else changed it", async ({ page, request }, info) => {
  const phone = info.project.name === "phone";
  // Seed deals with no value or lead source yet (apps/api/src/seed/demo-data.ts).
  const title = phone ? "Diamond stud upgrade" : "Pearl strand restring and clasp";
  await page.goto("/customers?view=pipeline");
  const card = page.locator("[data-deal-id]").filter({ hasText: title });
  if (phone) await page.getByRole("button", { name: /^Inquiry/ }).click();
  await expect(card.getByTestId("deal-value")).toHaveText("No value yet");
  await card.getByRole("button", { name: `Edit details of ${title}` }).click();
  const dialog = page.getByRole("dialog", { name: "Deal details" });
  await dialog.getByLabel("Value").fill("5200");
  await dialog.getByLabel("Lead source").selectOption({ label: "Referral" });
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByTestId("deal-value")).toHaveText("$5,200");
  await expect(card.getByTestId("deal-source")).toHaveText("From Referral");

  // Someone else saves the deal while the dialog is open.
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  await card.getByRole("button", { name: `Edit details of ${title}` }).click();
  const headers = { Authorization: `Bearer ${process.env.ZS_LIVE_OTHER_TOKEN}`, "Content-Type": "application/json" };
  const deals = (await (await request.get(`${LIVE.apiUrl}/v1/crm/deals?limit=100`, { headers })).json()) as { items: { id: string; title: string; revision: number }[] };
  const deal = deals.items.find((item) => item.title === title)!;
  const touched = await request.post(`${LIVE.apiUrl}/v1/crm/deals/${deal.id}/details`, {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: { expectedRevision: deal.revision, value: { amountMinor: 520000, currency: "USD" }, leadSource: "phone" },
  });
  expect(touched.status()).toBe(200);
  await dialog.getByLabel("Value").fill("6100");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Someone changed this deal since you opened it. Reloaded: your changes are kept and theirs fill the rest. Check the details and save again.");
  // The value edit stays; the lead source the other person saved is not overwritten.
  await expect(dialog.getByLabel("Value")).toHaveValue("6100");
  await expect(dialog.getByLabel("Lead source")).toHaveValue("phone");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByTestId("deal-value")).toHaveText("$6,100");
  await expect(card.getByTestId("deal-source")).toHaveText("From Phone");
});
