import { expect, test } from "@playwright/test";
import { shot } from "./helpers";

test("opens a voicemail transcript with two speakers, and explains a failed upload", async ({ page }, info) => {
  await page.goto("/inbox");
  await page.getByRole("link", { name: "Transcripts" }).click();
  await expect(page).toHaveURL(/\/inbox\/transcripts$/);
  await expect(page.getByRole("heading", { level: 1, name: "Transcripts" })).toBeVisible();
  await expect(page.getByText("Pick a recording")).toBeVisible();
  await expect(page.locator("[data-job]")).toHaveCount(3);

  await page.locator("[data-job]").filter({ hasText: "Voicemail" }).click();
  const segments = page.locator("[data-segment]");
  await expect(segments).toHaveCount(3);
  await expect(segments.nth(0)).toContainText("Speaker 1");
  await expect(segments.nth(0)).toContainText("sapphire halo ring");
  await expect(segments.nth(1)).toContainText("Speaker 2");
  await expect(segments.nth(2)).toContainText("Speaker 1");
  await shot(page, "40-transcript", info.project.name);

  await page.locator("[data-job]").filter({ hasText: "Could not transcribe" }).click();
  await expect(page.getByText("This file type is not supported")).toBeVisible();
  await expect(page.locator("[data-segment]")).toHaveCount(0);
});
