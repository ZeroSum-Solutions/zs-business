import { describe, expect, it } from "vitest";
import {
  BOOKING_PAGE_UPDATE_ACTION,
  bookingPageSummarySchema,
  updateBookingPageCommandSchema,
  updateBookingPageRequestSchema,
  updateBookingPageResponseSchema,
} from "../src/index.js";

// public-intake.md P-24 as contracts: the owner edit of a booking page's title and description.

const tenantId = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const pageId = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a71";
const issuePaths = (input: unknown) => {
  const result = updateBookingPageRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};
const ok = (changes: unknown) => updateBookingPageRequestSchema.safeParse({ changes }).success;

describe("the page edit request (P-24)", () => {
  it("takes the title, the description or both, trimmed; null clears the description", () => {
    expect(updateBookingPageRequestSchema.parse({ changes: { title: "  Book a visit " } }).changes).toEqual({ title: "Book a visit" });
    expect(updateBookingPageRequestSchema.parse({ changes: { description: " Pick a time. " } }).changes).toEqual({ description: "Pick a time." });
    expect(updateBookingPageRequestSchema.parse({ changes: { title: "A", description: null } }).changes).toEqual({ title: "A", description: null });
  });

  it("refuses an empty change set, unknown keys, and a body without `changes`", () => {
    expect(ok({})).toBe(false);
    expect(ok({ published: true })).toBe(false);
    expect(ok({ title: "A", disclosureText: "x" })).toBe(false);
    expect(updateBookingPageRequestSchema.safeParse({ title: "A" }).success).toBe(false);
    expect(updateBookingPageRequestSchema.safeParse({ changes: { title: "A" }, extra: 1 }).success).toBe(false);
  });

  it("never clears the title, and refuses a blank or empty description", () => {
    expect(ok({ title: null })).toBe(false);
    expect(ok({ title: "" })).toBe(false);
    expect(ok({ title: "   " })).toBe(false);
    expect(ok({ description: "" })).toBe(false);
    expect(ok({ description: "   " })).toBe(false);
  });

  it("counts code points at 200 and 2000, as the table's CHECKs do, and refuses text Postgres cannot store", () => {
    expect(ok({ title: "t".repeat(200) })).toBe(true);
    expect(ok({ title: "t".repeat(201) })).toBe(false);
    expect(ok({ title: "😀".repeat(200) })).toBe(true);
    expect(ok({ description: "d".repeat(2000) })).toBe(true);
    expect(ok({ description: "d".repeat(2001) })).toBe(false);
    expect(ok({ description: "😀".repeat(2000) })).toBe(true);
    expect(ok({ title: "a\u0000b" })).toBe(false);
  });

  it("names the field's path in the issue", () => {
    expect(issuePaths({ changes: { title: "" } })).toEqual(["changes.title"]);
    expect(issuePaths({ changes: { description: "d".repeat(2001) } })).toEqual(["changes.description"]);
  });
});

describe("the page edit command and answer (P-24)", () => {
  const command = {
    idempotencyKey: "k1", actionType: BOOKING_PAGE_UPDATE_ACTION, target: { tenantId, type: "booking_page", id: pageId },
    payload: { pageId, changes: { description: "Pick a time." } },
    approvalReference: { tenantId, id: tenantId },
  };

  it("is the action `booking.page.update`, aimed at the page the payload names", () => {
    expect(BOOKING_PAGE_UPDATE_ACTION).toBe("booking.page.update");
    expect(updateBookingPageCommandSchema.safeParse(command).success).toBe(true);
    const other = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a72";
    expect(updateBookingPageCommandSchema.safeParse({ ...command, target: { ...command.target, id: other } }).success).toBe(false);
    expect(updateBookingPageCommandSchema.safeParse({ ...command, target: { ...command.target, type: "business_profile" } }).success).toBe(false);
    expect(updateBookingPageCommandSchema.safeParse({ ...command, payload: { pageId, changes: {} } }).success).toBe(false);
  });

  it("answers with the page as it stands, whether anything changed, and whether a stored action replied", () => {
    const answer = { actionId: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a73", result: { pageId, title: "Book a visit", description: null, changed: false }, replayed: true };
    expect(updateBookingPageResponseSchema.parse(answer)).toEqual(answer);
    expect(updateBookingPageResponseSchema.safeParse({ ...answer, result: { ...answer.result, changed: undefined } }).success).toBe(false);
  });
});

describe("the owner's page list (P-12)", () => {
  it("carries the description, null when the page has none", () => {
    const summary = {
      id: pageId, title: "Book a visit", description: null, published: true, disclosureVersion: "v1", resourceIds: [],
      publicKey: "zsb1_x", bookingUrl: "https://book.example.com/book/zsb1_x", embedScript: "<div></div>", embedIframe: "<iframe></iframe>",
    };
    expect(bookingPageSummarySchema.parse(summary)).toEqual(summary);
    expect(bookingPageSummarySchema.parse({ ...summary, description: "Pick a time." }).description).toBe("Pick a time.");
    expect(bookingPageSummarySchema.safeParse({ ...summary, description: undefined }).success).toBe(false);
  });
});
