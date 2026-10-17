import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { bookingResourceSchema, createBookingCommandSchema } from "@zs/contracts";
import { createTwoTenantFixture, withTestDatabase } from "@zs/db/testing";
import { bookingHandlers, createBooking, createDispatcher, crmHandlers, type DispatchContext } from "../../src/index.js";

it("B-27/B-28: creates a booking through the registered handler and runtime database", async () => {
  await withTestDatabase(async (database) => {
    const fixture = await createTwoTenantFixture(database);
    const tenantId = fixture.a.tenantId;
    const resource = bookingResourceSchema.parse({
      tenantId, id: randomUUID(), timeZone: "UTC",
      weekly: [{ weekday: 1, windows: [{ startMinute: 540, endMinute: 1020 }] }],
      overrides: [], slotLengthMinutes: 30, slotStepMinutes: 30,
      bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0, bookingHorizonMinutes: 1440,
    });
    const bookingId = randomUUID();
    const command = createBookingCommandSchema.parse({
      actionType: "booking.create",
      target: { tenantId, type: "booking", id: bookingId },
      payload: { bookingId, resourceId: resource.id, startsAt: "2026-10-19T09:00:00.000Z" },
      approvalReference: { tenantId, id: randomUUID() },
      idempotencyKey: randomUUID(),
    });
    const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers });
    const ctx: DispatchContext = {
      tenantId, actor: { tenantId, id: randomUUID() }, db: database.db,
      clock: { now: () => new Date("2026-10-19T08:00:00.000Z") },
      config: {}, generateId: randomUUID,
      resolveApproval: async () => ({
        tenantId, actorId: ctx.actor.id, actionType: command.actionType,
        target: command.target, payload: command.payload, approvalReference: command.approvalReference,
      }),
    };
    const actual = await createBooking(command, {
      dispatch: async (parsed) => {
        // Defer setup until the wrapper dispatches: this scaffold has no feature tables yet.
        // Real tests seed before dispatch; this deferral exists only for the stub.
        await fixture.service((tx) => tx.query(
          `INSERT INTO booking_resources
            (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
             buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
           VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
          [tenantId, resource.id, resource.timeZone, JSON.stringify(resource.weekly),
            JSON.stringify(resource.overrides), resource.slotLengthMinutes, resource.slotStepMinutes,
            resource.bufferBeforeMinutes, resource.bufferAfterMinutes, resource.minimumNoticeMinutes,
            resource.bookingHorizonMinutes],
        ));
        return dispatch(ctx, parsed);
      },
    });
    expect(actual.result).toMatchObject({ id: bookingId, tenantId, resourceId: resource.id, status: "confirmed" });
    const stored = await fixture.service((tx) => tx.query(
      "SELECT id FROM bookings WHERE tenant_id=$1 AND id=$2", [tenantId, bookingId],
    ));
    expect(stored.rows).toEqual([{ id: bookingId }]);
  });
});
