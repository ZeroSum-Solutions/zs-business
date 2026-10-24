// Row loaders and mappers shared by the actions and the reads. Run in a tenant transaction (runtime
// role) or a service transaction; every statement names tenant_id.
import {
  ENRICHMENT_ERROR_CODES,
  type ContactProfileRecord,
  type EnrichmentField,
  type EnrichmentRequestRecord,
  type EnrichmentResultRecord,
  type EnrichmentStatus,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

export interface ProfileRow {
  contact_id: string;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_description: string | null;
  company_employees: number | null;
  company_founded: number | null;
  company_location: string | null;
  company_linkedin_url: string | null;
  country: string | null;
  do_not_enrich_at: Date | null;
  do_not_enrich_reason: string | null;
  outside_eu_uk_attested_by: string | null;
  outside_eu_uk_attested_at: Date | null;
  revision: number;
  updated_at: Date;
}
export const PROFILE_COLUMNS = `contact_id, company_name, company_domain, company_industry, company_description, company_employees,
  company_founded, company_location, company_linkedin_url, country, do_not_enrich_at, do_not_enrich_reason,
  outside_eu_uk_attested_by, outside_eu_uk_attested_at, revision, updated_at`;

export const loadProfile = async (tx: Transaction, tenantId: string, contactId: string, lock = false): Promise<ProfileRow | null> =>
  (await tx.query<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM crm_contact_profile WHERE tenant_id=$1 AND contact_id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, contactId])).rows[0] ?? null;

export const profileRecord = (row: ProfileRow): ContactProfileRecord => ({
  contactId: row.contact_id,
  companyName: row.company_name,
  companyDomain: row.company_domain,
  companyIndustry: row.company_industry,
  companyDescription: row.company_description,
  companyEmployees: row.company_employees,
  companyFounded: row.company_founded,
  companyLocation: row.company_location,
  companyLinkedinUrl: row.company_linkedin_url,
  country: row.country,
  doNotEnrichAt: row.do_not_enrich_at?.toISOString() ?? null,
  doNotEnrichReason: row.do_not_enrich_reason,
  outsideEuUkAttestedAt: row.outside_eu_uk_attested_at?.toISOString() ?? null,
  revision: row.revision,
  updatedAt: row.updated_at.toISOString(),
});

export interface RequestRow {
  id: string;
  contact_id: string;
  op: "company.enrich";
  status: EnrichmentStatus;
  final_reason: string | null;
  last_error: string | null;
  domain: string;
  price_cents: number;
  created_at: Date;
  updated_at: Date;
}
export const REQUEST_COLUMNS = "id, contact_id, op, status, final_reason, last_error, domain, price_cents, created_at, updated_at";

export const loadRequest = async (tx: Transaction, tenantId: string, id: string): Promise<RequestRow | null> =>
  (await tx.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM enrichment_requests WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0] ?? null;

const TENANT_REASONS: ReadonlySet<string> = new Set([...ENRICHMENT_ERROR_CODES, "no_match", "rejected"]);
/** E-17: only the listed codes reach a tenant; an internal reason reads as unavailable. */
const tenantReason = (reason: string | null): string | null =>
  reason === null ? null : TENANT_REASONS.has(reason) ? reason : "enrichment_unavailable";

/** E-17: a tenant sees a stable reason code, never a provider's text. */
export const requestRecord = (row: RequestRow): EnrichmentRequestRecord => ({
  id: row.id,
  contactId: row.contact_id,
  op: row.op,
  status: row.status,
  reason: tenantReason(row.final_reason),
  domain: row.domain,
  priceCents: row.price_cents,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export interface ResultRow {
  id: string;
  request_id: string;
  contact_id: string;
  field: EnrichmentField;
  value: string;
  provider: string;
  treg_call_id: string;
  approval_id: string | null;
  fetched_at: Date;
  expires_at: Date;
}
export const RESULT_COLUMNS = "id, request_id, contact_id, field, value, provider, treg_call_id, approval_id, fetched_at, expires_at";

export const resultRecord = (row: ResultRow): EnrichmentResultRecord => ({
  id: row.id,
  requestId: row.request_id,
  contactId: row.contact_id,
  field: row.field,
  value: row.value,
  provider: row.provider,
  callId: row.treg_call_id,
  fetchedAt: row.fetched_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  approvalId: row.approval_id,
});

/** E-14: the profile column each result field lands in. */
export const FIELD_COLUMNS: Readonly<Record<EnrichmentField, { column: string; integer: boolean }>> = Object.freeze({
  name: { column: "company_name", integer: false },
  domain: { column: "company_domain", integer: false },
  industry: { column: "company_industry", integer: false },
  description: { column: "company_description", integer: false },
  employees: { column: "company_employees", integer: true },
  founded: { column: "company_founded", integer: true },
  location: { column: "company_location", integer: false },
  linkedin_url: { column: "company_linkedin_url", integer: false },
});
