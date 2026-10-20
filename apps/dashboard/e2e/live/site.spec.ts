import { shot } from "../helpers";
import { expect, test } from "./fixtures";

const PREFIX = "live-";

// Site history is append-only, so the reset between tests keeps it: each run builds on the
// versions the last one left, and the first run creates the website.
test("creates the website, previews and publishes two versions, then brings the first back", async ({ page }, info) => {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible();
  const create = page.getByRole("button", { name: "Create website" });
  const edit = page.getByRole("button", { name: "Edit site" });
  await expect(create.or(edit)).toBeVisible();
  if (await create.isVisible()) {
    await page.getByLabel("Website name").fill("Halden & Rowe");
    await create.click();
  }
  await expect(edit).toBeEnabled();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const releases = page.getByTestId("site-release");
  const before = await releases.count();
  const summary = page.getByTestId("site-live-summary");

  const publish = async (tagline: string) => {
    await edit.click();
    const editor = page.getByRole("dialog", { name: "Edit site" });
    await editor.getByLabel("Site title").fill("Halden & Rowe");
    await editor.getByLabel("Tagline").fill(tagline);
    await editor.getByRole("button", { name: "Preview" }).click();
    // Compiled by the API's plain compiler; nothing goes live.
    await expect(page.frameLocator('[data-testid="site-preview"]').getByText(tagline)).toBeVisible();
    await editor.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("status").getByText("Published. Your site is live.").last()).toBeVisible();
    await expect(editor).toBeHidden();
  };

  const first = `Fittings by appointment (${info.project.name} ${Date.now()})`;
  await publish(first);
  await expect(summary).toHaveText(new RegExp(`^Version ${before + 1} is live\\.`));
  await publish("Rings and repairs on Hudson Street");
  await expect(summary).toHaveText(new RegExp(`^Version ${before + 2} is live\\.`));
  await expect(releases).toHaveCount(before + 2);
  await shot(page, "21-site", info.project.name, PREFIX);

  await page.getByRole("button", { name: `Make live version ${before + 1}` }).click();
  await page.getByRole("dialog", { name: `Make version ${before + 1} live?` })
    .getByRole("button", { name: `Make version ${before + 1} live` }).click();
  await expect(page.getByRole("status").getByText(`Version ${before + 1} is live again.`)).toBeVisible();
  await expect(summary).toHaveText(new RegExp(`^Version ${before + 1} is live\\.`));

  // The API now serves the first version as live, and the editor starts from it.
  await page.reload();
  await expect(summary).toHaveText(new RegExp(`^Version ${before + 1} is live\\.`));
  await edit.click();
  await expect(page.getByRole("dialog", { name: "Edit site" }).getByLabel("Tagline")).toHaveValue(first);
});
