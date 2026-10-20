// google-calendar.md G-1, G-2, G-5 against the real API and the fake Google global setup starts:
// the owner connects a booking calendar through Google's consent screen and the dashboard's
// callback route, a consent URL finished anywhere else connects nothing, and a disconnect hands the
// connection to the (absent) calendar worker.
import type { Page } from "@playwright/test";
import { expect, signInThroughPage, STAFF_EMAIL, test } from "./fixtures";

const NAME = "Showroom appointments";
const CONNECTIONS = "/account/connections";
const CALLBACK = "/api/calendar/google/callback";
const row = (page: Page) => page.getByTestId("gcal-row").filter({ has: page.getByRole("heading", { name: NAME, exact: true }) });

test("an owner connects a booking calendar through Google, then disconnects it", async ({ page }) => {
  await page.goto(CONNECTIONS);
  const showroom = row(page);
  await expect(showroom.getByTestId("gcal-status")).toHaveText("Not connected");

  // The fake consent screen grants at once and sends the browser back through the dashboard.
  const back = page.waitForResponse((response) => new URL(response.url()).pathname === CALLBACK);
  await showroom.getByRole("button", { name: `Connect ${NAME}` }).click();
  const callback = await back;
  expect(callback.status()).toBe(303);
  expect(callback.headers()["location"]).toBe(`${CONNECTIONS}?calendar=connected`);
  expect(callback.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByTestId("gcal-return")).toBeVisible();
  // The outcome is shown once; the address loses it.
  await expect(page).toHaveURL((url) => url.pathname === CONNECTIONS && url.search === "");

  await expect(showroom.getByTestId("gcal-status")).toHaveText("Connected");
  await expect(showroom.getByTestId("gcal-account")).toHaveText(/^owner-\d+@calendar\.test$/);
  // No calendar worker runs here.
  await expect(showroom.getByTestId("gcal-synced")).toHaveText("Waiting for the first sync");
  // The other calendar is untouched.
  await expect(page.getByTestId("gcal-row").filter({ has: page.getByRole("heading", { name: "Repair intake" }) }).getByTestId("gcal-status"))
    .toHaveText("Not connected");

  await showroom.getByRole("button", { name: `Disconnect ${NAME}` }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect Google Calendar?" });
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(showroom.getByTestId("gcal-status")).toHaveText("Disconnecting");
  await page.reload();
  await expect(row(page).getByTestId("gcal-status")).toHaveText("Disconnecting");
});

test("a consent URL finished in another browser connects nothing; the starting browser still can", async ({ page, request }) => {
  await page.goto(CONNECTIONS);
  const showroom = row(page);
  // Stop the owner's browser at Google's door and keep the consent URL it was sent to.
  let authorizeUrl = "";
  await page.route((url) => url.pathname === "/o/oauth2/v2/auth", async (route) => {
    authorizeUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Held</title>" });
  });
  await showroom.getByRole("button", { name: `Connect ${NAME}` }).click();
  await expect.poll(() => authorizeUrl).not.toBe("");
  await page.unrouteAll();

  // Someone else opens it, with no cookie from the owner's browser: Google grants, the API refuses.
  const atGoogle = await request.get(authorizeUrl, { maxRedirects: 0 });
  expect(atGoogle.status()).toBe(302);
  const redirect = new URL(atGoogle.headers()["location"]!);
  expect(redirect.pathname).toBe(CALLBACK);
  const landed = await request.get(redirect.href, { maxRedirects: 0 });
  expect(landed.status()).toBe(303);
  expect(landed.headers()["location"]).toBe(`${CONNECTIONS}?calendar=error&reason=browser_mismatch`);

  await page.goto(CONNECTIONS);
  await expect(row(page).getByTestId("gcal-status")).toHaveText("Not connected");
  // The owner's own browser, which holds the key, finishes the same flow.
  await page.goto(authorizeUrl);
  await expect(page).toHaveURL((url) => url.pathname === CONNECTIONS);
  await expect(row(page).getByTestId("gcal-status")).toHaveText("Connected");
});

test("staff see the calendar status but cannot connect or disconnect", async ({ anonymousPage: page }) => {
  await signInThroughPage(page, CONNECTIONS, STAFF_EMAIL);
  const showroom = row(page);
  await expect(showroom.getByTestId("gcal-status")).toHaveText("Not connected");
  await expect(showroom.getByRole("button", { name: `Connect ${NAME}` })).toBeDisabled();
  await expect(page.getByText("Only an owner can connect or disconnect calendars.")).toBeVisible();
});
