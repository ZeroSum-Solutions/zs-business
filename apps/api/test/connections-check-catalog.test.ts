// Connections A-8: the owner-run `pnpm connections:check-catalog`. The key comes from the environment only,
// the report prints no secret, and a mismatch exits non-zero. Runs against the in-process fake: no network.
import { describe, expect, it } from "vitest";
import { runCatalogCheck } from "../src/connections/check-catalog.js";
import { FakeComposio } from "../../../packages/core/test/connections/fake-composio.js";

const KEY = ["ck", "preview", "z".repeat(24)].join("_");
const capture = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => { lines.push(line); } };
};

describe("connections:check-catalog (A-8)", () => {
  it("refuses to run without COMPOSIO_API_KEY and makes no call", async () => {
    const fake = new FakeComposio();
    const out = capture();
    expect(await runCatalogCheck({ env: {}, fetch: fake.fetch, write: out.write })).toBe(2);
    expect(fake.calls).toHaveLength(0);
    expect(out.lines.join("\n")).toMatch(/COMPOSIO_API_KEY/);
  });

  it("exits 0 when the catalog matches and 1 on a mismatch, never printing the key", async () => {
    const fake = new FakeComposio();
    const ok = capture();
    expect(await runCatalogCheck({ env: { COMPOSIO_API_KEY: KEY, COMPOSIO_BASE_URL: "https://composio.test/api/v3.1" }, fetch: fake.fetch, write: ok.write })).toBe(0);
    expect(fake.calls.every((call) => call.apiKey === KEY)).toBe(true);
    fake.tools.set("SHOPIFY_GET_ORDER_BY_ID", { toolkit: "shopify", versions: ["20990101_00"] });
    const bad = capture();
    expect(await runCatalogCheck({ env: { COMPOSIO_API_KEY: KEY, COMPOSIO_BASE_URL: "https://composio.test/api/v3.1" }, fetch: fake.fetch, write: bad.write })).toBe(1);
    const report = JSON.parse(bad.lines.join("\n")) as { ok: boolean; results: { slug: string; problem: string | null }[] };
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.slug === "SHOPIFY_GET_ORDER_BY_ID")!.problem).toBe("version_missing");
    expect([...ok.lines, ...bad.lines].join("\n")).not.toContain(KEY);
  });

  it("refuses a base URL that is not https", async () => {
    const out = capture();
    expect(await runCatalogCheck({ env: { COMPOSIO_API_KEY: KEY, COMPOSIO_BASE_URL: "http://composio.test" }, fetch: new FakeComposio().fetch, write: out.write })).toBe(2);
  });
});
