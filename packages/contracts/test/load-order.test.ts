// business.ts loads the package index, which loads company-facts.ts: either module may be loaded first.
import { expect, it } from "vitest";
import { WEEKDAYS } from "../src/business.js";

it("loads business.ts before the package index without a temporal dead zone error", () => {
  expect(WEEKDAYS).toHaveLength(7);
});
