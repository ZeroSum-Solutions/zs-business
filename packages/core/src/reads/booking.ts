// M1 tenant-scoped booking reads. Every function runs inside ScopedDatabase.tenant, so RLS
// limits rows to the caller's tenant; the explicit tenant_id filter is defence in depth.
import {
  NotFound,
  type BookingPage,
  type BookingRecord,
  type ListBookingsQuery,
  type ResourceSummary,
  type SlotsQuery,
  type SlotsResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { loadBusy, loadResource } from "../booking/create.js";
import { compileRules, evaluateSlots } from "../booking/slots.js";
import { MINUTE_MS, offsetAt } from "../booking/time-zone.js";
import { page } from "./page.js";

interface BookingRow {
  id: string;
  tenant_id: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  occupied_starts_at: Date;
  occupied_ends_at: Date;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  created_at: Date;
}

const bookingRecord = (row: BookingRow): BookingRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  resourceId: row.resource_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  occupiedStartsAt: row.occupied_starts_at.toISOString(),
  occupiedEndsAt: row.occupied_ends_at.toISOString(),
  bufferBeforeMinutes: row.buffer_before_minutes,
  bufferAfterMinutes: row.buffer_after_minutes,
  status: "confirmed",
  createdAt: row.created_at.toISOString(),
});

export async function listBookings(tx: Transaction, tenantId: string, query: ListBookingsQuery): Promise<BookingPage> {
  const rows = (await tx.query<BookingRow>(
    `SELECT id, tenant_id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
            buffer_before_minutes, buffer_after_minutes, created_at
       FROM bookings WHERE tenant_id=$1 AND ($2::uuid IS NULL OR resource_id=$2)
      ORDER BY starts_at, id LIMIT $3 OFFSET $4`,
    [tenantId, query.resourceId ?? null, query.limit + 1, query.offset],
  )).rows;
  return page(rows.map(bookingRecord), query);
}

export async function listResources(tx: Transaction, tenantId: string): Promise<ResourceSummary[]> {
  const rows = (await tx.query<{ id: string; name: string | null; time_zone: string; slot_length_minutes: number }>(
    `SELECT id, name, time_zone, slot_length_minutes FROM booking_resources
      WHERE tenant_id=$1 ORDER BY name NULLS LAST, id`,
    [tenantId],
  )).rows;
  return rows.map((row) => ({
    id: row.id, name: row.name, timeZone: row.time_zone, slotLengthMinutes: row.slot_length_minutes,
  }));
}

/** Wall-clock label of an instant in a zone, ISO 8601 without an offset. */
export function localLabel(zone: string, instant: number): string {
  return new Date(instant + offsetAt(zone, instant)).toISOString().slice(0, 19);
}

/** Available slots for one owned resource, against committed bookings and external blocks. */
export async function findSlots(tx: Transaction, tenantId: string, query: SlotsQuery, now: Date): Promise<SlotsResponse> {
  const owned = await tx.query("SELECT 1 FROM booking_resources WHERE tenant_id=$1 AND id=$2", [tenantId, query.resourceId]);
  if (!owned.rowCount) throw new NotFound("Booking resource not found");
  const rules = compileRules(await loadResource(tx, tenantId, query.resourceId));
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  // A slot in [from,to) conflicts with anything overlapping it widened by the resource buffers.
  const busy = await loadBusy(tx, tenantId, query.resourceId,
    from - rules.bufferBeforeMinutes * MINUTE_MS, to + rules.bufferAfterMinutes * MINUTE_MS);
  const length = rules.slotLengthMinutes * MINUTE_MS;
  const zone = query.zone ?? rules.timeZone;
  return {
    resourceId: query.resourceId,
    timeZone: rules.timeZone,
    zone,
    slots: evaluateSlots(rules, from, to, busy, now.getTime()).map((start) => ({
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + length).toISOString(),
      localStart: localLabel(zone, start),
    })),
  };
}
