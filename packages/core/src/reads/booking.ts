// M1 tenant-scoped booking reads. Every function runs inside ScopedDatabase.tenant, so RLS
// limits rows to the caller's tenant; the explicit tenant_id filter is defence in depth.
import {
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
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "./cursor.js";
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

const bookingColumns = `id, tenant_id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
            buffer_before_minutes, buffer_after_minutes, created_at`;

/**
 * Bookings overlapping [from, to) when given, in start order, so a day or week is one short
 * read however much history comes before it. A cursor continues after the last booking of
 * the page before.
 *
 * Under RLS the planner only turns leakproof operators into index conditions, and range
 * overlap (`&&`) is not one, so the overlap test is split into btree ranges on starts_at:
 * the bookings starting inside the range, plus, per resource, the latest one starting before
 * `from` if it is still running. The occupied-range exclusion constraint keeps one resource's
 * bookings apart, so no earlier booking can still be running at `from`. If cancelled bookings
 * ever stop taking part in that constraint, both parts must filter to confirmed ones.
 */
export async function listBookings(tx: Transaction, tenantId: string, query: ListBookingsQuery): Promise<BookingPage> {
  const cursor = decodeCursor("bookings.start", query);
  // `start`/`id` name the cursor's parameters; `alias` qualifies the columns inside a join.
  const position = (start: string, id: string, alias = "") => cursor
    ? `AND (${alias}starts_at > ${microsToTimestamp(start)} OR (${alias}starts_at = ${microsToTimestamp(start)} AND ${alias}id > ${id}::uuid))`
    : "";
  const columns = `${bookingColumns}, ${timestampToMicros("starts_at")} AS sort_value`;
  const scope = [tenantId, query.resourceId ?? null, query.limit + 1, query.offset];
  const cursorParams = cursor ? [...cursor] : [];
  const toPage = (rows: (BookingRow & { sort_value: string })[]) =>
    page(rows.map(bookingRecord), query, (index) => encodeCursor("bookings.start", [rows[index]!.sort_value, rows[index]!.id]));
  if (query.from === undefined) {
    // $5 is the end of the range, so the cursor's parameters follow it.
    const rows = (await tx.query<BookingRow & { sort_value: string }>(
      `SELECT ${columns} FROM bookings
        WHERE tenant_id=$1 AND ($2::uuid IS NULL OR resource_id=$2) AND ($5::timestamptz IS NULL OR starts_at < $5)
          ${position("$6", "$7")}
        ORDER BY starts_at, id LIMIT $3 OFFSET $4`,
      [...scope, query.to ?? null, ...cursorParams],
    )).rows;
    return toPage(rows);
  }
  // With a range, $5/$6 are its bounds, so the cursor's parameters are $7/$8.
  const sql = `SELECT ${columns} FROM (
          SELECT running.* FROM booking_resources r
          CROSS JOIN LATERAL (
            SELECT ${bookingColumns} FROM bookings b
             WHERE b.tenant_id=r.tenant_id AND b.resource_id=r.id AND b.starts_at < $5::timestamptz
             ORDER BY b.starts_at DESC LIMIT 1) running
           WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.id=$2) AND running.ends_at > $5::timestamptz
             ${position("$7", "$8", "running.")}
          UNION ALL
          SELECT ${bookingColumns} FROM bookings
           WHERE tenant_id=$1 AND ($2::uuid IS NULL OR resource_id=$2)
             AND starts_at >= $5::timestamptz AND ($6::timestamptz IS NULL OR starts_at < $6)
             ${position("$7", "$8")}
           ORDER BY starts_at, id LIMIT $3::int + $4::int
        ) hits
        ORDER BY starts_at, id LIMIT $3 OFFSET $4`;
  const rows = (await tx.query<BookingRow & { sort_value: string }>(sql, [...scope, query.from, query.to ?? null, ...cursorParams])).rows;
  return toPage(rows);
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

/**
 * Available slots for one owned resource, against committed bookings and external blocks.
 * A foreign or unknown resource is TenantDenied (403), exactly as booking it is, so neither
 * endpoint reveals whether another tenant's resource exists.
 */
export async function findSlots(tx: Transaction, tenantId: string, query: SlotsQuery, now: Date): Promise<SlotsResponse> {
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
