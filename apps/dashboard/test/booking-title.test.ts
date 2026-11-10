// Appointment titles (demo polish): the service a booking is for, never a bare "Appointment" when
// the calendar has a name.
import { describe, expect, it } from "vitest";
import { bookingTitle } from "../src/lib/resources";

describe("bookingTitle", () => {
  it("keeps a booking's own title", () => {
    expect(bookingTitle({ title: "Ring sizing", source: "owner" }, { name: "Consultation" })).toEqual({ text: "Ring sizing", fromService: false });
  });

  it("names the service from the calendar, singular", () => {
    expect(bookingTitle({ title: null, source: "website" }, { name: "Free intro session" })).toEqual({ text: "Free intro session", fromService: true });
    expect(bookingTitle({ source: "owner" }, { name: "Showroom appointments" })).toEqual({ text: "Showroom appointment", fromService: true });
  });

  it("falls back to the generic words only without a named calendar", () => {
    expect(bookingTitle({ title: "  ", source: "website" }, { name: null })).toEqual({ text: "Website booking", fromService: false });
    expect(bookingTitle({ source: "owner" }, undefined)).toEqual({ text: "Appointment", fromService: false });
  });
});
