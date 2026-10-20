import { plainSiteSpecSchema, publishSiteRequestSchema } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import { cut, draftFrom, draftProblem, LIMITS, MAX_REQUEST_BYTES, specFrom, type Draft } from "../src/components/site/draft";

const BASELINE = "5b0c7d2e-41a6-4f3b-9c55-8e2f6a1d3b70";
const draft = (change: Partial<Draft> = {}): Draft => ({ title: "Halden & Rowe", tagline: "", sections: [], ...change });
const section = (heading: string, body: string) => ({ key: 1, heading, body });

describe("site draft", () => {
  it("starts a new site from its name, cut to a title the API takes", () => {
    const long = draftFrom(undefined, `  ${"R".repeat(150)}  `);
    expect(long.title).toHaveLength(LIMITS.title);
    expect(plainSiteSpecSchema.safeParse(specFrom(long)).success).toBe(true);
    // An emoji is two UTF-16 units; it is dropped whole, never split.
    expect(cut(`${"a".repeat(119)}💎`, 120)).toBe("a".repeat(119));
    expect(draftFrom(undefined, "Halden & Rowe").title).toBe("Halden & Rowe");
  });

  it("starts from the live plain spec, skipping sections it cannot edit", () => {
    const from = draftFrom({ kind: "plain", title: "Shop", tagline: "Rings", sections: [{ heading: "A", body: "B" }, { heading: 1 }, "x"] }, "Name");
    expect(specFrom(from)).toEqual({ kind: "plain", title: "Shop", tagline: "Rings", sections: [{ heading: "A", body: "B" }] });
  });

  it("checks the limits the API checks, after trimming", () => {
    expect(draftProblem(draft({ title: "  " }), null)).toBe("Add a site title first.");
    expect(draftProblem(draft({ title: "T".repeat(121) }), null)).toBe("Shorten the site title to 120 characters.");
    expect(draftProblem(draft({ title: ` ${"T".repeat(120)} ` }), null)).toBeNull();
    expect(draftProblem(draft({ tagline: "t".repeat(201) }), null)).toBe("Shorten the tagline to 200 characters.");
    expect(draftProblem(draft({ sections: [section("Visit", " ")] }), null)).toBe("Each section needs a heading and some text.");
    expect(draftProblem(draft({ sections: [section("h".repeat(121), "Body")] }), null)).toBe("Shorten each section heading to 120 characters.");
    expect(draftProblem(draft({ sections: [section("Visit", "b".repeat(2001))] }), null)).toBe("Shorten each section's text to 2,000 characters.");
    // Anything draftProblem lets through, the API's schema takes too.
    const ok = draft({ tagline: "t".repeat(200), sections: [section("h".repeat(120), "b".repeat(2000))] });
    expect(draftProblem(ok, BASELINE)).toBeNull();
    expect(plainSiteSpecSchema.safeParse(specFrom(ok)).success).toBe(true);
  });

  it("refuses a page whose publish body is over 64 KiB, counted in UTF-8", () => {
    const sections = (body: string, count: number) => Array.from({ length: count }, (_, key) => ({ key, heading: "Workshop", body }));
    // 20 sections of 2,000 ASCII letters fit; the same in CJK (3 bytes each) does not.
    expect(draftProblem(draft({ sections: sections("a".repeat(2000), 20) }), BASELINE)).toBeNull();
    const big = draft({ sections: sections("鋳".repeat(2000), 20) });
    expect(draftProblem(big, BASELINE)).toMatch(/^This page holds more text than one publish can carry\./);
    const body = JSON.stringify({ spec: specFrom(big), expectedCurrentReleaseId: BASELINE });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(publishSiteRequestSchema.safeParse(JSON.parse(body)).success).toBe(true);
  });
});
