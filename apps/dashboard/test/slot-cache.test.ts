// After a booking, the reopened sheet must not offer the booked time, but only on the calendar
// that took it: another calendar's same time is still free (hub review r1, WARN 2).
import { QueryClient } from "@tanstack/react-query";
import type { BookingRecord, SlotsResponse } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { dropBookedTime, scopeKeys } from "../src/lib/queries";

const keys = scopeKeys(DEMO_TENANT_ID);
const A = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61";
const B = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c62";
const range = { from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z", zone: "America/New_York" };
const slot = (startsAt: string, minutes = 20) => ({
  startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(), localStart: startsAt.slice(0, 19),
});
const open = (resourceId: string): SlotsResponse => ({
  resourceId, timeZone: "America/New_York", zone: "America/New_York",
  slots: [slot("2026-11-01T05:00:00.000Z"), slot("2026-11-01T05:30:00.000Z"), slot("2026-11-01T06:00:00.000Z")],
});
const booked: BookingRecord = {
  id: "b8c2d4e6-1a3f-4b5c-9d7e-000000000099", tenantId: DEMO_TENANT_ID, resourceId: A,
  startsAt: "2026-11-01T05:30:00.000Z", endsAt: "2026-11-01T05:50:00.000Z",
  occupiedStartsAt: "2026-11-01T05:30:00.000Z", occupiedEndsAt: "2026-11-01T06:00:00.000Z",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 10, status: "confirmed", createdAt: "2026-10-31T16:00:00.000Z",
};

describe("dropBookedTime", () => {
  it("removes the booked time from its own calendar's open times only", () => {
    const client = new QueryClient();
    const keyA = keys.slots({ resourceId: A, ...range });
    const keyB = keys.slots({ resourceId: B, ...range });
    client.setQueryData(keyA, open(A));
    client.setQueryData(keyB, open(B));
    const bUpdatedAt = client.getQueryState(keyB)!.dataUpdatedAt;

    dropBookedTime(client, keys.slotsAll, booked);

    // 06:00 starts as the booking's buffer ends, so it stays.
    expect(client.getQueryData<SlotsResponse>(keyA)!.slots.map((item) => item.startsAt))
      .toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z"]);
    expect(client.getQueryData<SlotsResponse>(keyB)).toEqual(open(B));
    expect(client.getQueryState(keyB)!.dataUpdatedAt).toBe(bUpdatedAt);
  });
});
