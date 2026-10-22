import { expect, test, type Page } from "@playwright/test";
import { mainNav, shot } from "./helpers";

// The Agents page on the demo adapter, which keeps the API's rules for the follow-up agent
// (agents.md G-2..G-11). The demo clock is the real one, so the agent may be in its quiet hours.

const card = (page: Page) => page.getByRole("region", { name: "Inquiry follow-up" });
const settings = (page: Page) => page.getByRole("region", { name: "Follow-up settings" });
const runs = (page: Page) => page.getByRole("list", { name: "Runs" }).locator(":scope > li");
const writes = (page: Page, operation: string) =>
  page.evaluate((op) => window.__zsDemo!.writeLog().filter((write) => write.operation === op), operation);

async function openAgents(page: Page) {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/** Leave and come back, so the page reads the agent again after a change made "elsewhere". */
async function revisit(page: Page) {
  await mainNav(page).getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("shows the agent's state, that drafts wait for approval, and its recent runs", async ({ page }, info) => {
  await openAgents(page);
  // Live data now: no sample marker, nothing switched off for that reason.
  await expect(page.getByRole("main").getByTestId("sample-badge")).toHaveCount(0);
  await expect(card(page).getByTestId("followup-state")).toHaveText(/^On(, waiting)?$/);
  await expect(card(page).getByTestId("followup-blocked")).toHaveText(/^(It can draft now\.|Why it can't draft right now: It is quiet hours \(9:00 PM to 8:00 AM, Eastern Time \(New York\)\)\. It drafts again when they end\.)$/);
  await expect(card(page)).toContainText("nobody has answered after 24 hours");
  await expect(card(page).getByTestId("approval-note")).toContainText("Agent drafts wait in the Inbox for an owner's approval. Nothing is sent to a customer without it.");
  await expect(card(page).getByRole("link", { name: "Open the Inbox" })).toHaveAttribute("href", "/inbox");
  await expect(settings(page).getByTestId("settings-saved")).toHaveText(/^Last saved /);

  // Newest first: an owner's run that found only answered requests, a stopped one, last week's draft.
  await expect(runs(page)).toHaveCount(3);
  await expect(runs(page).nth(0)).toContainText("Finished");
  await expect(runs(page).nth(0)).toContainText("Drafted 0 follow-ups, skipped 2.");
  await expect(runs(page).nth(0)).toContainText("You started it");
  await expect(runs(page).nth(1)).toContainText("Stopped");
  await expect(runs(page).nth(1).getByTestId("run-stop")).toHaveText("Stopped because the team stopped the agent.");
  await expect(runs(page).nth(2)).toContainText("Scheduled run");

  const newest = runs(page).nth(0);
  await newest.getByRole("button", { name: /^Show details/ }).click();
  await expect(newest.getByRole("button", { name: /^Hide details/ })).toHaveAttribute("aria-expanded", "true");
  await expect(newest.getByTestId("run-detail")).toContainText("Skipped Noor Haddad: someone on the team replied first.");
  await expect(newest.getByTestId("run-detail")).toContainText("Skipped Marguerite Okafor: someone on the team replied first.");
  await shot(page, "24-agents", info.project.name);

  const oldest = runs(page).nth(2);
  await oldest.getByRole("button", { name: /^Show details/ }).click();
  const drafted = oldest.locator("[data-outcome=drafted]");
  await expect(drafted).toContainText("Drafted a follow-up for Marguerite Okafor. It waits in the Inbox for an owner's approval.");
  await drafted.getByRole("link", { name: "Marguerite Okafor" }).click();
  await expect(page).toHaveURL(/\/inbox\/c_5e0c1a2b-7d3f-4c8a-9b1e-000000000001$/);
  await expect(page.getByRole("article").getByRole("heading", { level: 2, name: "Marguerite Okafor" })).toBeVisible();
});

test("says support paused the agent, without naming other businesses", async ({ page }) => {
  await openAgents(page);
  await page.evaluate(() => window.__zsDemo!.setGlobalAgentKill(true));
  await revisit(page);
  await expect(card(page).getByTestId("followup-state")).toHaveText("Paused by support");
  await expect(card(page).getByTestId("followup-blocked")).toHaveText(
    "Why it can't draft right now: Support paused it. Nothing is drafted until support turns it back on.");
  await expect(page.getByRole("main")).not.toContainText(/every business|all businesses|this service/);
  const runNow = card(page).getByRole("button", { name: "Run now" });
  await expect(runNow).toBeDisabled();
  await expect(runNow).toHaveAccessibleDescription("Run now works when the agent can draft. See why above.");
});

test("staff can stop the agent but not resume it, change its settings or run it", async ({ page }) => {
  await openAgents(page);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  await expect(settings(page).getByTestId("settings-owner-only")).toHaveText("Only an owner can change these settings.");
  await expect(settings(page).getByRole("button", { name: "Save settings" })).toHaveCount(0);
  await expect(settings(page)).toContainText("Quiet hours");
  await expect(card(page).getByRole("button", { name: "Run now" })).toHaveCount(0);

  await card(page).getByLabel("Note for the team (optional)").fill("A customer asked us to pause");
  await card(page).getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByRole("status").getByText("Agent stopped. It drafts nothing until an owner resumes it.")).toBeVisible();
  await expect(card(page).getByTestId("followup-state")).toHaveText("Stopped");
  await expect(card(page).getByTestId("followup-killed")).toHaveText(/^Stopped by you on .+\. Note: A customer asked us to pause$/);
  await expect(card(page).getByTestId("followup-blocked")).toContainText("It is stopped. Nothing is drafted until an owner resumes it.");
  const resume = card(page).getByRole("button", { name: "Resume" });
  await expect(resume).toBeDisabled();
  await expect(resume).toHaveAccessibleDescription("Only an owner can resume the agent.");
  await expect(card(page).getByText("Only an owner can resume the agent.")).toBeVisible();
  expect((await writes(page, "agent.kill")).map((write) => [write.outcome, write.payload])).toEqual([["applied", { note: "A customer asked us to pause" }]]);
  expect(await writes(page, "agent.resume")).toEqual([]);

  // The owner sees who stopped it, and resumes it.
  await page.evaluate(() => window.__zsDemo!.actAs("owner"));
  await expect(card(page).getByTestId("followup-killed")).toHaveText(/^Stopped by a team member on /);
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(page.getByRole("status").getByText(/^Agent resumed\./)).toBeVisible();
  await expect(card(page).getByTestId("followup-state")).toHaveText(/^On(, waiting)?$/);
  await expect(card(page).getByRole("button", { name: "Stop the agent" })).toBeVisible();
});

test("an owner saves the settings with the revision they started from", async ({ page }) => {
  await openAgents(page);
  const form = settings(page);
  const perDay = form.getByLabel("Drafts per day, at most");
  await expect(perDay).toHaveValue("10");

  // Out of bounds: nothing is sent, and the field says what it takes.
  await perDay.fill("0");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(form.getByRole("alert")).toHaveText("Some settings need another look.");
  await expect(perDay).toHaveAttribute("aria-invalid", "true");
  await expect(perDay).toBeFocused();
  await expect(perDay).toHaveAccessibleDescription("A whole number from 1 to 200.");
  expect(await writes(page, "agent.settings.update")).toEqual([]);

  await perDay.fill("12");
  await form.getByLabel("Wait before following up (hours)").fill("48");
  await form.getByLabel("From").fill("22:00");
  await form.getByRole("switch", { name: "Draft follow-ups" }).click();
  await expect(form.getByRole("switch", { name: "Draft follow-ups" })).toHaveAttribute("aria-checked", "false");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").getByText("Settings saved.")).toBeVisible();
  await expect(card(page).getByTestId("followup-state")).toHaveText("Off");
  await expect(card(page)).toContainText("nobody has answered after 48 hours");
  await expect(card(page).getByTestId("followup-blocked")).toContainText("It is turned off.");
  const [save] = await writes(page, "agent.settings.update");
  expect(save).toMatchObject({
    outcome: "applied",
    payload: { enabled: false, maxDraftsPerDay: 12, waitHours: 48, quietStartMinute: 1320, quietEndMinute: 480, timeZone: "America/New_York", expectedRevision: 2 },
  });

  // Saved values stay after a fresh read.
  await revisit(page);
  await expect(settings(page).getByLabel("Drafts per day, at most")).toHaveValue("12");
  await expect(settings(page).getByLabel("From")).toHaveValue("22:00");
});

test("a save after another owner's says so and reloads the latest settings", async ({ page }) => {
  await openAgents(page);
  const form = settings(page);
  await form.getByLabel("Wait before following up (hours)").fill("36");
  // Another owner raises the daily limit to 15 first.
  await page.evaluate(() => window.__zsDemo!.editAgentSettingsElsewhere());
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(form.getByTestId("settings-stale")).toHaveText(
    "Someone else saved these settings while you were editing. The latest settings are loaded below. Check them and save again.");
  await expect(form.getByLabel("Drafts per day, at most")).toHaveValue("15");
  await expect(form.getByLabel("Wait before following up (hours)")).toHaveValue("24");

  await form.getByLabel("Wait before following up (hours)").fill("36");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").getByText("Settings saved.")).toBeVisible();
  await expect(form.getByTestId("settings-stale")).toHaveCount(0);
  const saves = await writes(page, "agent.settings.update");
  expect(saves.map((write) => [write.outcome, (write.payload as { expectedRevision: number }).expectedRevision])).toEqual([["rejected", 2], ["applied", 3]]);
  expect(saves[1]!.payload).toMatchObject({ maxDraftsPerDay: 15, waitHours: 36 });
});

test("Run now adds a run, and is off on a server without a model", async ({ page }) => {
  // Wednesday 15:00 in New York: outside quiet hours, so Run now is offered.
  await page.clock.setFixedTime(new Date("2026-10-21T19:00:00.000Z"));
  await openAgents(page);
  await expect(runs(page)).toHaveCount(3);
  const runNow = card(page).getByRole("button", { name: "Run now" });
  await expect(runNow).toHaveAccessibleDescription("Looks for unanswered requests once, now. Its drafts wait in the Inbox for approval.");
  await runNow.click();
  await expect(page.getByRole("status").getByText(/^Run finished\./)).toBeVisible();
  await expect(runs(page)).toHaveCount(4);
  await expect(runs(page).nth(0)).toContainText("You started it");

  await page.evaluate(() => window.__zsDemo!.setFollowUpModel(false));
  await runNow.click();
  await expect(runNow).toBeDisabled();
  await expect(runNow).toHaveAccessibleDescription("Run now works when the agent can draft. See why above.");
  // Without a model it drafts nothing, so it does not say "On".
  await expect(card(page).getByTestId("followup-state")).toHaveText("Can't draft yet");
  await expect(card(page).getByTestId("followup-blocked")).toHaveText("Why it can't draft right now: No writing service is connected yet, so it drafts nothing.");
  await expect(card(page).getByRole("alert")).toHaveCount(0);
  await expect(runs(page)).toHaveCount(4);
});

test("a double tap on Stop the agent stops it once, with one toast", async ({ page }) => {
  await openAgents(page);
  await card(page).getByRole("button", { name: "Stop the agent" }).dblclick();
  await expect(card(page).getByTestId("followup-state")).toHaveText("Stopped");
  // The button is gone; focus lands on why it cannot draft now.
  await expect(card(page).getByTestId("followup-blocked")).toBeFocused();
  await expect(page.getByTestId("toast").filter({ hasText: "Agent stopped." })).toHaveCount(1);
  expect((await writes(page, "agent.kill")).map((write) => write.outcome)).toEqual(["applied"]);
  // Resume is the next control; a double tap there resumes it once too.
  await card(page).getByRole("button", { name: "Resume" }).dblclick();
  await expect(card(page).getByRole("button", { name: "Stop the agent" })).toBeVisible();
  await expect(page.getByTestId("toast").filter({ hasText: "Agent resumed." })).toHaveCount(1);
  expect((await writes(page, "agent.resume")).map((write) => write.outcome)).toEqual(["applied"]);
});

test("turned off, Run now waits but Stop still latches, so turning it on needs a Resume", async ({ page }) => {
  await openAgents(page);
  const form = settings(page);
  const enabled = form.getByRole("switch", { name: "Draft follow-ups" });
  await enabled.click();
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(card(page).getByTestId("followup-state")).toHaveText("Off");
  await expect(card(page).getByRole("button", { name: "Run now" })).toBeDisabled();
  await card(page).getByRole("button", { name: "Stop the agent" }).click();
  await expect(card(page).getByRole("button", { name: "Resume" })).toBeVisible();
  await enabled.click();
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(card(page).getByTestId("followup-state")).toHaveText("Stopped");
  await expect(card(page).getByRole("button", { name: "Resume" })).toBeVisible();
});

test("Run now drafts a follow-up that waits in the Inbox under the agent's name", async ({ page }) => {
  // Wednesday 15:00 in New York: outside quiet hours, and Linnea's request is over a day old.
  await page.clock.setFixedTime(new Date("2026-10-21T19:00:00.000Z"));
  await openAgents(page);
  await expect(card(page).getByTestId("followup-state")).toHaveText("On");
  await expect(card(page).getByTestId("followup-blocked")).toHaveText("It can draft now.");
  await card(page).getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").getByText("Run finished. Drafted 1 follow-up, skipped 0.")).toBeVisible();

  await expect(runs(page)).toHaveCount(4);
  const run = runs(page).nth(0);
  await expect(run).toContainText("Drafted 1 follow-up, skipped 0.");
  await run.getByRole("button", { name: /^Show details/ }).click();
  await run.locator("[data-outcome=drafted]").getByRole("link", { name: "Linnea Castellanos" }).click();
  await expect(page).toHaveURL(/\/inbox\/c_[0-9a-f-]{36}$/);
  const draft = page.locator("[data-entry=reply][data-status=draft]");
  await expect(draft.getByTestId("agent-draft")).toHaveText("Follow-up agent");
  await expect(draft).toContainText("Following up on your visit request");
  await expect(draft).toContainText("Drafted by the follow-up agent");
  // Nothing was sent: it waits for an owner like any other draft.
  await expect(draft.getByTestId("reply-status")).toHaveText("Draft");
  await expect(draft.getByRole("button", { name: "Approve and queue" })).toBeVisible();
  expect((await page.evaluate(() => window.__zsDemo!.writeLog())).map((write) => write.operation)).toEqual(["agent.run.start"]);
});
