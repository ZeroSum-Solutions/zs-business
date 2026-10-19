import { expect, test } from "@playwright/test";
import { findWebsiteBooking, shot } from "./helpers";

test("marks website bookings in Calendar and shows the booking page and embed code", async ({ page }, info) => {
  await page.goto("/calendar");
  const card = page.getByTestId("booking-page");
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "Open booking page" })).toHaveAttribute("href", /^https:\/\/book\.example\.com\/book\/zsb1_/);
  const code = card.getByLabel("Embed code to paste into your website");
  await expect(code).toHaveValue(/data-zs-booking=/);
  await card.getByRole("button", { name: "Plain iframe" }).click();
  await expect(code).toHaveValue(/<iframe /);

  const row = await findWebsiteBooking(page, "Linnea Castellanos");
  await expect(row.getByTestId("website-badge")).toHaveText("Website");
  await expect(row.getByText("Website booking")).toBeVisible();
  await shot(page, "19-calendar-website", info.project.name);
});

test("links one possible match, keeps another apart, and both leave the review list", async ({ page }, info) => {
  await page.goto("/customers");
  const panel = page.getByRole("region", { name: "Website bookings to review" });
  await expect(panel.getByTestId("website-request")).toHaveCount(2);
  await shot(page, "20-website-requests", info.project.name);

  const okafor = panel.getByTestId("website-request").filter({ hasText: "M. Okafor" });
  await okafor.getByRole("button", { name: "Same person as Marguerite Okafor" }).click();
  await expect(page.getByRole("status").getByText("Linked the booking to Marguerite Okafor.")).toBeVisible();
  await expect(okafor).toHaveCount(0);

  // A split identity offers both customers; the owner says it is neither.
  const teo = panel.getByTestId("website-request").filter({ hasText: "Teo Lindqvist" });
  await expect(teo.getByRole("button", { name: /^Same person as / })).toHaveCount(2);
  await teo.getByRole("button", { name: "Different person" }).click();
  await expect(page.getByRole("status").getByText("Kept Teo Lindqvist apart from your customers.")).toBeVisible();
  await expect(panel).toHaveCount(0);

  // The linked booking now names the customer in Calendar.
  await page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name: "Calendar" }).click();
  const row = await findWebsiteBooking(page, "Marguerite Okafor");
  await expect(row.getByTestId("website-badge")).toHaveText("Website");
});
