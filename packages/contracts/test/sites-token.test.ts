// hub-access.md H-13, H-14: the `sites:publish` scope, the token's site list and the token publish body.
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SCOPE_INFO, MAX_TOKEN_SITES, createAutomationTokenRequestSchema, tokenPreviewSiteRequestSchema, tokenPublishSiteRequestSchema,
} from "../src/index.js";

const id = () => crypto.randomUUID();
const spec = { kind: "plain", title: "Halden & Rowe", sections: [{ heading: "Hours", body: "Mon to Fri" }] };

describe("sites:publish token request (H-13, H-14)", () => {
  it("defaults the expiry to 90 days and keeps the site list", () => {
    const site = id();
    expect(createAutomationTokenRequestSchema.parse({ name: "Agent", scopes: ["sites:publish"], siteIds: [site] }))
      .toEqual({ name: "Agent", scopes: ["sites:publish"], expiresInDays: 90, siteIds: [site] });
    expect(createAutomationTokenRequestSchema.parse({ name: "Agent", scopes: ["contacts:propose"] }))
      .toMatchObject({ expiresInDays: null, siteIds: [] });
  });

  it("needs 1 to 10 distinct sites with the scope, and refuses sites without it", () => {
    const parse = (value: unknown) => createAutomationTokenRequestSchema.safeParse(value).success;
    const sites = (n: number) => Array.from({ length: n }, id);
    expect(parse({ name: "A", scopes: ["sites:publish"] })).toBe(false);
    expect(parse({ name: "A", scopes: ["sites:publish"], siteIds: [] })).toBe(false);
    expect(parse({ name: "A", scopes: ["sites:publish"], siteIds: sites(MAX_TOKEN_SITES) })).toBe(true);
    expect(parse({ name: "A", scopes: ["sites:publish"], siteIds: sites(MAX_TOKEN_SITES + 1) })).toBe(false);
    const dup = id();
    expect(parse({ name: "A", scopes: ["sites:publish"], siteIds: [dup, dup] })).toBe(false);
    expect(parse({ name: "A", scopes: ["contacts:read"], siteIds: sites(1) })).toBe(false);
    expect(parse({ name: "A", scopes: ["sites:publish"], siteIds: sites(1), expiresInDays: null })).toBe(false);
  });

  it("lists the scope with its own kind and a disclosure that says it cannot read customers", () => {
    const entry = AUTOMATION_SCOPE_INFO.items.find((item) => item.scope === "sites:publish");
    expect(entry).toMatchObject({ kind: "publish" });
    expect(entry!.disclosure).toContain("Cannot read customers");
  });
});

describe("token publish body (H-15 step 7, X-12)", () => {
  it("takes a spec and refuses the keys that name a tenant, origin, click base or sign-up target", () => {
    expect(tokenPublishSiteRequestSchema.safeParse({ spec }).success).toBe(true);
    for (const key of ["tenantId", "origin", "trackBase", "signup"])
      expect(tokenPublishSiteRequestSchema.safeParse({ spec: { ...spec, [key]: "x" } }).success, key).toBe(false);
    expect(tokenPublishSiteRequestSchema.safeParse({ spec, tenantId: id() }).success).toBe(false);
  });

  it("takes only the spec for a preview, and a baseline only for a publish", () => {
    expect(tokenPreviewSiteRequestSchema.safeParse({ spec }).success).toBe(true);
    expect(tokenPreviewSiteRequestSchema.safeParse({ spec, expectedCurrentReleaseId: null }).success).toBe(false);
    expect(tokenPreviewSiteRequestSchema.safeParse({ spec: { ...spec, tenantId: id() } }).success).toBe(false);
    expect(tokenPublishSiteRequestSchema.safeParse({ spec, expectedCurrentReleaseId: null }).success).toBe(true);
  });
});
