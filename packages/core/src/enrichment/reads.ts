// Enrichment reads (enrichment.md E-17). They run in a tenant transaction as the runtime role, so
// RLS already hides every other tenant's rows.
import type { ContactEnrichment, EnrichmentRequestRecord } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import {
  loadProfile,
  loadRequest,
  profileRecord,
  REQUEST_COLUMNS,
  requestRecord,
  RESULT_COLUMNS,
  resultRecord,
  type RequestRow,
  type ResultRow,
} from "./records.js";

/** One request; null when it is not this tenant's. */
export async function getEnrichmentRequest(tx: Transaction, tenantId: string, id: string): Promise<EnrichmentRequestRecord | null> {
  const row = await loadRequest(tx, tenantId, id);
  return row ? requestRecord(row) : null;
}

/**
 * A contact's profile, its requests (newest first) and its unexpired results. Null when the contact
 * is not this tenant's, so a foreign ID reads as nothing.
 */
export async function getContactEnrichment(tx: Transaction, tenantId: string, contactId: string, now: Date): Promise<ContactEnrichment | null> {
  if ((await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rowCount !== 1) return null;
  const profile = await loadProfile(tx, tenantId, contactId);
  const requests = (await tx.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM enrichment_requests WHERE tenant_id=$1 AND contact_id=$2 ORDER BY created_at DESC, id LIMIT 50`,
    [tenantId, contactId])).rows;
  const results = (await tx.query<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM enrichment_results WHERE tenant_id=$1 AND contact_id=$2 AND expires_at > $3 ORDER BY fetched_at DESC, field`,
    [tenantId, contactId, now])).rows;
  return { profile: profile ? profileRecord(profile) : null, requests: requests.map(requestRecord), results: results.map(resultRecord) };
}
