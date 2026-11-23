// docs/requirements/inbound-email.md IE-9, IE-12: the receive payload holds what the database check holds.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inboundEmailReceiveInputSchema } from "../src/index.js";

const input = (subject: string | null) => ({
  inboundEmailId: randomUUID(), provider: "resend", providerEmailId: "em_1", addressId: randomUUID(),
  replyRef: null, fromAddress: "pat@example.com", subject,
});

describe("inbound email receive input (IE-12)", () => {
  it("takes a one-line subject or none", () => {
    expect(inboundEmailReceiveInputSchema.safeParse(input("Ring sizing")).success).toBe(true);
    expect(inboundEmailReceiveInputSchema.safeParse(input(null)).success).toBe(true);
  });
  it("refuses an empty subject, a control character and a subject over 200", () => {
    for (const subject of ["", "a\tb", "a\u0007b", "a\u0085b", "a\nb", "x".repeat(201)])
      expect(inboundEmailReceiveInputSchema.safeParse(input(subject)).success, JSON.stringify(subject)).toBe(false);
  });
});
