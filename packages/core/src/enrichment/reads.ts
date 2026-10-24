// Enrichment reads (enrichment.md E-17). They run in a tenant transaction as the runtime role, so
// RLS already hides every other tenant's rows.
import { ENRICHMENT_PROPOSALS_LIMIT, type ContactEnrichment, type EnrichmentField, type EnrichmentProposal, type EnrichmentRequestRecord } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import {
  FIELD_COLUMNS,
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

interface ProposalRow {
  approval_id: string;
  contact_id: string;
  display_name: string;
  result_id: string;
  field: EnrichmentField;
  value: string;
  provider: string;
  treg_call_id: string;
  fetched_at: Date;
  requested_at: Date;
  expires_at: Date;
  current_value: string | null;
}

// Each field's profile column, as text, for the current value next to the found one.
const CURRENT_VALUE = `CASE r.field ${Object.entries(FIELD_COLUMNS)
  .map(([field, { column }]) => `WHEN '${field}' THEN p.${column}::text`).join(" ")} END`;

/**
 * E-14: the undecided `contact.profile.apply` approvals whose approval and result are both unexpired,
 * oldest first, each with the profile's current value for its field. Expired ones cannot be approved
 * (A-3), so they are left out.
 */
export async function listEnrichmentProposals(tx: Transaction, tenantId: string, now: Date): Promise<EnrichmentProposal[]> {
  const rows = (await tx.query<ProposalRow>(
    `SELECT a.id AS approval_id, r.contact_id, c.display_name, r.id AS result_id, r.field, r.value, r.provider, r.treg_call_id,
            r.fetched_at, a.requested_at, LEAST(a.expires_at, r.expires_at) AS expires_at, ${CURRENT_VALUE} AS current_value
       FROM approvals a
       JOIN enrichment_results r ON r.tenant_id=a.tenant_id AND r.approval_id=a.id
       JOIN crm_contacts c ON c.tenant_id=r.tenant_id AND c.id=r.contact_id
       LEFT JOIN crm_contact_profile p ON p.tenant_id=r.tenant_id AND p.contact_id=r.contact_id
      WHERE a.tenant_id=$1 AND a.action_type='contact.profile.apply' AND a.status='pending'
        AND a.expires_at > $2 AND r.expires_at > $2
      ORDER BY a.requested_at, c.display_name, r.contact_id, r.field
      LIMIT $3`,
    [tenantId, now, ENRICHMENT_PROPOSALS_LIMIT])).rows;
  return rows.map((row) => ({
    approvalId: row.approval_id,
    contactId: row.contact_id,
    contactName: row.display_name,
    resultId: row.result_id,
    field: row.field,
    currentValue: row.current_value,
    proposedValue: row.value,
    provider: row.provider,
    callId: row.treg_call_id,
    fetchedAt: row.fetched_at.toISOString(),
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}
