// public-intake.md P-17: the booking page edit form turns what an owner types into the `changes` a
// save sends: only what changed, an emptied description is null, a title is never empty.
import { describe, expect, it } from "vitest";
import { pageFieldFromIssuePath, readBookingPageForm, toBookingPageForm } from "../src/lib/booking-page-form";

const page = (change: { title?: string; description?: string | null } = {}) => ({ title: "Book a visit", description: null, ...change });

describe("toBookingPageForm", () => {
  it("shows no description as an empty field", () => {
    expect(toBookingPageForm(page())).toEqual({ title: "Book a visit", description: "" });
    expect(toBookingPageForm(page({ description: "Pick a time." }))).toEqual({ title: "Book a visit", description: "Pick a time." });
  });
});

describe("readBookingPageForm", () => {
  it("sends no change when nothing was edited", () => {
    const saved = page({ description: "Pick a time." });
    expect(readBookingPageForm(saved, toBookingPageForm(saved))).toEqual({ ok: true, changes: {} });
  });

  it("sends only what changed, trimmed", () => {
    expect(readBookingPageForm(page(), { title: " Book a visit ", description: "  Pick a time.  " })).toEqual({ ok: true, changes: { description: "Pick a time." } });
    expect(readBookingPageForm(page(), { title: "Visit us", description: "" })).toEqual({ ok: true, changes: { title: "Visit us" } });
  });

  it("clears the description with null", () => {
    const saved = page({ description: "Pick a time." });
    expect(readBookingPageForm(saved, { title: saved.title, description: "   " })).toEqual({ ok: true, changes: { description: null } });
  });

  it("refuses an empty title and over-long texts", () => {
    expect(readBookingPageForm(page(), { title: "  ", description: "" })).toMatchObject({ ok: false, errors: { title: expect.any(String) } });
    expect(readBookingPageForm(page(), { title: "x".repeat(201), description: "" })).toMatchObject({ ok: false, errors: { title: expect.any(String) } });
    expect(readBookingPageForm(page(), { title: "Visit", description: "x".repeat(2001) })).toMatchObject({ ok: false, errors: { description: expect.any(String) } });
    expect(readBookingPageForm(page(), { title: "Visit", description: "x".repeat(2000) })).toMatchObject({ ok: true });
  });

  it("points a validation issue at the field", () => {
    expect(pageFieldFromIssuePath("changes.title")).toBe("title");
    expect(pageFieldFromIssuePath("changes.description")).toBe("description");
    expect(pageFieldFromIssuePath("pageId")).toBeNull();
  });
});
