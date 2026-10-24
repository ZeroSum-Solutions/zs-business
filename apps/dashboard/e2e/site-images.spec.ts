import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers";

// A 2 by 1 RGBA PNG, made for this test.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM4ISf3X07uxH8AECsEBxOnYNoAAAAASUVORK5CYII=", "base64");
/** The demo worker stages an edit 2.4 seconds after it is made; the list is read every 2 seconds. */
const WORKER = { timeout: 15_000 };

const images = (page: Page) => page.getByTestId("site-images");
const edits = (page: Page) => images(page).getByTestId("image-variant");

async function openImages(page: Page) {
  await page.goto("/site");
  await expect(page.getByRole("heading", { level: 1, name: "Site" })).toBeVisible();
  await expect(images(page).getByRole("heading", { level: 2, name: "Images" })).toBeVisible();
  await expect(images(page).getByRole("button", { name: "Upload a photo" })).toBeVisible();
}

test("uploads a photo, approves one edit and rejects another (image-port.md IM-24)", async ({ page }, info) => {
  await openImages(page);
  await images(page).getByTestId("image-upload-input").setInputFiles({ name: "ring.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("status").getByText("Photo uploaded. Pick an edit for it below.")).toBeVisible();
  // The new photo is picked, and has no edits yet.
  await expect(images(page).getByRole("button", { name: /^Photo 2, uploaded/ })).toHaveAttribute("aria-pressed", "true");
  await expect(images(page).getByTestId("image-photo-picked")).toContainText("2 by 1 pixels");
  await expect(images(page).getByText("No edits of this photo yet.", { exact: false })).toBeVisible();

  // Remove the background: queued, then staged, with the original and the edit side by side.
  const preset = images(page).getByLabel("Edit", { exact: true });
  await expect(preset).toHaveValue("background_remove");
  await images(page).getByRole("button", { name: "Make image" }).click();
  await expect(edits(page)).toHaveCount(1);
  const removal = edits(page).first();
  await expect(removal.getByTestId("image-variant-status")).toHaveText(/Waiting|Working/);
  await expect(removal.getByTestId("image-variant-status")).toHaveText("Ready to review", WORKER);
  // The "Making your image" note is out of date once the edit is ready, so it goes (it would cover the images).
  await expect(page.getByRole("status").getByText("Making your image.", { exact: false })).toHaveCount(0);
  await expect(removal.getByRole("img", { name: "Original photo" })).toBeVisible();
  await expect(removal.getByRole("img", { name: "Edited image: Remove background" })).toBeVisible();
  const provenance = removal.getByTestId("image-variant-provenance");
  await expect(provenance).toContainText("$0.08");
  await expect(provenance).toContainText("Test adapter (fake)");
  await expect(provenance).toContainText("fake-matte-v1");
  await expect(provenance).toContainText("none: test double with no weights");
  await shot(page, "24-site-images-staged", info.project.name);

  await removal.getByRole("button", { name: "Approve the edit: Remove background" }).click();
  await expect(removal.getByTestId("image-variant-status")).toHaveText("Approved");
  await expect(page.getByRole("status").getByText("Approved. It is being added to your images.")).toBeVisible();
  await expect(removal.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  // The buttons are gone, so focus moves to the edit's title, not to the page body.
  await expect(removal.getByRole("heading", { level: 3, name: "Remove background" })).toBeFocused();
  await expect(removal.getByTestId("image-variant-summary")).toHaveText("In your images, ready to use on your site.", WORKER);

  // A studio background needs a description; this one is turned down.
  await preset.selectOption("studio_background_swap");
  const make = images(page).getByRole("button", { name: "Make image" });
  await expect(make).toBeDisabled();
  await expect(images(page).getByTestId("disabled-reason")).toHaveText("Describe the background first.");
  await images(page).getByLabel("Describe the background").fill("Slate with soft light");
  await make.click();
  await expect(edits(page)).toHaveCount(2);
  const swap = edits(page).filter({ hasText: "Studio background: Slate with soft light" });
  await expect(swap.getByTestId("image-variant-status")).toHaveText("Ready to review", WORKER);
  await expect(swap.getByTestId("image-variant-provenance")).toContainText("$0.20");
  await swap.getByRole("button", { name: "Reject the edit: Studio background: Slate with soft light" }).click();
  await expect(swap.getByTestId("image-variant-status")).toHaveText("Rejected");
  await expect(swap.getByTestId("image-variant-summary")).toHaveText("You turned this one down. It will not be used.");
  await expect(swap.getByRole("img", { name: /^Edited image/ })).toHaveCount(0);
  await expect(swap.getByRole("button", { name: /^(Approve|Reject)/ })).toHaveCount(0);
  await expect(swap.getByRole("heading", { level: 3, name: "Studio background: Slate with soft light" })).toBeFocused();
  // The approved one stays approved.
  await expect(edits(page).filter({ hasText: "Remove background" }).getByTestId("image-variant-status")).toHaveText("Approved");
  await shot(page, "25-site-images-decided", info.project.name);
});

test("says in plain words why an edit failed", async ({ page }) => {
  await openImages(page);
  // The sample photo's studio background could not find the ring.
  const failed = edits(page).filter({ hasText: "Studio background: White marble with soft morning light" });
  await expect(failed.getByTestId("image-variant-status")).toHaveText("Failed");
  await expect(failed.getByTestId("image-variant-summary")).toHaveText("We could not pick out the item clearly enough. Try a photo with a plainer background.");

  await page.evaluate(() => window.__zsDemo!.failNextImageJob("insufficient_funds"));
  await images(page).getByLabel("Edit", { exact: true }).selectOption("upscale_2k");
  await images(page).getByRole("button", { name: "Make image" }).click();
  const upscale = edits(page).filter({ hasText: "Enlarge to 2K" });
  await expect(upscale.getByTestId("image-variant-status")).toHaveText("Failed", WORKER);
  await expect(upscale.getByTestId("image-variant-summary")).toHaveText("Your balance was too low for this edit. Add funds, then try again.");
  await expect(upscale.getByRole("button", { name: /^(Approve|Reject)/ })).toHaveCount(0);
});
