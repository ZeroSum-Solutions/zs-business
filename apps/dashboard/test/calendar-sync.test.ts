// What the Connections page shows per booking calendar, and what Google's return said
// (google-calendar.md G-2, G-4).
import { describe, expect, it } from "vitest";
import type { CalendarConnection } from "@zs/contracts";
import { ApiError } from "../src/lib/api/errors";
import {
  busyTimesChanged,
  CANCELLED_MESSAGE,
  CONFIRM_EXPIRED_MESSAGE,
  confirmErrorNotice,
  connectErrorMessage,
  GRANT_CHANGED_MESSAGE,
  CONNECTED_MESSAGE,
  currentConnection,
  disconnectingStatus,
  GOOGLE_ACCESS_URL,
  RETURN_REASONS,
  returnNotice,
} from "../src/lib/calendar-sync";

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

  it("says nothing on a confirm return: the waiting grant is what the page asks about", () => {
    expect(returnNotice("confirm", null)).toBeNull();
    expect(returnNotice("confirm", "denied")).toBeNull();
  });
});

describe("confirmErrorNotice", () => {
  it("explains each answer the server gave for good, in plain words", () => {
    expect(confirmErrorNotice(new ApiError("not_found", "x", 404))).toEqual({ tone: "error", message: CONFIRM_EXPIRED_MESSAGE });
    expect(CONFIRM_EXPIRED_MESSAGE).toBe("That connection request expired. Connect again.");
    expect(confirmErrorNotice(new ApiError("conflict", "x", 409, "Conflict", { reason: "conflict" }))).toEqual({ tone: "error", message: RETURN_REASONS.conflict });
    expect(confirmErrorNotice(new ApiError("forbidden", "x", 403))).toEqual({ tone: "error", message: RETURN_REASONS.forbidden });
    expect(confirmErrorNotice(new ApiError("conflict", "x", 409, "Conflict", { reason: "grant_changed" }))).toEqual({ tone: "error", message: GRANT_CHANGED_MESSAGE });
    expect(confirmErrorNotice(new ApiError("validation", "Some details need another look.", 400))).toEqual({ tone: "error", message: "Some details need another look." });
  });

  it("leaves a lost answer to the panel, where the owner can try again", () => {
    expect(confirmErrorNotice(new ApiError("network", "You look offline."))).toBeNull();
    expect(confirmErrorNotice(new ApiError("server", "x", 503))).toBeNull();
    expect(confirmErrorNotice(new ApiError("invalid_response", "x", 200))).toBeNull();
    expect(confirmErrorNotice(new Error("boom"))).toBeNull();
    expect(CANCELLED_MESSAGE).toBe("Nothing was connected.");
  });
});

describe("busyTimesChanged", () => {
  it("is true when a sync lands, a status moves or a row leaves the list", () => {
    const active = row("active", "2026-10-01T00:00:00.000Z");
    const synced = { ...active, lastSyncedAt: "2026-10-20T12:00:00.000Z" };
    expect(busyTimesChanged([active], [synced])).toBe(true);
    expect(busyTimesChanged([synced], [{ ...synced, status: "disconnecting" }])).toBe(true);
    expect(busyTimesChanged([{ ...synced, status: "disconnecting" }], [{ ...synced, status: "disconnected" }])).toBe(true);
    expect(busyTimesChanged([synced], [])).toBe(true);
    // A connection first seen already synced (the first sync landed between two reads).
    expect(busyTimesChanged([], [synced])).toBe(true);
    expect(busyTimesChanged([active], [active, { ...synced, id: OTHER }])).toBe(true);
  });

  it("is false when nothing that blocks slots changed, or a new connection has not synced yet", () => {
    const synced = { ...row("active", "2026-10-01T00:00:00.000Z"), lastSyncedAt: "2026-10-20T12:00:00.000Z" };
    expect(busyTimesChanged([synced], [{ ...synced }])).toBe(false);
    expect(busyTimesChanged([synced], [row("active", "2026-10-02T00:00:00.000Z", OTHER), synced])).toBe(false);
    expect(busyTimesChanged([], [row("active", "2026-10-02T00:00:00.000Z", OTHER)])).toBe(false);
  });
});

describe("connectErrorMessage", () => {
  it("names a server without Google settings and a member who is not an owner", () => {
    expect(connectErrorMessage(new ApiError("not_found", "x", 404))).toBe("Google Calendar is not set up on this server yet.");
    expect(connectErrorMessage(new ApiError("forbidden", "x", 403))).toBe("Only an owner can connect calendars.");
    expect(connectErrorMessage(new ApiError("network", "You look offline."))).toBe("You look offline.");
  });
});

describe("disconnectingStatus (G-9)", () => {
  it("says the busy times are going while nothing failed", () => {
    expect(disconnectingStatus(null)).toEqual({ message: "Removing its busy times. Events already added stay in Google.", stuck: false });
  });

  it("after a failed try, says the busy times stay until Google ends the grant, and offers Google's access page", () => {
    for (const code of ["google_403", "google_network", "run_deadline", "token_unreadable"]) {
      const status = disconnectingStatus(code);
      expect(status.stuck, code).toBe(true);
      expect(status.message, code).toMatch(/still block slots/);
      expect(status.message, code).not.toMatch(/Removing/);
      expect(status.message, code).toMatch(/^[A-Z].*\.$/);
    }
    expect(disconnectingStatus("token_unreadable").message).toMatch(/could not read the saved Google access/);
    expect(disconnectingStatus("google_403").message).toMatch(/Google has not confirmed the disconnect/);
    expect(new URL(GOOGLE_ACCESS_URL).origin).toBe("https://myaccount.google.com");
  });
});
