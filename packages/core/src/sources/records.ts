// M3b source records (approvals.md F-1..F-8): where a fact came from and until when it is
// fresh. Runs as the runtime role inside ScopedDatabase.tenant; RLS limits rows to the tenant.
import {
  Conflict,
  type Permission,
  type SourceRecord,
  type SourceSubject,
  type SourceSubjectType,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** F-2: the table each subject lives in and the permission recording or reading it needs. */
export const SOURCE_SUBJECTS: Readonly<Record<SourceSubjectType, { readonly table: string; readonly permission: Permission }>> =
  Object.freeze({
    contact: { table: "crm_contacts", permission: "customers" },
    deal: { table: "crm_deals", permission: "customers" },
    booking: { table: "bookings", permission: "calendar" },
    booking_resource: { table: "booking_resources", permission: "calendar" },
    intake_item: { table: "intake_items", permission: "intake" },
    catalog_item: { table: "catalog_items", permission: "publish" },
    knowledge_entry: { table: "knowledge_entries", permission: "agents" },
  });

export interface SourceRow {
  id: string;
  tenant_id: string;
  subject_type: SourceSubjectType;
  subject_id: string;
  source: string;
  source_ref: string | null;
  observed_at: Date;
  fresh_until: Date | null;
  revision: number;
  recorded_by: string;
  recorded_at: Date;
  updated_at: Date;
}
export const sourceColumns =
  "id,tenant_id,subject_type::text AS subject_type,subject_id,source,source_ref,observed_at,fresh_until,revision,recorded_by,recorded_at,updated_at";

/** F-6: fresh until `fresh_until`, or for good when it is NULL. */
export const isFresh = (row: Pick<SourceRow, "fresh_until">, now: Date) =>
  row.fresh_until === null || now.getTime() < row.fresh_until.getTime();

export function sourceRecord(row: SourceRow, now: Date): SourceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: { type: row.subject_type, id: row.subject_id },
    source: row.source,
    sourceRef: row.source_ref,
    observedAt: row.observed_at.toISOString(),
    freshUntil: row.fresh_until?.toISOString() ?? null,
    fresh: isFresh(row, now),
    revision: row.revision,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Whether the subject exists in the transaction's tenant; RLS hides every other tenant's row. */
export async function subjectExists(tx: Transaction, tenantId: string, subject: SourceSubject): Promise<boolean> {
  const { table } = SOURCE_SUBJECTS[subject.type];
  return (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [tenantId, subject.id])).rowCount === 1;
}

/** F-7: a subject's records, most recently observed first. */
export async function listSourceRecords(tx: Transaction, tenantId: string, subject: SourceSubject, now: Date): Promise<SourceRecord[]> {
  return (await tx.query<SourceRow>(
    `SELECT ${sourceColumns} FROM source_records
      WHERE tenant_id=$1 AND subject_type=$2::source_subject_type AND subject_id=$3
      ORDER BY observed_at DESC, source`,
    [tenantId, subject.type, subject.id],
  )).rows.map((row) => sourceRecord(row, now));
}

/**
 * F-6: the most recently observed fresh record for the subject (from `source` only, when
 * given), or Conflict `stale_source` when there is none. For readers that act on the fact.
 */
export async function requireFresh(
  tx: Transaction,
  tenantId: string,
  subject: SourceSubject,
  now: Date,
  options: { readonly source?: string } = {},
): Promise<SourceRecord> {
  const fresh = (await listSourceRecords(tx, tenantId, subject, now))
    .find((record) => record.fresh && (options.source === undefined || record.source === options.source));
  if (!fresh) throw new Conflict("No fresh source backs this record", { reason: "stale_source" });
  return fresh;
}
