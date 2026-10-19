import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { LIVE } from "./env";
import { resetLiveRows } from "./reset";

function liveSetting(name: "ZS_LIVE_AUTH_URL" | "ZS_LIVE_OWNER_EMAIL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Run through e2e:live so global setup can set ${name}`);
  return value;
}

export const ownerEmail = () => liveSetting("ZS_LIVE_OWNER_EMAIL");

/** The sign-in link the fake Supabase Auth would have emailed to this address last, if any. */
export async function lastSignInLink(email = ownerEmail()): Promise<string | null> {
  const response = await fetch(`${liveSetting("ZS_LIVE_AUTH_URL")}/__test/last-link?email=${encodeURIComponent(email)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The fake Supabase Auth answered ${response.status}`);
  return ((await response.json()) as { link: string }).link;
}

/** Ask for a link on the /sign-in page as the owner does, then open it as the email would. */
export async function signInThroughPage(page: Page, next = "/") {
  const before = await lastSignInLink();
  await page.goto(next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(ownerEmail());
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  const link = await lastSignInLink();
  expect(link, "a new sign-in link").not.toBe(before);
  await page.goto(link!);
  await page.waitForURL((url) => url.pathname === next);
}

/** Give an API request context the session cookies a browser gets from the email link. */
export async function signInRequest(request: APIRequestContext) {
  const response = await request.post(`${LIVE.webUrl}/api/sign-in`, { headers: { Origin: LIVE.webUrl }, data: { email: ownerEmail() } });
  expect(response.status()).toBe(204);
  const opened = await request.get((await lastSignInLink())!, { maxRedirects: 0 });
  expect(opened.status()).toBe(303);
  expect(opened.headers()["location"]).toBe("/");
}

/**
 * Every live test starts from the seeded rows, whatever the test before it wrote, and with
 * a page that signed in through /sign-in. Tests that need an anonymous browser open their own.
 */
export const test = base.extend<{ seededRows: void; anonymousPage: Page }>({
  seededRows: [async ({}, use) => {
    await resetLiveRows();
    await use();
  }, { auto: true }],
  page: async ({ page }, use) => {
    await signInThroughPage(page);
    await use(page);
  },
  // A page in the test's own context that never signed in (do not also use `page`).
  anonymousPage: async ({ context }, use) => {
    await use(await context.newPage());
  },
});

export { expect } from "@playwright/test";
