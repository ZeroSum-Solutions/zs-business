// The demo adapter keeps the API's outcome rules (booking.md B-37..B-46): a started booking is marked
// completed or no_show, a mark can be replaced, the same mark again changes nothing, a booking that has not
// started or is cancelled is refused, a cancel clears the mark, and an unknown booking is 404.
import { describe, expect, it } from "vitest";
import { setBookingOutcomeResultSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";

const NOW = new Date("2026-10-18T13:00:00.000Z");
// Seeded: one booking that started on 2026-10-15 and one that starts on 2026-10-19.
const STARTED = "b8c2d4e6-1a3f-4b5c-9d7e-000000000010";
const UPCOMING = "b8c2d4e6-1a3f-4b5c-9d7e-000000000004";
const MISSING = "0b0b0b0b-1c1c-4d2d-8e3e-4f4f4f4f4f4f";

// The seed is built from the clock's week once, so tests move time with `clock.at` after the adapter exists.
function adapter() {
  let ids = 0;
  const clock = { at: NOW };
  const api = createDemoAdapter({
    clock: { now: () => clock.at },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return Object.assign(api, { clock });
}
let keys = 0;
const key = () => ({ idempotencyKey: `outcome-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const outcomeOf = async (api: ReturnType<typeof adapter>, id: string) =>
  (await api.listBookings({ status: "all" })).items.find((item) => item.id === id)?.outcome;

describe("demo adapter: marking a booking's outcome", () => {
  it("shows no mark until the owner sets one, then shows it on the list and the detail (B-37, B-38)", async () => {
    const api = adapter();
    expect(await outcomeOf(api, STARTED)).toBeNull();
    expect((await api.getBooking(STARTED)).outcome).toBeNull();
    const done = setBookingOutcomeResultSchema.parse(await api.setBookingOutcome({ bookingId: STARTED, outcome: "completed" }, key()));
    expect(done).toMatchObject({ booking: { id: STARTED, status: "confirmed" }, outcome: "completed", changed: true });
    expect(await outcomeOf(api, STARTED)).toBe("completed");
    expect(await api.getBooking(STARTED)).toMatchObject({ outcome: "completed", outcomeAt: done.outcomeAt });
  });

  it("replaces a mark with the other one, and the same mark again changes nothing (B-39)", async () => {
    const api = adapter();
    const first = await api.setBookingOutcome({ bookingId: STARTED, outcome: "completed" }, key());
    const same = await api.setBookingOutcome({ bookingId: STARTED, outcome: "completed" }, key());
    expect(same).toMatchObject({ outcome: "completed", changed: false, outcomeAt: first.outcomeAt });
    const swapped = await api.setBookingOutcome({ bookingId: STARTED, outcome: "no_show" }, key());
    expect(swapped).toMatchObject({ outcome: "no_show", changed: true });
    expect(await outcomeOf(api, STARTED)).toBe("no_show");
  });

  it("replays one key and refuses the same key for another mark (B-29 idempotency)", async () => {
    const api = adapter();
    const same = key();
    const first = await api.setBookingOutcome({ bookingId: STARTED, outcome: "no_show" }, same);
    expect(await api.setBookingOutcome({ bookingId: STARTED, outcome: "no_show" }, same)).toEqual(first);
    expect(await failure(api.setBookingOutcome({ bookingId: STARTED, outcome: "completed" }, same)))
      .toMatchObject({ kind: "conflict", details: { reason: "idempotency_key_reused" } });
    expect(await outcomeOf(api, STARTED)).toBe("no_show");
  });

  it("refuses a booking that has not started, by the injected clock (B-39)", async () => {
    const api = adapter();
    expect(await failure(api.setBookingOutcome({ bookingId: UPCOMING, outcome: "completed" }, key())))
      .toMatchObject({ kind: "conflict", details: { reason: "booking_not_started" } });
    expect(await outcomeOf(api, UPCOMING)).toBeNull();
    // Once the clock reaches the start, the same booking can be marked.
    api.clock.at = new Date("2026-10-19T14:30:00.000Z");
    expect(await api.setBookingOutcome({ bookingId: UPCOMING, outcome: "completed" }, key())).toMatchObject({ changed: true });
  });

  it("refuses a cancelled booking, and a cancel clears an earlier mark (B-39, B-41)", async () => {
    const api = adapter();
    api.clock.at = new Date("2026-10-19T14:45:00.000Z");
    expect(await api.setBookingOutcome({ bookingId: UPCOMING, outcome: "no_show" }, key())).toMatchObject({ outcome: "no_show" });
    await api.cancelBooking({ bookingId: UPCOMING, notifyCustomer: false }, key());
    expect(await outcomeOf(api, UPCOMING)).toBeNull();
    expect(await api.getBooking(UPCOMING)).toMatchObject({ status: "cancelled", outcome: null });
    expect(await failure(api.setBookingOutcome({ bookingId: UPCOMING, outcome: "completed" }, key())))
      .toMatchObject({ kind: "conflict", details: { reason: "booking_cancelled" } });
  });

  it("rejects a bad body and answers 404 for an unknown booking", async () => {
    const api = adapter();
    expect(await failure(api.setBookingOutcome({ bookingId: STARTED, outcome: "unknown" as never }, key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.setBookingOutcome({ bookingId: "not-an-id", outcome: "completed" }, key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.setBookingOutcome({ bookingId: MISSING, outcome: "completed" }, key()))).toMatchObject({ kind: "not_found" });
  });

  it("accepts an upper-case booking ID", async () => {
    const api = adapter();
    expect(await api.setBookingOutcome({ bookingId: STARTED.toUpperCase(), outcome: "completed" }, key())).toMatchObject({ changed: true });
    expect(await outcomeOf(api, STARTED)).toBe("completed");
  });
});
