// M3a tenant-scoped intake reads (public-intake.md P-11, P-12). They run inside
// ScopedDatabase.tenant, so RLS limits rows to the tenant; the tenant_id filters are defence in depth.
import type {
  IntakeConsentRecord,
  IntakeItemPage,
  IntakeItemRecord,
  ListIntakeItemsQuery,
  PublicPage,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { page } from "./page.js";

interface IntakeRow {
  id: string;
  tenant_id: string;
  status: IntakeItemRecord["status"];
  channel: IntakeItemRecord["channel"];
  page_id: string;
  submitted_name: string;
  submitted_email: string;
  submitted_phone: string | null;
  notes: string | null;
  matched_contact_ids: string[];
  contact_id: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  booking_id: string | null;
  booking_resource_id: string | null;
  booking_starts_at: Date | null;
  booking_ends_at: Date | null;
}
interface IntakeConsentRow {
  intake_item_id: string;
  channel: "email" | "sms";
  status: "granted" | "denied";
  purpose: string;
  disclosure_version: string;
  source: string;
  recorded_at: Date;
}

const ITEM_SELECT = `
  SELECT i.id, i.tenant_id, i.status, i.channel, i.page_id, i.submitted_name, i.submitted_email,
         i.submitted_phone, i.notes, i.matched_contact_ids::text[] AS matched_contact_ids, i.contact_id,
         i.reviewed_at, i.created_at,
         b.id AS booking_id, b.resource_id AS booking_resource_id,
         b.starts_at AS booking_starts_at, b.ends_at AS booking_ends_at
    FROM intake_items i
    LEFT JOIN bookings b ON b.tenant_id = i.tenant_id AND b.intake_item_id = i.id`;

async function consentFor(tx: Transaction, tenantId: string, ids: readonly string[]) {
  const rows = (await tx.query<IntakeConsentRow>(
    `SELECT intake_item_id, channel::text AS channel, status::text AS status, purpose, disclosure_version, source, recorded_at
       FROM intake_item_consent WHERE tenant_id=$1 AND intake_item_id = ANY($2::uuid[])`,
    [tenantId, ids],
  )).rows;
  const byItem = new Map<string, Map<string, IntakeConsentRecord>>();
  for (const row of rows) {
    const channels = byItem.get(row.intake_item_id) ?? new Map<string, IntakeConsentRecord>();
    channels.set(row.channel, {
      status: row.status,
      purpose: row.purpose,
      disclosureVersion: row.disclosure_version,
      source: row.source,
      recordedAt: row.recorded_at.toISOString(),
    });
    byItem.set(row.intake_item_id, channels);
  }
  return byItem;
}

function itemRecord(row: IntakeRow, consent: Map<string, IntakeConsentRecord> | undefined): IntakeItemRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: "booking_request",
    status: row.status,
    channel: row.channel,
    pageId: row.page_id,
    submitted: { name: row.submitted_name, email: row.submitted_email, phone: row.submitted_phone, notes: row.notes },
    matchedContactIds: [...row.matched_contact_ids],
    contactId: row.contact_id,
    consent: { email: consent?.get("email") ?? null, sms: consent?.get("sms") ?? null },
    booking: row.booking_id && row.booking_resource_id && row.booking_starts_at && row.booking_ends_at
      ? {
        id: row.booking_id,
        resourceId: row.booking_resource_id,
        startsAt: row.booking_starts_at.toISOString(),
        endsAt: row.booking_ends_at.toISOString(),
      }
      : null,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function loadIntakeItem(tx: Transaction, tenantId: string, id: string): Promise<IntakeItemRecord | null> {
  const row = (await tx.query<IntakeRow>(`${ITEM_SELECT} WHERE i.tenant_id=$1 AND i.id=$2`, [tenantId, id])).rows[0];
  if (!row) return null;
  return itemRecord(row, (await consentFor(tx, tenantId, [row.id])).get(row.id));
}

export async function listIntakeItems(tx: Transaction, tenantId: string, query: ListIntakeItemsQuery): Promise<IntakeItemPage> {
  const rows = (await tx.query<IntakeRow>(
    `${ITEM_SELECT} WHERE i.tenant_id=$1 AND ($2::text IS NULL OR i.status=$2)
      ORDER BY i.created_at DESC, i.id LIMIT $3 OFFSET $4`,
    [tenantId, query.status ?? null, query.limit + 1, query.offset],
  )).rows;
  const consent = await consentFor(tx, tenantId, rows.map((row) => row.id));
  return page(rows.map((row) => itemRecord(row, consent.get(row.id))), query);
}

export interface PublishedPageRow {
  id: string;
  title: string;
  description: string | null;
  disclosure_version: string;
  disclosure_text: string;
  business_name: string;
}

/** A page visitors may use (P-4): it exists in this tenant and is published. */
export async function loadPublishedPage(tx: Transaction, tenantId: string, pageId: string): Promise<PublishedPageRow | null> {
  return (await tx.query<PublishedPageRow>(
    `SELECT p.id, p.title, p.description, p.disclosure_version, p.disclosure_text, t.name AS business_name
       FROM booking_pages p JOIN tenants t ON t.tenant_id = p.tenant_id
      WHERE p.tenant_id=$1 AND p.id=$2 AND p.published`,
    [tenantId, pageId],
  )).rows[0] ?? null;
}

export async function pageHasResource(tx: Transaction, tenantId: string, pageId: string, resourceId: string): Promise<boolean> {
  return (await tx.query(
    "SELECT 1 FROM booking_page_resources WHERE tenant_id=$1 AND page_id=$2 AND resource_id=$3",
    [tenantId, pageId, resourceId],
  )).rowCount === 1;
}

export async function publicPage(tx: Transaction, tenantId: string, row: PublishedPageRow): Promise<PublicPage> {
  const resources = (await tx.query<{ id: string; name: string | null; time_zone: string; slot_length_minutes: number }>(
    `SELECT r.id, r.name, r.time_zone, r.slot_length_minutes
       FROM booking_page_resources pr
       JOIN booking_resources r ON r.tenant_id = pr.tenant_id AND r.id = pr.resource_id
      WHERE pr.tenant_id=$1 AND pr.page_id=$2 ORDER BY pr.position, r.name NULLS LAST, r.id`,
    [tenantId, row.id],
  )).rows;
  return {
    businessName: row.business_name,
    title: row.title,
    description: row.description,
    resources: resources.map((resource) => ({
      id: resource.id, name: resource.name, timeZone: resource.time_zone, slotLengthMinutes: resource.slot_length_minutes,
    })),
    disclosure: { version: row.disclosure_version, text: row.disclosure_text },
  };
}

export interface BookingPageRow {
  id: string;
  title: string;
  published: boolean;
  disclosureVersion: string;
  resourceIds: string[];
}

export async function listBookingPages(tx: Transaction, tenantId: string): Promise<BookingPageRow[]> {
  const rows = (await tx.query<{ id: string; title: string; published: boolean; disclosure_version: string; resource_ids: string[] }>(
    `SELECT p.id, p.title, p.published, p.disclosure_version,
            coalesce(array_agg(pr.resource_id::text ORDER BY pr.position, pr.resource_id)
              FILTER (WHERE pr.resource_id IS NOT NULL), '{}') AS resource_ids
       FROM booking_pages p
       LEFT JOIN booking_page_resources pr ON pr.tenant_id = p.tenant_id AND pr.page_id = p.id
      WHERE p.tenant_id=$1 GROUP BY p.id, p.title, p.published, p.disclosure_version, p.created_at
      ORDER BY p.created_at, p.id`,
    [tenantId],
  )).rows;
  return rows.map((row) => ({
    id: row.id, title: row.title, published: row.published,
    disclosureVersion: row.disclosure_version, resourceIds: row.resource_ids,
  }));
}
