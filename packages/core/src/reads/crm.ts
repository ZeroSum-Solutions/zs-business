// M1 tenant-scoped CRM reads. They run inside ScopedDatabase.tenant (RLS) and reuse the
// row mappers the write handlers use, so reads and writes return identical records.
import {
  NotFound,
  type ContactPage,
  type ContactRecord,
  type DealPage,
  type ListContactsQuery,
  type ListDealsQuery,
  type PipelineSummary,
  type StageOutcome,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import {
  contactColumns,
  contactRecord,
  type ConsentRow,
  type ContactRow,
} from "../crm/rows.js";
import { dealSummary, dealSummaryColumns, type DealSummaryRow } from "../deals/details.js";
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros, type CursorKind } from "./cursor.js";
import { page } from "./page.js";

/** `%`, `_` and the escape character itself match literally inside the search text. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

async function withConsent(tx: Transaction, tenantId: string, rows: readonly ContactRow[]): Promise<ContactRecord[]> {
  if (rows.length === 0) return [];
  const consent = (await tx.query<ConsentRow & { contact_id: string }>(
    `SELECT contact_id, channel::text AS channel, status::text AS status, source, recorded_at,
       ((extract(epoch FROM recorded_at) * 1000000)::numeric(30,0))::text AS recorded_us
     FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id = ANY($2::uuid[])`,
    [tenantId, rows.map((row) => row.id)],
  )).rows;
  const byContact = new Map<string, Map<string, ConsentRow>>();
  for (const row of consent) {
    const channels = byContact.get(row.contact_id) ?? new Map<string, ConsentRow>();
    channels.set(row.channel, row);
    byContact.set(row.contact_id, channels);
  }
  return rows.map((row) => contactRecord(row, byContact.get(row.id) ?? new Map()));
}

/** The same expression the index `crm_contacts_tenant_name` holds. */
const CONTACT_NAME_KEY = "lower(coalesce(display_name, normalized_email, e164_phone))";

/**
 * Rows after a cursor in `value DESC, id` order (`direction` "desc") or `value, id` order,
 * spelled out rather than as a row comparison because the two columns can sort in different
 * directions. `value` is the sort column's SQL; `v` and `id` are the cursor's parameters.
 */
const after = (value: string, direction: "asc" | "desc", v: string, id: string) =>
  `(${value} ${direction === "desc" ? "<" : ">"} ${v} OR (${value} = ${v} AND id > ${id}::uuid))`;

/**
 * Contacts, filtered in SQL so a search or an ID list pages through matches only. A cursor
 * continues right after the last contact of the page before.
 */
export async function listContacts(tx: Transaction, tenantId: string, query: ListContactsQuery): Promise<ContactPage> {
  const search = query.search ? likePattern(query.search) : null;
  const ids = query.ids ? query.ids.toLowerCase().split(",") : null;
  const kind: CursorKind = query.sort === "name" ? "contacts.name" : "contacts.recent";
  const cursor = decodeCursor(kind, query);
  const byName = kind === "contacts.name";
  const order = byName ? `${CONTACT_NAME_KEY}, id` : "created_at DESC, id";
  const position = !cursor ? "" : byName
    ? `AND ${after(CONTACT_NAME_KEY, "asc", "$6::text", "$7")}`
    : `AND ${after("created_at", "desc", microsToTimestamp("$6"), "$7")}`;
  const rows = (await tx.query<ContactRow & { sort_value: string }>(
    `SELECT ${contactColumns}, ${byName ? CONTACT_NAME_KEY : timestampToMicros("created_at")} AS sort_value
       FROM crm_contacts WHERE tenant_id=$1
        AND ($4::text IS NULL OR display_name ILIKE $4 OR normalized_email ILIKE $4 OR e164_phone ILIKE $4)
        AND ($5::uuid[] IS NULL OR id = ANY($5)) ${position}
      ORDER BY ${order} LIMIT $2 OFFSET $3`,
    [tenantId, query.limit + 1, query.offset, search, ids, ...(cursor ?? [])],
  )).rows;
  return page(await withConsent(tx, tenantId, rows), query,
    (index) => encodeCursor(kind, [rows[index]!.sort_value, rows[index]!.id]));
}

/** One contact. Another tenant's contact is invisible under RLS, so it is NotFound too. */
export async function getContact(tx: Transaction, tenantId: string, id: string): Promise<ContactRecord> {
  const rows = (await tx.query<ContactRow>(
    `SELECT ${contactColumns} FROM crm_contacts WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
  )).rows;
  const [contact] = await withConsent(tx, tenantId, rows);
  if (!contact) throw new NotFound("Contact not found");
  return contact;
}

/**
 * Deals with value, lead source and won date (inbox-home.md H-1), most recently updated first. A deal that moves while a caller pages jumps to the
 * front; by cursor the deals behind it keep their place, by offset they shift by one.
 */
export async function listDeals(tx: Transaction, tenantId: string, query: ListDealsQuery): Promise<DealPage> {
  const cursor = decodeCursor("deals.recent", query);
  const position = cursor ? `AND ${after("updated_at", "desc", microsToTimestamp("$6"), "$7")}` : "";
  const rows = (await tx.query<DealSummaryRow & { sort_value: string }>(
    `SELECT ${dealSummaryColumns}, ${timestampToMicros("updated_at")} AS sort_value
       FROM crm_deals WHERE tenant_id=$1 AND ($2::uuid IS NULL OR pipeline_id=$2)
        AND ($5::uuid IS NULL OR contact_id=$5) ${position}
      ORDER BY updated_at DESC, id LIMIT $3 OFFSET $4`,
    [tenantId, query.pipelineId ?? null, query.limit + 1, query.offset, query.contactId ?? null, ...(cursor ?? [])],
  )).rows;
  return page(rows.map(dealSummary), query, (index) => encodeCursor("deals.recent", [rows[index]!.sort_value, rows[index]!.id]));
}

export async function listPipelines(tx: Transaction, tenantId: string): Promise<PipelineSummary[]> {
  const rows = (await tx.query<{
    pipeline_id: string; pipeline_name: string; id: string | null; name: string | null; position: number | null;
    outcome: StageOutcome | null;
  }>(
    `SELECT p.id AS pipeline_id, p.name AS pipeline_name, s.id, s.name, s.position, s.outcome
       FROM crm_pipelines p
       LEFT JOIN crm_stages s ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.id
      WHERE p.tenant_id=$1 ORDER BY p.name, p.id, s.position`,
    [tenantId],
  )).rows;
  const pipelines = new Map<string, PipelineSummary>();
  for (const row of rows) {
    const pipeline = pipelines.get(row.pipeline_id) ?? { id: row.pipeline_id, name: row.pipeline_name, stages: [] };
    if (row.id !== null && row.name !== null && row.position !== null && row.outcome !== null)
      pipeline.stages.push({ id: row.id, name: row.name, position: row.position, outcome: row.outcome });
    pipelines.set(row.pipeline_id, pipeline);
  }
  return [...pipelines.values()];
}
