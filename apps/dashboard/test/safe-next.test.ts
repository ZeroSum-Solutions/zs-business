import { describe, expect, it } from "vitest";
import { safeNextUrl } from "../src/lib/safe-next";

const ORIGIN = "http://127.0.0.1:3218";
const HOME = `${ORIGIN}/`;

/** What a browser does with the result: resolve it as a link on this page. */
const landsOn = (next: string) => new URL(safeNextUrl(next, ORIGIN), `${ORIGIN}/sign-in`);

describe("safeNextUrl", () => {
  it.each([
    ["//evil"],
    ["/\\evil"],
    ["\\\\evil"],
    ["/\t/evil"],
    ["/\n/evil"],
    ["/\r\n/evil"],
    ["\t//evil"],
    ["\n//evil"],
    [" //evil"],
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["https://evil"],
    ["http:evil"],
    [""],
  ])("sends %j home", (next) => {
    expect(safeNextUrl(next, ORIGIN)).toBe(HOME);
  });

  it.each([
    ["/.//evil", `${ORIGIN}/evil`],
    ["/foo/..//evil", `${ORIGIN}/evil`],
    ["/%2e//evil", `${ORIGIN}/evil`],
    ["/%2E//evil", `${ORIGIN}/evil`],
    ["/./\\/evil", `${ORIGIN}/evil`],
    ["/.//evil.example/?x=1#h", `${ORIGIN}/evil.example/?x=1#h`],
    // Encoded slashes stay encoded: one path segment on this site.
    ["/%2F%2Fevil", `${ORIGIN}/%2F%2Fevil`],
  ])("keeps %j on this site, with no leading run of slashes", (next, expected) => {
    expect(safeNextUrl(next, ORIGIN)).toBe(expected);
  });

  it("keeps a valid page with its query and hash", () => {
    expect(safeNextUrl("/customers?x=1#h", ORIGIN)).toBe(`${ORIGIN}/customers?x=1#h`);
    expect(safeNextUrl("/customers", ORIGIN)).toBe(`${ORIGIN}/customers`);
  });

  it("sends a missing next home", () => {
    expect(safeNextUrl(null, ORIGIN)).toBe(HOME);
    expect(safeNextUrl(undefined, ORIGIN)).toBe(HOME);
  });

  it("never leads off the site for any of the known tricks", () => {
    const tricks = ["//evil", "/\\evil", "\\\\evil", "/.//evil", "/foo/..//evil", "/%2e//evil", "/%2F%2Fevil", "/\t/evil", "/\n/evil", "javascript:alert(1)", "https://evil"];
    for (const next of tricks) {
      const url = landsOn(next);
      expect(url.origin, next).toBe(ORIGIN);
      expect(url.pathname, next).not.toMatch(/^[/\\]{2}/);
      // Read back as a relative link, the path part must not name a host either.
      expect(new URL(`${url.pathname}${url.search}${url.hash}`, "https://elsewhere.test").origin, next).toBe("https://elsewhere.test");
    }
  });
});
