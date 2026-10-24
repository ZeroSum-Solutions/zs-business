import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers";

// The templated kinds on the Agents page, on the demo adapter, which keeps the API's rules
// (agents.md G-14, G-19, G-20, approvals.md A-15): an owner writes wording, approves it and turns
// the kind on; a new revision un-approves sends until it is approved again.

const reminders = (page: Page) => page.getByRole("region", { name: "Appointment reminders", exact: true });
const reviews = (page: Page) => page.getByRole("region", { name: "Review requests", exact: true });
const writes = (page: Page) =>
  page.evaluate(() => window.__zsDemo!.writeLog().filter((write) => write.operation.startsWith("template.") || write.operation.startsWith("agent.kind.")));

async function openAgents(page: Page) {
  // Wednesday 15:00 in New York: outside the default quiet hours, so an approved kind that is on can send.
  await page.clock.setFixedTime(new Date("2026-10-21T19:00:00.000Z"));
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("write wording, approve it, turn it on, and new wording needs approval again", async ({ page }, info) => {
  await openAgents(page);
  const card = reminders(page);
  await expect(card.getByTestId("reminder-state")).toHaveText("Off");
  await expect(card.getByTestId("reminder-none")).toHaveText("No wording yet. Write the message it sends below.");
  await expect(card.getByTestId("reminder-variables")).toContainText("{customer_first_name} the customer's first name");
  await expect(card.getByTestId("reminder-variables")).not.toContainText("{review_link}");

  // An unknown placeholder is refused before anything is sent.
  await card.getByLabel("Subject").fill("Your visit to {business_name}");
  const message = card.getByLabel("Message");
  await message.fill("Hi {first_name}, see you {booking_start_local}.");
  await card.getByRole("button", { name: "Save new wording" }).click();
  await expect(card.getByRole("alert")).toHaveText("Some of the wording needs another look.");
  await expect(message).toHaveAttribute("aria-invalid", "true");
  await expect(message).toBeFocused();
  await expect(message).toHaveAccessibleDescription(/^\{first_name\} is not a variable for appointment reminders\. Use only \{booking_link\}/);
  expect(await writes(page)).toEqual([]);

  await message.fill("Hi {customer_first_name}, see you {booking_start_local}. To change it: {booking_link}");
  await card.getByLabel("Hours before the appointment").fill("6");
  await card.getByRole("button", { name: "Save new wording" }).click();
  await expect(page.getByRole("status").getByText("New wording saved as revision 1. Nothing is sent until an owner approves it.")).toBeVisible();
  await expect(card.getByTestId("reminder-approval")).toHaveText("Needs approval");
  await expect(card.getByTestId("reminder-current")).toContainText("Email, 6 hours before the appointment");
  await expect(card.getByTestId("reminder-body")).toHaveText("Hi {customer_first_name}, see you {booking_start_local}. To change it: {booking_link}");
  await expect(card.getByRole("heading", { name: "Current wording" })).toBeFocused();

  await card.getByRole("button", { name: "Approve this wording" }).click();
  await expect(page.getByRole("status").getByText("Wording approved. It may be sent for the next 30 days.")).toBeVisible();
  await expect(card.getByTestId("reminder-approval")).toHaveText("Approved");
  await expect(card.getByTestId("reminder-approved-note")).toContainText("Used for 0 messages so far.");
  await expect(card.getByRole("button", { name: "Approve this wording" })).toHaveCount(0);

  const enabled = card.getByRole("switch", { name: "Send appointment reminders" });
  await enabled.click();
  await expect(page.getByRole("status").getByText("Appointment reminders turned on.", { exact: true })).toBeVisible();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("reminder-state")).toHaveText("On");
  await shot(page, "25-agent-templates", info.project.name);

  // New wording: the form says it un-approves sends, and after the save it needs approval again.
  const write = card.getByRole("button", { name: "Write new wording" });
  await expect(write).toHaveAccessibleDescription(/^Saving new wording un-approves sends/);
  await write.click();
  await expect(card.getByTestId("reminder-unapproves")).toContainText("nothing is sent until an owner approves the new wording");
  await expect(message).toHaveValue("Hi {customer_first_name}, see you {booking_start_local}. To change it: {booking_link}");
  await message.fill("Hi {customer_first_name}, a reminder: {business_name} on {booking_start_local}.");
  await card.getByRole("button", { name: "Save new wording" }).click();
  await expect(page.getByRole("status").getByText("New wording saved as revision 2. Nothing is sent until an owner approves it.")).toBeVisible();
  await expect(card.getByTestId("reminder-approval")).toHaveText("Needs approval");
  await expect(card.getByTestId("reminder-state")).toHaveText("On, needs approval");
  await expect(card.getByText("Nothing is sent until an owner approves the wording.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve this wording" })).toBeEnabled();

  const log = await writes(page);
  expect(log.map((entry) => [entry.operation, entry.outcome])).toEqual([
    ["template.revision.create", "applied"],
    ["template.approve", "applied"],
    ["agent.kind.settings.update", "applied"],
    ["template.revision.create", "applied"],
  ]);
  expect(log.map((entry) => (entry.payload as { expectedRevision?: number }).expectedRevision)).toEqual([0, undefined, 0, 1]);
  expect(log[1]!.payload).toMatchObject({ agentKind: "appointment_reminder", revision: 1, contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(new Set(log.map((entry) => entry.idempotencyKey)).size).toBe(4);
});

test("review requests need a review link before they turn on, as the server says", async ({ page }) => {
  await openAgents(page);
  const card = reviews(page);
  const enabled = card.getByRole("switch", { name: "Send review requests" });
  await enabled.click();
  await expect(card.getByTestId("review-settings-problem")).toHaveText("Review requests need your review link. Add it below and save it, then turn them on.");
  await expect(enabled).toHaveAttribute("aria-checked", "false");

  const link = card.getByLabel("Review link");
  await link.fill("http://example.com/review");
  await card.getByRole("button", { name: "Save review link" }).click();
  await expect(link).toHaveAccessibleDescription("Enter a full link that starts with https://.");
  await link.fill("https://g.page/r/halden-rowe/review");
  await card.getByRole("button", { name: "Save review link" }).click();
  await expect(page.getByRole("status").getByText("Review link saved.")).toBeVisible();

  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("review-state")).toHaveText("On, needs approval");
  await expect(card.getByTestId("review-settings-problem")).toHaveCount(0);
  const saves = (await writes(page)).filter((entry) => entry.operation === "agent.kind.settings.update");
  expect(saves.map((entry) => entry.outcome)).toEqual(["rejected", "applied", "applied"]);
  expect(saves[2]!.payload).toMatchObject({ enabled: true, config: { reviewUrl: "https://g.page/r/halden-rowe/review" } });
});

test("Suggest wording fills the form, and goes away on a server without suggestions", async ({ page }) => {
  await openAgents(page);
  const card = reviews(page);
  await card.getByRole("button", { name: "Suggest wording" }).click();
  await expect(card.getByLabel("Subject")).toHaveValue("How was your visit to {business_name}?");
  await expect(card.getByLabel("Message")).toHaveValue(/\{review_link\}/);
  // Nothing is saved until the owner saves it.
  expect((await writes(page)).map((entry) => entry.operation)).toEqual(["template.suggest"]);

  await page.evaluate(() => window.__zsDemo!.setTemplateSuggestions(false));
  await card.getByRole("button", { name: "Suggest wording" }).click();
  await expect(card.getByRole("button", { name: "Suggest wording" })).toHaveCount(0);
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("staff see the switches but not the wording, and cannot change either", async ({ page }) => {
  await openAgents(page);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  const card = reminders(page);
  await expect(card.getByTestId("reminder-owner-only")).toHaveText("Only an owner can see and change this wording.");
  const enabled = card.getByRole("switch", { name: "Send appointment reminders" });
  await expect(enabled).toBeDisabled();
  await expect(enabled).toHaveAccessibleDescription(/Only an owner can turn this on or off\./);
  await expect(card.getByRole("button", { name: "Save new wording" })).toHaveCount(0);
  await expect(reviews(page).getByLabel("Review link")).toHaveCount(0);
});
