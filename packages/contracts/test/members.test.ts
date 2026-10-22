import { describe, expect, it } from "vitest";
import { meResponseSchema } from "../src/index.js";

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

  it("refuses an answer without the business name or the email", () => {
    const { businessName: _name, ...noName } = me;
    const { email: _email, ...noEmail } = me;
    expect(meResponseSchema.safeParse(noName).success).toBe(false);
    expect(meResponseSchema.safeParse(noEmail).success).toBe(false);
  });
});
