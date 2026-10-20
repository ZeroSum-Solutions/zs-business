import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers";

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
  await expect(page.getByText("Saved and live here, but your site still shows the previous version.")).toBeVisible();

  await page.evaluate(() => window.__zsDemo!.setSiteEdgeDown(false));
  await page.getByRole("button", { name: "Update the site now" }).click();
  await expect(page.getByRole("status").getByText("Your site shows the live version now.")).toBeVisible();
  await expect(page.getByText("Saved and live here, but your site still shows the previous version.")).toBeHidden();
});
