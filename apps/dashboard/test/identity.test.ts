// The signed-in business and person come from the session (/api/session → /v1/me, or the demo
// seed), never from a constant: every tenant sees its own name, and staff are not called owners.
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { accountLabel, ROLE_LABEL } from "../src/components/shell/account-menu";
import { Brand, brandMark } from "../src/components/shell/app-shell";
import { SIGN_IN_TITLE } from "../src/components/shell/sign-in-view";
import { DEMO_BUSINESS, DEMO_OWNER, DEMO_STAFF } from "../src/lib/api/demo/seed";
import { greetingLine } from "../src/lib/greeting";
import { PRODUCT_NAME } from "../src/lib/product";
import { demoSession, sessionFromBody } from "../src/lib/session";
import manifest from "../src/app/manifest";

const html = (node: ReturnType<typeof h>) => renderToString(node).replaceAll("<!-- -->", "");

describe("signed-in identity", () => {
  it("names the demo business and whoever the demo acts as", () => {
    expect(demoSession({ currentActor: () => ({ role: "owner", userId: DEMO_OWNER.userId }) })).toMatchObject({
      status: "signed_in", role: "owner", businessName: DEMO_BUSINESS, email: DEMO_OWNER.email,
    });
    expect(demoSession({ currentActor: () => ({ role: "staff", userId: DEMO_STAFF.userId }) })).toMatchObject({
      status: "signed_in", role: "staff", userId: DEMO_STAFF.userId, businessName: DEMO_BUSINESS, email: DEMO_STAFF.email,
    });
  });

  it("labels the account with the member's own email, real role and business", () => {
    expect(accountLabel({ email: "sam@example.com", role: "staff", businessName: "Corner Bakery" }))
      .toBe("sam@example.com, Staff · Corner Bakery");
    expect(ROLE_LABEL.owner).toBe("Owner");
  });

  it("shows the session's business in the brand, and the product name before any session", () => {
    const signedIn = html(h(Brand, { identity: { email: "sam@example.com", role: "owner", businessName: "Corner Bakery" } }));
    expect(signedIn).toContain("Corner Bakery");
    expect(signedIn).toContain(">CB<");
    const signedOut = html(h(Brand, { identity: null }));
    expect(signedOut).toContain(PRODUCT_NAME);
    expect(brandMark("Halden & Rowe Fine Jewelry")).toBe("HR");
    expect(brandMark("  ")).toBe("ZS");
  });

  it("signs in from an older API's answer and falls back to neutral words", () => {
    const tenantId = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
    const older = sessionFromBody({ tenantId, userId: "u-1", role: "owner" });
    expect(older).toEqual({ status: "signed_in", tenantId, userId: "u-1", role: "owner" });
    const identity = { role: "owner" } as const;
    expect(accountLabel(identity)).toBe("Owner");
    expect(html(h(Brand, { identity }))).toContain(PRODUCT_NAME);
    expect(sessionFromBody({ tenantId, userId: "u-1", role: "staff", businessName: "Corner Bakery", email: "sam@example.com", extra: 1 }))
      .toEqual({ status: "signed_in", tenantId, userId: "u-1", role: "staff", businessName: "Corner Bakery", email: "sam@example.com" });
    expect(sessionFromBody({ tenantId, role: "owner" })).toEqual({ status: "unavailable" });
  });

  it("greets without a name, since members have none yet", () => {
    const morning = Date.parse("2026-10-22T13:00:00.000Z");
    expect(greetingLine(morning, "America/New_York")).toBe("Good morning.");
    expect(greetingLine(morning, "America/Los_Angeles")).toBe("Good morning.");
    expect(greetingLine(Date.parse("2026-10-22T23:00:00.000Z"), "America/New_York")).toBe("Good evening.");
    expect(greetingLine(null, "UTC")).toBe("Hello.");
  });

  it("names no business on sign-in, in page metadata or in the installed app", () => {
    expect(SIGN_IN_TITLE).toBe("Sign in");
    expect(manifest().name).toBe(PRODUCT_NAME);
    expect(JSON.stringify(manifest())).not.toMatch(/Halden|Rowe|Jewel/);
  });

  it("keeps the demo tenant out of shared shell and account code", () => {
    for (const file of [
      "src/app/layout.tsx", "src/app/manifest.ts", "src/app/not-found.tsx",
      "src/components/shell/account-menu.tsx", "src/components/shell/app-shell.tsx", "src/components/shell/sign-in-view.tsx",
      "src/components/account/settings-view.tsx", "src/components/account/plan-view.tsx",
    ]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/Halden|Rowe|Mara|Jewel|\bOWNER\b/);
      // A zone may be offered as a choice, never assumed as the default or a display zone.
      expect(source, file).not.toMatch(/(?:defaultValue=|formatDay\()[^\n]*America\/New_York/);
    }
  });
});
