import { describe, expect, it } from "vitest";
import { meReadSchema, meResponseSchema } from "../src/index.js";

const me = {
  tenantId: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70",
  userId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000001",
  memberId: "9a1b3c5d-7e9f-4a1b-8c2d-000000000003",
  role: "staff",
  permissions: ["calendar", "customers", "inbox.drafts"],
  businessName: "Tenant A",
  email: "staff@example.com",
};

describe("GET /v1/me", () => {
  it("names the business and the member's own email with the membership", () => {
    expect(meResponseSchema.parse(me)).toEqual(me);
  });

  it("allows the original shape without the profile, and nothing beyond the known keys", () => {
    const { businessName: _name, email: _email, ...original } = me;
    expect(meResponseSchema.parse(original)).toEqual(original);
    expect(meResponseSchema.safeParse({ ...me, extra: 1 }).success).toBe(false);
  });
});

describe("reading GET /v1/me", () => {
  it("accepts an older API's answer without the business name or the email", () => {
    const { businessName: _name, email: _email, ...older } = me;
    expect(meReadSchema.parse(older)).toEqual(older);
  });

  it("drops keys it does not know, and keeps the business name and email when sent", () => {
    expect(meReadSchema.parse({ ...me, timeZone: "UTC" })).toEqual(me);
    expect(meReadSchema.parse({ ...me, permissions: ["calendar", "future.permission"] }).permissions)
      .toEqual(["calendar", "future.permission"]);
  });

  it("still refuses an answer without the membership", () => {
    const { memberId: _member, ...noMember } = me;
    expect(meReadSchema.safeParse(noMember).success).toBe(false);
    expect(meReadSchema.safeParse({ ...me, role: "admin" }).success).toBe(false);
  });
});
