// What the Connections page shows per booking calendar, and what Google's return said
// (google-calendar.md G-2, G-4).
import { describe, expect, it } from "vitest";
import type { CalendarConnection } from "@zs/contracts";
import { ApiError } from "../src/lib/api/errors";
import { connectErrorMessage, CONNECTED_MESSAGE, currentConnection, RETURN_REASONS, returnNotice } from "../src/lib/calendar-sync";

const RESOURCE = "3c1e5a7b-9d2f-4e6a-8b1c-000000000001";
const OTHER = "3c1e5a7b-9d2f-4e6a-8b1c-000000000002";

let ids = 0;
const row = (status: CalendarConnection["status"], createdAt: string, resourceId = RESOURCE): CalendarConnection => ({
  id: `b7d9f1a3-5c7e-4a9b-8d1f-${String(++ids).padStart(12, "0")}`, provider: "google", resourceId, calendarId: "primary",
  accountEmail: "owner@haldenrowe.example", status, lastSyncedAt: null, lastError: null, createdAt,
});

describe("currentConnection", () => {
  it("prefers the active or reauthorize row over newer history", () => {
    const live = row("reauthorize", "2026-10-01T00:00:00.000Z");
    const items = [row("disconnecting", "2026-10-02T00:00:00.000Z"), live, row("disconnected", "2026-10-03T00:00:00.000Z")];
    expect(currentConnection(items, RESOURCE)).toBe(live);
  });

  it("falls back to the newest disconnecting row, and reads only disconnected rows as not connected", () => {
    const newer = row("disconnecting", "2026-10-02T00:00:00.000Z");
    expect(currentConnection([row("disconnecting", "2026-10-01T00:00:00.000Z"), newer], RESOURCE)).toBe(newer);
    expect(currentConnection([row("disconnected", "2026-10-03T00:00:00.000Z")], RESOURCE)).toBeNull();
    expect(currentConnection([row("active", "2026-10-03T00:00:00.000Z", OTHER)], RESOURCE)).toBeNull();
  });
});

describe("returnNotice", () => {
  it("says connected as a success, and each callback reason as an error in plain words", () => {
    expect(returnNotice("connected", null)).toEqual({ tone: "success", message: CONNECTED_MESSAGE });
    expect(returnNotice("error", "browser_mismatch")).toEqual({
      tone: "error", message: "Finish connecting in the same browser you started in. Try again from this page.",
    });
    expect(returnNotice("error", "denied")?.message).toBe("Google access was not allowed. Nothing changed.");
    for (const reason of ["denied", "exchange_failed", "no_refresh_token", "scope_missing", "forbidden", "conflict", "browser_mismatch", "invalid_state", "unavailable"]) {
      expect(RETURN_REASONS[reason], reason).toMatch(/^[A-Z].*\.$/);
    }
    expect(returnNotice("error", "something_new")).toMatchObject({ tone: "error", message: expect.stringMatching(/could not be connected/) });
    expect(returnNotice("error", "toString")).toMatchObject({ tone: "error", message: expect.stringMatching(/could not be connected/) });
    expect(returnNotice(null, null)).toBeNull();
    expect(returnNotice("maybe", null)).toBeNull();
  });
});

describe("connectErrorMessage", () => {
  it("names a server without Google settings and a member who is not an owner", () => {
    expect(connectErrorMessage(new ApiError("not_found", "x", 404))).toBe("Google Calendar is not set up on this server yet.");
    expect(connectErrorMessage(new ApiError("forbidden", "x", 403))).toBe("Only an owner can connect calendars.");
    expect(connectErrorMessage(new ApiError("network", "You look offline."))).toBe("You look offline.");
  });
});
