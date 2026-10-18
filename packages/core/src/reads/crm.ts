// M1 tenant-scoped CRM reads. They run inside ScopedDatabase.tenant (RLS) and reuse the
// row mappers the write handlers use, so reads and writes return identical records.
import type { ContactPage, DealPage, ListDealsQuery, PageQuery, PipelineSummary } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import {
  contactColumns,
  contactRecord,
  dealColumns,
  dealRecord,
  type ConsentRow,
  type ContactRow,
  type DealRow,
} from "../crm/rows.js";
import { page } from "./page.js";

export async function listContacts(tx: Transaction, tenantId: string, query: PageQuery): Promise<ContactPage> {
  const rows = (await tx.query<ContactRow>(
    `SELECT ${contactColumns} FROM crm_contacts WHERE tenant_id=$1
      ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
    [tenantId, query.limit + 1, query.offset],
  )).rows;
  const ids = rows.map((row) => row.id);
  const consent = (await tx.query<ConsentRow & { contact_id: string }>(
    `SELECT contact_id, channel::text AS channel, status::text AS status, source, recorded_at,
       ((extract(epoch FROM recorded_at) * 1000000)::numeric(30,0))::text AS recorded_us
     FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id = ANY($2::uuid[])`,
    [tenantId, ids],
  )).rows;
  const byContact = new Map<string, Map<string, ConsentRow>>();
  for (const row of consent) {
    const channels = byContact.get(row.contact_id) ?? new Map<string, ConsentRow>();
    channels.set(row.channel, row);
    byContact.set(row.contact_id, channels);
  }
  return page(rows.map((row) => contactRecord(row, byContact.get(row.id) ?? new Map())), query);
}

export async function listDeals(tx: Transaction, tenantId: string, query: ListDealsQuery): Promise<DealPage> {
  const rows = (await tx.query<DealRow>(
    `SELECT ${dealColumns} FROM crm_deals WHERE tenant_id=$1 AND ($2::uuid IS NULL OR pipeline_id=$2)
      ORDER BY updated_at DESC, id LIMIT $3 OFFSET $4`,
    [tenantId, query.pipelineId ?? null, query.limit + 1, query.offset],
  )).rows;
  return page(rows.map(dealRecord), query);
}

export async function listPipelines(tx: Transaction, tenantId: string): Promise<PipelineSummary[]> {
  const rows = (await tx.query<{ pipeline_id: string; pipeline_name: string; id: string | null; name: string | null; position: number | null }>(
    `SELECT p.id AS pipeline_id, p.name AS pipeline_name, s.id, s.name, s.position
       FROM crm_pipelines p
       LEFT JOIN crm_stages s ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.id
      WHERE p.tenant_id=$1 ORDER BY p.name, p.id, s.position`,
    [tenantId],
  )).rows;
  const pipelines = new Map<string, PipelineSummary>();
  for (const row of rows) {
    const pipeline = pipelines.get(row.pipeline_id) ?? { id: row.pipeline_id, name: row.pipeline_name, stages: [] };
    if (row.id !== null && row.name !== null && row.position !== null)
      pipeline.stages.push({ id: row.id, name: row.name, position: row.position });
    pipelines.set(row.pipeline_id, pipeline);
  }
  return [...pipelines.values()];
}
