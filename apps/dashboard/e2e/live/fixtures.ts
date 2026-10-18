import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { LIVE } from "./env";
import { resetLiveRows } from "./reset";

export function accessCode(): string {
  const code = process.env.ZS_LIVE_ACCESS_CODE;
  if (!code) throw new Error("Run through e2e:live so global setup can set the access code");
  return code;
}

/** Sign in the way the owner does: the /sign-in page and the run's access code. */
export async function signInThroughPage(page: Page, next = "/") {
  await page.goto(next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Access code").fill(accessCode());
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

/** Give an API request context the pilot session cookie, as a signed-in browser has. */
export async function signInRequest(request: APIRequestContext) {
  const response = await request.post(`${LIVE.webUrl}/api/sign-in`, { headers: { Origin: LIVE.webUrl }, data: { code: accessCode() } });
  expect(response.status()).toBe(204);
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
