import { test as base } from "@playwright/test";
import { resetLiveRows } from "./reset";

/** Every live test starts from the seeded rows, whatever the test before it wrote. */
export const test = base.extend<{ seededRows: void }>({
  seededRows: [async ({}, use) => {
    await resetLiveRows();
    await use();
  }, { auto: true }],
});

export { expect } from "@playwright/test";
