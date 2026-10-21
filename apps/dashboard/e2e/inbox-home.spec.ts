import { expect, test, type Page } from "@playwright/test";
import { mainNav, openBookingOnFirstOpenDay, shot } from "./helpers";

const replyBubble = (page: Page, text: string) => page.locator("[data-entry=reply]").filter({ hasText: text });

async function openThread(page: Page, name: string) {
  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeFocused();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("drafts a reply, approves it into the delivery queue, and discards another", async ({ page }, info) => {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  // No sample marker: the Inbox reads its own data now.
  await expect(page.getByRole("main").getByTestId("sample-badge")).toHaveCount(0);
  await expect(page.getByText("Replies send in the next release")).toHaveCount(0);
  const linnea = page.getByRole("link", { name: /Linnea Castellanos/ });
  await expect(linnea.getByText("Needs reply")).toBeVisible();
  await expect(page.getByRole("link", { name: /Noor Haddad/ }).getByText("1 draft")).toBeVisible();
  await expect(page.getByRole("link", { name: /M\. Okafor/ }).getByText("Needs review")).toBeVisible();

  await linnea.click();
  await expect(page).toHaveURL(/\/inbox\/c_[0-9a-f-]{36}$/);
  const pane = page.getByRole("article");
  await expect(pane.getByRole("heading", { level: 2, name: "Linnea Castellanos" })).toBeFocused();
  // The website request: the visitor's notes, its channel and the booking, linked to its day.
  const request = pane.locator("[data-entry=request]");
  await expect(request).toContainText("Looking at sapphire halos.");
  await expect(request).toContainText("Website request · Website widget");
  await expect(request.getByRole("link")).toHaveAttribute("href", /^\/calendar\?date=\d{4}-\d{2}-\d{2}&calendar=[0-9a-f-]{36}$/);

  await pane.getByLabel("Subject (optional)").fill("Sapphire halos");
  await pane.getByLabel("Reply to Linnea Castellanos").fill("Hi Linnea, we have three sapphire halos set aside for your visit.");
  await pane.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").getByText("Draft saved. Approve it to queue it for delivery.")).toBeVisible();
  const draft = replyBubble(page, "three sapphire halos");
  await expect(draft.getByTestId("reply-status")).toHaveText("Draft");
  await expect(draft).toContainText("Sapphire halos");
  await expect(draft).toContainText("Drafted by mara@haldenrowe.example");
  await expect(pane.getByLabel("Reply to Linnea Castellanos")).toHaveValue("");
  await shot(page, "21-inbox-draft", info.project.name);

  await draft.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByRole("status").getByText("Approved. The reply is queued for delivery.")).toBeVisible();
  await expect(draft.getByTestId("reply-status")).toHaveText("Approved and queued");
  await expect(draft).toContainText("Approved by mara@haldenrowe.example");
  await expect(draft.getByRole("button")).toHaveCount(0);
  // Answered: the thread no longer needs a reply.
  await expect(pane.locator("header").getByText("Needs reply")).toHaveCount(0);

  await pane.getByLabel("Reply to Linnea Castellanos").fill("Never mind this one.");
  await pane.getByRole("button", { name: "Save draft" }).click();
  const second = replyBubble(page, "Never mind this one.");
  await expect(second.getByTestId("reply-status")).toHaveText("Draft");
  await second.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("status").getByText("Draft discarded.")).toBeVisible();
  await expect(second).toHaveCount(0);
  await expect(draft.getByTestId("reply-status")).toHaveText("Approved and queued");
});

test("refuses an empty reply without sending anything", async ({ page }) => {
  await openThread(page, "Linnea Castellanos");
  const before = await page.evaluate(() => window.__zsDemo!.writeLog().length);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("article").getByRole("alert")).toHaveText("Write a reply first.");
  await expect(page.getByLabel("Reply to Linnea Castellanos")).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => window.__zsDemo!.writeLog().length)).toBe(before);
});

test("a visitor's request must be reviewed in Customers before anyone replies", async ({ page }, info) => {
  await openThread(page, "M. Okafor");
  const pane = page.getByRole("article");
  await expect(pane.getByTestId("visitor-notice")).toContainText("not linked to a customer yet");
  await expect(pane.getByRole("textbox")).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(pane.locator("[data-entry=request]")).toContainText("Clasp keeps opening.");
  await shot(page, "22-inbox-visitor", info.project.name);

  await pane.getByRole("link", { name: "Review in Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  const request = page.getByTestId("website-request").filter({ hasText: "M. Okafor" });
  await request.getByRole("button", { name: "Same person as Marguerite Okafor" }).click();
  await expect(page.getByRole("status").getByText("Linked the booking to Marguerite Okafor.")).toBeVisible();

  // Linked, the message joins Marguerite's own thread.
  await mainNav(page).getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("link", { name: /M\. Okafor/ })).toHaveCount(0);
  await page.getByRole("link", { name: /Marguerite Okafor/ }).click();
  await expect(page.getByRole("article").locator("[data-entry=request]").filter({ hasText: "Clasp keeps opening." })).toBeVisible();
});

test("says so when another owner approved the draft first, or the customer has no email", async ({ page }) => {
  await openThread(page, "Noor Haddad");
  const draft = page.locator("[data-entry=reply][data-status=draft]");
  const replyId = await draft.getAttribute("data-reply-id");
  await page.evaluate((id) => window.__zsDemo!.approveReplyElsewhere(id!), replyId);
  await draft.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByTestId("reply-step-error").getByRole("alert")).toContainText("This reply is no longer a draft. Someone approved or discarded it first. The thread was reloaded.");
  await expect(page.locator(`[data-reply-id="${replyId}"]`).getByTestId("reply-status")).toHaveText("Approved and queued");

  await openThread(page, "Dashiell Moreau");
  await expect(page.getByRole("article").getByText(/has no email address yet/).first()).toBeVisible();
  await page.locator("[data-entry=reply][data-status=draft]").getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByTestId("reply-step-error").getByRole("alert")).toContainText("This customer has no email address yet.");
  await expect(page.locator("[data-entry=reply]").getByTestId("reply-status")).toHaveText("Draft");
});

test("Home compares this week with last week, and counts a new booking and a won deal", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(page.getByTestId("results-ranges")).toContainText(/^This week: Mon, .+ until Mon, .+\. Compared with the same span of last week: Mon, .+ until .+\. Times in America\/New York\.$/);
  const bookings = page.getByTestId("tile-bookings");
  await expect(bookings.getByTestId("tile-value")).toHaveText(/^\d+$/);
  const before = Number(await bookings.getByTestId("tile-value").textContent());
  await expect(page.getByTestId("tile-leads").locator("[data-source=website]")).toContainText("Website");
  const revenue = page.getByRole("region", { name: "Revenue this week" });
  await expect(revenue.getByTestId("revenue-value")).toHaveText("$13,750");
  await expect(revenue.locator("[data-source=website]")).toContainText("$7,350");
  await expect(revenue.locator("[data-source=walk_in]")).toContainText("Walk-in");
  await expect(revenue.getByTestId("sample-badge")).toHaveCount(0);
  await shot(page, "23-home-results", info.project.name);

  await mainNav(page).getByRole("link", { name: "Calendar" }).click();
  const { dialog, slots } = await openBookingOnFirstOpenDay(page);
  const label = (await slots.first().textContent()) ?? "";
  await slots.first().click();
  await dialog.getByRole("button", { name: `Book ${label}` }).click();
  await expect(page.getByRole("status").getByText(/^Booked /)).toBeVisible();

  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "Pipeline" }).click();
  if (phone) await page.getByRole("button", { name: /^Design/ }).click();
  const ring = page.locator("[data-deal-id]").filter({ hasText: "Custom engagement ring, 2 ct oval" });
  await expect(ring.getByTestId("deal-value")).toHaveText("$14,500");
  await ring.getByRole("combobox").selectOption({ label: "Delivered" });
  await expect(page.getByRole("status").getByText("Moved to Delivered.")).toBeVisible();

  await mainNav(page).getByRole("link", { name: "Home" }).click();
  await expect(bookings.getByTestId("tile-value")).toHaveText(String(before + 1));
  await expect(revenue.getByTestId("revenue-value")).toHaveText("$28,250");
  // The test ids sit on screen-reader copies; the numbers people see must count up to the same values.
  await expect(bookings.locator('[data-slot="kpi-value"]')).toBeVisible();
  await expect(bookings.locator('[data-slot="kpi-value"]')).toHaveText(String(before + 1));
  await expect(revenue.locator('[data-slot="kpi-value"]')).toHaveText("$28,250");
  await expect(revenue.locator("[data-source=referral]")).toContainText("$14,500");
});

test("sets a deal's value and lead source, and reloads when someone else changed it", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.goto("/customers?view=pipeline");
  const card = (title: string) => page.locator("[data-deal-id]").filter({ hasText: title });
  const bands = card("Matching wedding bands");
  await expect(bands.getByTestId("deal-value")).toHaveText("No value yet");
  await expect(bands.getByTestId("deal-source")).toHaveText("From Social");
  await bands.getByRole("button", { name: "Edit details of Matching wedding bands" }).click();
  const dialog = page.getByRole("dialog", { name: "Deal details" });
  await expect(dialog.getByLabel("Currency")).toHaveValue("USD");
  await dialog.getByLabel("Value").fill("abc");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter an amount like 1250 or 1250.50.");
  await dialog.getByLabel("Value").fill("5,200");
  await dialog.getByLabel("Lead source").selectOption({ label: "Referral" });
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status").getByText("Saved the details of Matching wedding bands.")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(bands.getByTestId("deal-value")).toHaveText("$5,200");
  await expect(bands.getByTestId("deal-source")).toHaveText("From Referral");

  if (phone) await page.getByRole("button", { name: /^Delivered/ }).click();
  const studs = card("Diamond stud upgrade, 1 ct each");
  await expect(studs.getByTestId("deal-won")).toHaveText(/^Won /);
  await expect(page.locator("[data-fetching]")).toHaveCount(0);
  const dealId = await studs.getAttribute("data-deal-id");
  await studs.getByRole("button", { name: /^Edit details of/ }).click();
  const leadSource = await dialog.getByLabel("Lead source").inputValue();
  const before = await page.evaluate((id) => window.__zsDemo!.editDealElsewhere(id!, { leadSource: "ads" }), dealId);
  await dialog.getByLabel("Value").fill("6500");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Someone changed this deal since you opened it. Reloaded: your changes are kept and theirs fill the rest. Check the details and save again.");
  // The edit stays; the field left alone takes the other person's save instead of overwriting it.
  expect(leadSource).not.toBe("ads");
  await expect(dialog.getByLabel("Value")).toHaveValue("6500");
  await expect(dialog.getByLabel("Lead source")).toHaveValue("ads");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog).toBeHidden();
  await expect(studs.getByTestId("deal-value")).toHaveText("$6,500");
  await expect(studs.getByTestId("deal-source")).toHaveText("From Ads");
  // The stale save sent the revision the dialog opened with, the second the reloaded one.
  const saves = (await page.evaluate(() => window.__zsDemo!.writeLog()))
    .filter((write) => write.operation === "crm.deal.set-details" && (write.payload as { dealId: string }).dealId === dealId)
    .map((write) => write.payload as { expectedRevision: number; leadSource: string | null });
  expect(saves.slice(-2)).toEqual([
    expect.objectContaining({ expectedRevision: before.revision - 1, leadSource: leadSource || null }),
    expect.objectContaining({ expectedRevision: before.revision, leadSource: "ads" }),
  ]);
});
