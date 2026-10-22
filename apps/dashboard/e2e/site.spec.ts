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
  // One status: the badge and summary say it is updating, not that the site is live (U3 A-2).
  await expect(page.getByTestId("site-badge")).toHaveText("Updating");
  await expect(liveSummary(page)).toHaveText("Version 3 is live. Your site will show it in a moment.");

  // Leaving the page and coming back keeps the warning and its button.
  await mainNav(page).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers" })).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Site" }).click();
  await expect(behind).toBeVisible();

  // Still down: the card says so instead of nothing happening, and no toast repeats it (U3 A-1).
  await page.getByRole("button", { name: "Update the site now" }).click();
  await expect(page.getByTestId("site-edge-checked")).toHaveText("Checked again just now. Try again in a moment.");
  await expect(behind).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveCount(0);

  await page.evaluate(() => window.__zsDemo!.setSiteEdgeDown(false));
  await page.getByRole("button", { name: "Update the site now" }).click();
  await expect(page.getByRole("status").getByText("Your site shows the live version now.")).toBeVisible();
  await expect(page.getByText("Saved and live here, but your site still shows the previous version.")).toBeHidden();
  await expect(page.getByTestId("site-badge")).toHaveText("Live");
  await expect(page.getByTestId("toast")).toHaveCount(1);
});

test("refuses a publish when another version went live while the editor was open", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByLabel("Tagline").fill("Engagement rings by appointment");
  // Another owner makes version 1 live; this editor started from version 2.
  await page.evaluate(() => window.__zsDemo!.rollBackElsewhere());
  await editor.getByRole("button", { name: "Publish" }).click();
  // A warning at the top of the editor, where the owner looks first (U3 A-6).
  const warning = editor.getByRole("alert").filter({ hasText: /^Another version went live while you were editing/ });
  await expect(warning).toBeVisible();
  await expect(warning).toBeInViewport();
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

  // Reopened while the first publish is on its way: nothing else can be published yet.
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(editor.getByTestId("site-resume")).toContainText("still on its way");
  await expect(editor.getByRole("button", { name: "Publish" })).toBeDisabled();
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
  // The page does not call it settled while the publish has no answer (U3 A-1).
  await expect(page.getByTestId("site-badge")).toHaveText("Not confirmed");
  await expect(liveSummary(page)).toContainText("Your last publish got no answer. Open Edit site to finish it.");

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

test("refuses a second publish while the first has no answer", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  const publish = editor.getByRole("button", { name: "Publish" });
  await editor.getByLabel("Tagline").fill("Draft A");
  await page.evaluate(() => window.__zsDemo!.loseNextSiteAnswer());
  await publish.click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();

  // Reopened, the editor holds A. Any other draft cannot be published until A is answered.
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(editor.getByTestId("site-resume")).toBeVisible();
  await expect(editor.getByLabel("Tagline")).toHaveValue("Draft A");
  await editor.getByLabel("Tagline").fill("Draft B");
  await expect(publish).toBeDisabled();
  await expect(editor.getByText("This changes the publish that got no answer.")).toBeVisible();

  // Sent again as it was, A replays: one new version, and the page is free again.
  await editor.getByLabel("Tagline").fill("Draft A");
  await publish.click();
  await expect(page.getByRole("status").getByText("Published. Your site is live.")).toBeVisible();
  await expect(releases(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Edit site" }).click();
  await expect(editor.getByTestId("site-resume")).toHaveCount(0);
  await editor.getByLabel("Tagline").fill("Draft B");
  await expect(publish).toBeEnabled();
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

test("a double click on Make version 1 live sends once and toasts once (U3-4)", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Make live version 1" }).click();
  await page.getByRole("dialog", { name: "Make version 1 live?" }).getByRole("button", { name: "Make version 1 live" }).dblclick();
  await expect(page.getByRole("status").getByText("Version 1 is live again.")).toBeVisible();
  await expect(page.getByTestId("toast").filter({ hasText: "Version 1 is live again." })).toHaveCount(1);
  await expect(releases(page)).toHaveCount(2);
});

test("a pasted title past the limit stays whole and says what to shorten (U3-10)", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  const title = editor.getByLabel("Site title");
  await title.fill("T".repeat(150));
  await expect(title).toHaveValue("T".repeat(150));
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByTestId("disabled-reason")).toHaveText("Shorten the site title to 120 characters.");
  await expect(editor.getByRole("button", { name: "Publish" })).toBeDisabled();
});

test("the preview takes focus to the way back, and back to editing focuses the title (U3-11)", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  await editor.getByRole("button", { name: "Preview" }).click();
  await expect(editor.getByTestId("site-preview")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Back to editing" })).toBeFocused();
  await expect(editor.getByText("This is a preview. Nothing changes on your site until you publish.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.getByLabel("Site title")).toBeFocused();
});

test("the editor's actions stay in view while a long form scrolls (U3 A-7)", async ({ page }) => {
  await openSite(page);
  await page.getByRole("button", { name: "Edit site" }).click();
  const editor = page.getByRole("dialog", { name: "Edit site" });
  for (let index = 0; index < 4; index += 1) await editor.getByRole("button", { name: "Add section" }).click();
  await editor.getByLabel("Site title").focus();
  await expect(editor.getByTestId("disabled-reason")).toBeInViewport();
  await expect(editor.getByRole("button", { name: "Preview" })).toBeInViewport();
  await expect(editor.getByRole("button", { name: "Publish" })).toBeInViewport();
});
