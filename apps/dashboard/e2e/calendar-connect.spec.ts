import { expect, test, type Page } from "@playwright/test";
import { shot, viewportShot } from "./helpers";

// Google Calendar on the Connections page, on the demo adapter (google-calendar.md G-1, G-2,
// G-5). The demo has no Google: a connect "allows" a made-up account at once and lands back on
// this page with ?calendar=connected, as the real callback does.

const card = (page: Page) => page.getByRole("region", { name: "Google Calendar" });
const row = (page: Page, name: string) => card(page).getByRole("listitem", { name });
const SHOWROOM = "Showroom appointments";
const REPAIR = "Repair intake";

async function openConnections(page: Page, search = "") {
  await page.goto(`/account/connections${search}`);
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function connect(page: Page, name: string) {
  await row(page, name).getByRole("button", { name: `Connect ${name}` }).click();
  await expect(card(page).getByTestId("gcal-return")).toHaveText("Google Calendar connected. Busy times start blocking slots after the first sync.");
  await expect(page).toHaveURL(/\/account\/connections$/);
  await expect(row(page, name).getByTestId("gcal-status")).toHaveText("Connected");
}

test("lists each booking calendar as live data, with the sample accounts below", async ({ page }) => {
  await openConnections(page);
  await expect(card(page).getByTestId("sample-badge")).toHaveCount(0);
  for (const name of [SHOWROOM, REPAIR]) {
    await expect(row(page, name).getByTestId("gcal-status")).toHaveText("Not connected");
    await expect(row(page, name).getByRole("button", { name: `Connect ${name}` })).toBeEnabled();
  }
  await expect(page.getByRole("heading", { level: 2, name: "Other accounts" })).toBeVisible();
  await expect(page.getByRole("main").getByText("Gmail", { exact: true })).toBeVisible();
  // The sample Google Calendar row is gone: the live card replaces it.
  await expect(page.getByRole("main").getByRole("heading", { name: "Google Calendar" })).toHaveCount(1);
});

test("an owner connects a calendar and sees the account and its first sync", async ({ page }, info) => {
  await openConnections(page);
  await connect(page, SHOWROOM);
  const showroom = row(page, SHOWROOM);
  await expect(card(page).getByRole("status")).toHaveText(/^Google Calendar connected\./);
  await expect(showroom.getByTestId("gcal-account")).toHaveText("mara@haldenrowe.example");
  await expect(showroom.getByTestId("gcal-synced")).toHaveText("Waiting for the first sync");
  await expect(showroom.getByRole("button", { name: `Disconnect ${SHOWROOM}` })).toBeEnabled();
  await expect(showroom.getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  // The page reads the connections again until the worker's first sync shows.
  await expect(showroom.getByTestId("gcal-synced")).toHaveText("Last synced just now", { timeout: 15_000 });
  await expect(row(page, REPAIR).getByTestId("gcal-status")).toHaveText("Not connected");
  await shot(page, "30-calendar-connected", info.project.name);
});

test("disconnecting asks first, then shows Disconnecting until the worker finishes", async ({ page }, info) => {
  await openConnections(page);
  await connect(page, REPAIR);
  const repair = row(page, REPAIR);
  const opener = repair.getByRole("button", { name: `Disconnect ${REPAIR}` });

  // Keeping it changes nothing.
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Disconnect Google Calendar?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep connected" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(repair.getByTestId("gcal-status")).toHaveText("Connected");

  await opener.click();
  await expect(dialog).toContainText("Busy times from Google stop blocking this calendar's open slots.");
  await expect(dialog).toContainText("Events already added to Google stay in Google.");
  if (info.project.name === "phone") await viewportShot(page, "31-calendar-disconnect", info.project.name);
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(repair.getByTestId("gcal-status")).toHaveText("Disconnecting");
  await expect(page.getByTestId("toast").filter({ hasText: `Disconnecting ${REPAIR}.` })).toBeVisible();
  await expect(repair.getByRole("button")).toHaveCount(0);
  await expect(repair.getByTestId("gcal-status")).toHaveText("Not connected", { timeout: 15_000 });
  await expect(repair.getByRole("button", { name: `Connect ${REPAIR}` })).toBeEnabled();
  const disconnects = await page.evaluate(() => window.__zsDemo!.writeLog().filter((write) => write.operation === "calendar.google.disconnect"));
  expect(disconnects.map((write) => write.outcome)).toEqual(["applied"]);
});

test("a calendar that lost Google's access offers Reconnect", async ({ page }) => {
  await openConnections(page);
  await connect(page, SHOWROOM);
  // SHOWROOM_ID in the demo seed.
  await page.evaluate((resourceId) => window.__zsDemo!.loseCalendarGrant(resourceId), "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61");
  await page.evaluate(() => window.__zsQueryClient!.invalidateQueries());
  const showroom = row(page, SHOWROOM);
  await expect(showroom.getByTestId("gcal-status")).toHaveText("Reconnect needed");
  await expect(showroom.getByTestId("gcal-warning")).toContainText("Google access ended.");
  await showroom.getByRole("button", { name: `Reconnect ${SHOWROOM}` }).click();
  await expect(showroom.getByTestId("gcal-status")).toHaveText("Connected");
  await expect(showroom.getByTestId("gcal-synced")).toHaveText("Waiting for the first sync");
});

test("staff see the status, but connecting and disconnecting are for owners", async ({ page }) => {
  await openConnections(page);
  await connect(page, SHOWROOM);
  await page.evaluate(() => window.__zsDemo!.actAs("staff"));
  const reason = "Only an owner can connect or disconnect calendars.";
  await expect(card(page).getByText(reason)).toBeVisible();
  const disconnect = row(page, SHOWROOM).getByRole("button", { name: `Disconnect ${SHOWROOM}` });
  const connectRepair = row(page, REPAIR).getByRole("button", { name: `Connect ${REPAIR}` });
  for (const button of [disconnect, connectRepair]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(reason);
  }
  await expect(row(page, SHOWROOM).getByTestId("gcal-account")).toHaveText("mara@haldenrowe.example");
});

test("says so when the server has no Google settings", async ({ page }) => {
  await openConnections(page);
  await page.evaluate(() => window.__zsDemo!.setGoogleCalendarConfigured(false));
  const button = row(page, SHOWROOM).getByRole("button", { name: `Connect ${SHOWROOM}` });
  await button.click();
  await expect(row(page, SHOWROOM).getByRole("alert")).toHaveText("Google Calendar is not set up on this server yet.");
  await expect(button).toHaveAccessibleDescription("Google Calendar is not set up on this server yet.");
  await expect(page).toHaveURL(/\/account\/connections$/);
  await expect(row(page, SHOWROOM).getByTestId("gcal-status")).toHaveText("Not connected");
});

test("explains an error from Google's return and takes the query off the address", async ({ page }, info) => {
  await openConnections(page, "?calendar=error&reason=browser_mismatch");
  const notice = card(page).getByRole("alert");
  await expect(notice).toHaveText("Finish connecting in the same browser you started in. Try again from this page.");
  await expect(page).toHaveURL(/\/account\/connections$/);
  // Still on screen after the address changed.
  await expect(notice).toBeVisible();
  if (info.project.name === "phone") await shot(page, "32-calendar-return-error", info.project.name);

  await openConnections(page, "?calendar=error&reason=denied");
  await expect(card(page).getByRole("alert")).toHaveText("Google access was not allowed. Nothing changed.");
  await expect(page).toHaveURL(/\/account\/connections$/);
});

test("says connected on Google's success return", async ({ page }) => {
  await openConnections(page, "?calendar=connected");
  await expect(card(page).getByRole("status")).toHaveText("Google Calendar connected. Busy times start blocking slots after the first sync.");
  await expect(page).toHaveURL(/\/account\/connections$/);
});
