import { expect, test, type Page } from "@playwright/test";
import { mainNav, shot } from "./helpers";

const releases = (page: Page) => page.getByTestId("site-release");
const liveSummary = (page: Page) => page.getByTestId("site-live-summary");

async function openSite(page: Page) {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible();
  await expect(liveSummary(page)).toHaveText(/^Version 2 is live\./);
}

test("edits, previews and publishes the site, then rolls back to an earlier version", async ({ page }, info) => {
  await openSite(page);
  await expect(page.getByText("haldenrowe.example")).toBeVisible();
  await expect(releases(page)).toHaveCount(2);
  await shot(page, "21-site", info.project.name);

  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await expect(editor.getByLabel("Site title")).toHaveValue("Halden & Rowe");
  await editor.getByLabel("Tagline").fill("Rings and repairs on Hudson Street");
  await editor.getByRole("button", { name: "Add section" }).click();
  const fourth = editor.getByRole("group", { name: "Section 4" });
  await expect(editor.getByTestId("disabled-reason")).toHaveText("Each section needs a heading and some text.");
  await expect(editor.getByRole("button", { name: "Publish" })).toBeDisabled();
  await fourth.getByLabel("Heading").fill("Visit");
  await fourth.getByLabel("Text").fill("Open Tuesday to Saturday, <10am> to 6pm.");

  await editor.getByRole("button", { name: "Preview" }).click();
  const frame = page.frameLocator('[data-testid="site-preview"]');
  await expect(frame.getByRole("heading", { level: 1, name: "Halden & Rowe" })).toBeVisible();
  await expect(frame.getByText("Rings and repairs on Hudson Street")).toBeVisible();
  // Text the owner types is shown as text, never run as markup.
  await expect(frame.getByText("Open Tuesday to Saturday, <10am> to 6pm.")).toBeVisible();
  await expect(page.getByTestId("site-preview")).toHaveAttribute("sandbox", "");
  // A preview does not go live.
  await expect(releases(page)).toHaveCount(2);
  await shot(page, "22-site-preview", info.project.name);

  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").getByText("Published. Your site is live.")).toBeVisible();
  await expect(editor).toBeHidden();
  await expect(releases(page)).toHaveCount(3);
  await expect(releases(page).first()).toContainText("Version 3");
  await expect(releases(page).first()).toContainText("Live");
  await expect(liveSummary(page)).toHaveText(/^Version 3 is live\./);

  // Bring back version 1 from History.
  await page.getByRole("button", { name: "Make live version 1" }).click();
  const confirm = page.getByRole("dialog", { name: "Make version 1 live?" });
  await confirm.getByRole("button", { name: "Make version 1 live" }).click();
  await expect(page.getByRole("status").getByText("Version 1 is live again.")).toBeVisible();
  await expect(liveSummary(page)).toHaveText(/^Version 1 is live\./);
  await expect(releases(page)).toHaveCount(3);
  await expect(releases(page).last()).toContainText("Live");

  // The editor starts from the live version.
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(page.getByRole("dialog", { name: "Edit site" }).getByLabel("Tagline")).toHaveValue("Fine jewelry from our Hudson Street workshop");
  await shot(page, "23-site-rolled-back", info.project.name);
});

test("refuses a rollback when another version went live since the page loaded", async ({ page }) => {
  await openSite(page);
  // Another owner makes version 1 live; this page still says version 2.
  await page.evaluate(() => window.__zsDemo!.rollBackElsewhere());
  await page.getByRole("button", { name: "Make live version 1" }).click();
  await page.getByRole("dialog", { name: "Make version 1 live?" }).getByRole("button", { name: "Make version 1 live" }).click();
  await expect(page.getByRole("status").getByText("Another version went live since you opened this page. History is up to date now.")).toBeVisible();
  await expect(liveSummary(page)).toHaveText(/^Version 1 is live\./);
  await expect(page.getByRole("button", { name: "Make live version 2" })).toBeVisible();
});

test("says when the site has not caught up yet, and updates it on request", async ({ page }) => {
  await openSite(page);
  await page.evaluate(() => window.__zsDemo!.setSiteEdgeDown(true));
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill("Closed for inventory this Monday");
  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").getByText("Published. Your site will show it in a moment.")).toBeVisible();
  const behind = page.getByText("Saved and live here, but your site still shows the previous version.");
  await expect(behind).toBeVisible();

  // Leaving the page and coming back keeps the warning and its button.
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Site" }).click();
  await expect(behind).toBeVisible();

  // Still down: the owner is told so instead of nothing happening.
  await page.getByRole("button", { name: "Update the site now" }).click();
  await expect(page.getByRole("status").getByText("Your site still shows the previous version. Try again in a moment.")).toBeVisible();
  await expect(behind).toBeVisible();

  await page.evaluate(() => window.__zsDemo!.setSiteEdgeDown(false));
  await page.getByRole("button", { name: "Update the site now" }).click();
  await expect(page.getByRole("status").getByText("Your site shows the live version now.")).toBeVisible();
  await expect(page.getByText("Saved and live here, but your site still shows the previous version.")).toBeHidden();
});

test("refuses a publish when another version went live while the editor was open", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill("Engagement rings by appointment");
  // Another owner makes version 1 live; this editor started from version 2.
  await page.evaluate(() => window.__zsDemo!.rollBackElsewhere());
  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(editor.getByText(/^Another version went live while you were editing/)).toBeVisible();
  await expect(editor.getByRole("button", { name: "Publish" })).toBeDisabled();
  // The owner's words stay in the editor, and nothing was added to History.
  await expect(editor.getByLabel("Tagline")).toHaveValue("Engagement rings by appointment");
  await expect(liveSummary(page)).toHaveText(/^Version 1 is live\./);
  await expect(releases(page)).toHaveCount(2);
});

test("a late publish answer does not close the editor opened after it", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill("First draft");
  await page.evaluate(() => window.__zsDemo!.delayNextSiteWrite(1_500));
  await editor.getByRole("button", { name: "Publish" }).click();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: "Edit site" }).click();
  await editor.getByLabel("Tagline").fill("Second draft, still typing");
  // The first publish lands: History and the summary move on, the open draft stays.
  await expect(releases(page)).toHaveCount(3);
  await expect(liveSummary(page)).toHaveText(/^Version 3 is live\./);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Tagline")).toHaveValue("Second draft, still typing");
  await expect(page.getByRole("status").getByText("Published. Your site is live.")).toHaveCount(0);
});

test("a publish retried after a lost answer replays instead of adding a second version", async ({ page }) => {
  // Lists count as fresh for 30 s; the clock moves past that before the page is shown again.
  await page.clock.install();
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill("Open late on Thursdays");
  await page.evaluate(() => window.__zsDemo!.loseNextSiteAnswer());
  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();

  // The lost publish did go live. Leaving and coming back later refreshes the page onto it.
  await page.clock.fastForward(60_000);
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Site" }).click();
  await expect(liveSummary(page)).toHaveText(/^Version 3 is live\./);

  // The editor reopens the unanswered publish as it was sent, so publishing it replays.
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(editor.getByTestId("site-resume")).toBeVisible();
  await expect(editor.getByLabel("Tagline")).toHaveValue("Open late on Thursdays");
  await editor.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").getByText("Published. Your site is live.")).toBeVisible();
  await expect(releases(page)).toHaveCount(3);
  await expect(liveSummary(page)).toHaveText(/^Version 3 is live\./);

  // Settled: the next opening starts from the live version again.
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(editor.getByTestId("site-resume")).toHaveCount(0);
});

test("checks the site again when another owner makes a version live", async ({ page }) => {
  // Lists count as fresh for 30 s; the clock moves past that before the page is shown again.
  await page.clock.install();
  await openSite(page);
  const behind = page.getByText("Saved and live here, but your site still shows the previous version.");
  await expect(page.getByRole("button", { name: "Edit site" })).toBeEnabled();
  await expect(behind).toHaveCount(0);
  // Another owner makes version 1 live while the site host is down.
  await page.evaluate(() => {
    window.__zsDemo!.setSiteEdgeDown(true);
    window.__zsDemo!.rollBackElsewhere();
  });
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await page.clock.fastForward(60_000);
  await mainNav(page).getByRole("link", { name: "Site" }).click();
  await expect(liveSummary(page)).toHaveText(/^Version 1 is live\./);
  // What this page learned about version 2 does not stand for version 1.
  await expect(behind).toBeVisible();
});

test("explains when a page holds more text than one request can carry", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  // Within every character limit, but about 72 KB once sent: CJK characters take 3 bytes each.
  const section = editor.getByRole("group", { name: "Section 1" });
  await section.getByLabel("Text").fill("鋳".repeat(2000));
  for (let index = 0; index < 11; index += 1) {
    await editor.getByRole("button", { name: "Add section" }).click();
    const added = editor.getByRole("group", { name: `Section ${index + 4}` });
    await added.getByLabel("Heading").fill("Workshop");
    await added.getByLabel("Text").fill("鋳".repeat(2000));
  }
  await expect(editor.getByText(/^This page holds more text than one publish can carry\./)).toBeVisible();
  await expect(editor.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Preview" })).toBeDisabled();
});
