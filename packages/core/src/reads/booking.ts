// M1 tenant-scoped booking reads. Every function runs inside ScopedDatabase.tenant, so RLS
// limits rows to the caller's tenant; the explicit tenant_id filter is defence in depth.
import {
  ValidationFailed,
  type BookingPage,
  type BookingRecord,
  type BookingSummary,
  type IntakeStatus,
  type ListBookingsQuery,
  type ResourceSummary,
  type SlotsQuery,
  type SlotsResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { isSupportedInstant, loadBusy, loadResource } from "../booking/create.js";
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
interface SummaryRow extends BookingRow {
  source: "owner" | "website";
  intake_item_id: string | null;
  intake_status: IntakeStatus;
  customer_contact_id: string | null;
  customer_name: string | null;
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

/** P-12: a website booking names its intake item; the customer is the contact once known. */
const bookingSummary = (row: SummaryRow): BookingSummary => ({
  ...bookingRecord(row),
  source: row.source,
  intakeItemId: row.intake_item_id,
  customer: row.intake_item_id === null
    ? null
    : { contactId: row.customer_contact_id, name: row.customer_name, status: row.intake_status },
});

const bookingColumns = `id, tenant_id, resource_id, starts_at, ends_at, occupied_starts_at, occupied_ends_at,
            buffer_before_minutes, buffer_after_minutes, created_at, source, intake_item_id`;

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
  type Row = SummaryRow & { sort_value: string };
  const toPage = (rows: Row[]) =>
    page(rows.map(bookingSummary), query, (index) => encodeCursor("bookings.start", [rows[index]!.sort_value, rows[index]!.id]));
  // P-12: name each page's website customers after the page is chosen, so the join never
  // changes which bookings are on it.
  const withCustomers = (hits: string) => `SELECT b.*, i.status AS intake_status, i.contact_id AS customer_contact_id,
          coalesce(c.display_name, i.submitted_name) AS customer_name
     FROM (${hits}) b
     LEFT JOIN intake_items i ON i.tenant_id = b.tenant_id AND i.id = b.intake_item_id
     LEFT JOIN crm_contacts c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
    ORDER BY b.starts_at, b.id`;
  if (query.from === undefined) {
    // $5 is the end of the range, so the cursor's parameters follow it.
    const rows = (await tx.query<Row>(
      withCustomers(`SELECT ${columns} FROM bookings
        WHERE tenant_id=$1 AND ($2::uuid IS NULL OR resource_id=$2) AND ($5::timestamptz IS NULL OR starts_at < $5)
          ${position("$6", "$7")}
        ORDER BY starts_at, id LIMIT $3 OFFSET $4`),
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
  const rows = (await tx.query<Row>(withCustomers(sql), [...scope, query.from, query.to ?? null, ...cursorParams])).rows;
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
  // The widened bounds must be valid instants too, or Postgres rejects them with a raw SQLSTATE.
  const busyFrom = from - rules.bufferBeforeMinutes * MINUTE_MS;
  const busyTo = to + rules.bufferAfterMinutes * MINUTE_MS;
  if (!isSupportedInstant(busyFrom) || !isSupportedInstant(busyTo))
    throw new ValidationFailed("Slot range widened by the resource buffers leaves the supported instant range");
  const busy = await loadBusy(tx, tenantId, query.resourceId, busyFrom, busyTo);
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
