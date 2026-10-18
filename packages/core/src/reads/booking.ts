// M1 tenant-scoped booking reads. Every function runs inside ScopedDatabase.tenant, so RLS
// limits rows to the caller's tenant; the explicit tenant_id filter is defence in depth.
import {
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

export async function listBookings(tx: Transaction, tenantId: string, query: ListBookingsQuery): Promise<BookingPage> {
  const rows = (await tx.query<SummaryRow>(
    `SELECT b.id, b.tenant_id, b.resource_id, b.starts_at, b.ends_at, b.occupied_starts_at, b.occupied_ends_at,
            b.buffer_before_minutes, b.buffer_after_minutes, b.created_at, b.source, b.intake_item_id,
            i.status AS intake_status, i.contact_id AS customer_contact_id,
            coalesce(c.display_name, i.submitted_name) AS customer_name
       FROM bookings b
       LEFT JOIN intake_items i ON i.tenant_id = b.tenant_id AND i.id = b.intake_item_id
       LEFT JOIN crm_contacts c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
      WHERE b.tenant_id=$1 AND ($2::uuid IS NULL OR b.resource_id=$2)
      ORDER BY b.starts_at, b.id LIMIT $3 OFFSET $4`,
    [tenantId, query.resourceId ?? null, query.limit + 1, query.offset],
  )).rows;
  return page(rows.map(bookingSummary), query);
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
