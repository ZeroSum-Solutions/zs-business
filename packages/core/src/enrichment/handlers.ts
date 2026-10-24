// Enrichment actions (enrichment.md E-4, E-6, E-7, E-14). They run through the shared dispatcher as
// the runtime role. The attempt, settle and record steps are not actions: they need the wallet and
// the approvals insert, which only the service role holds (worker.ts).
import {
  applyProfileCommandSchema,
  attestRegionCommandSchema,
  blockEnrichmentCommandSchema,
  Conflict,
  ENRICHMENT_REQUEST_TARGET,
  enrichmentRequestCommandSchema,
  TenantDenied,
  unblockEnrichmentCommandSchema,
  ValidationFailed,
  type EnrichmentField,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { getWallet } from "../wallet/index.js";
import { enrichmentConfigSchema, enrichmentEnabled, type EnrichmentConfig } from "./config.js";
import {
  loadProfile,
  loadRequest,
  PROFILE_COLUMNS,
  profileRecord,
  requestRecord,
  RESULT_COLUMNS,
  type ProfileRow,
  type ResultRow,
} from "./records.js";
import { enrichmentBlockedNow, enrichmentVerdict, lockContactEnrichment } from "./rules.js";

export const ENRICHMENT_REQUEST_ACTION = "enrichment.request";
export const ENRICHMENT_BLOCK_ACTION = "contact.enrichment.block";
export const ENRICHMENT_UNBLOCK_ACTION = "contact.enrichment.unblock";
export const REGION_ATTEST_ACTION = "contact.region.attest";
export const PROFILE_APPLY_ACTION = "contact.profile.apply";
/** The source name of an applied field (E-14); its `source_ref` is the Treg call id. */
export const ENRICHMENT_SOURCE = "enrichment.treg";

/** E-5, E-8, E-9: the injected settings; a dispatcher built without them refuses every request. */
function enrichmentConfig(config: unknown): EnrichmentConfig {
  const raw = typeof config === "object" && config !== null ? (config as { enrichment?: unknown }).enrichment : undefined;
  const parsed = enrichmentConfigSchema.safeParse(raw);
  if (!raw || !parsed.success || !enrichmentEnabled(parsed.data))
    throw new Conflict("Enrichment is not available", { reason: "enrichment_unavailable" });
  return parsed.data;
}
const refuse = (code: string) => new Conflict(`Enrichment refused: ${code}`, { reason: code });

async function resolveContact(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "contact") throw new ValidationFailed("This action requires a contact target");
  return (await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])).rowCount === 1
    ? { tenantId: target.tenantId, type: "contact", id: target.id } : null;
}

/** The first instant of the UTC day `now` falls in (E-9). */
const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const enrichmentRequestHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== ENRICHMENT_REQUEST_TARGET) throw new ValidationFailed("Enrichment requests need an enrichment_request target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadRequest(tx, target.tenantId, target.id)) throw new Conflict("The request ID is already in use", { reason: "id_in_use" });
    return { tenantId: target.tenantId, type: ENRICHMENT_REQUEST_TARGET, id: target.id };
  },
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(enrichmentRequestCommandSchema, command);
    const settings = enrichmentConfig(config);
    const tenantId = binding.tenantId;
    const at = clockInstant(now);
    // The contact must be in the caller's tenant; RLS hides every other tenant's row.
    const verdict = await enrichmentVerdict(tx, { tenantId, contactId: payload.contactId });
    if (verdict === "no_contact") throw new TenantDenied();
    if (verdict.code !== null) throw refuse(verdict.code);
    // E-8: a courtesy read; the worker holds the money.
    const price = settings.prices[payload.op];
    const wallet = await getWallet(tx, tenantId);
    if (wallet.currency !== "usd" || wallet.available < price) throw refuse("insufficient_funds");
    // E-9: this tenant's requests of the UTC day, counted under a tenant-keyed lock.
    await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`enrichment-day:${tenantId}`]);
    const today = (await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM enrichment_requests WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $2::timestamptz + interval '1 day'",
      [tenantId, utcDayStart(now).toISOString()])).rows[0]!.n;
    if (today >= settings.tenantDailyCap) throw refuse("enrichment_daily_cap");
    await tx.query(
      `INSERT INTO enrichment_requests (tenant_id, id, contact_id, op, domain, price_cents, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7)`,
      [tenantId, payload.requestId, payload.contactId, payload.op, verdict.domain, price, at]);
    const record = requestRecord((await loadRequest(tx, tenantId, payload.requestId))!);
    return {
      result: record,
      event: { type: "enrichment.requested", payload: { requestId: record.id, contactId: record.contactId, op: record.op } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "enrichment_requests_pkey")
      return new Conflict("The request ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

const profileResult = (row: ProfileRow, type: string, contactId: string) => ({
  result: profileRecord(row),
  event: { type, payload: { contactId, revision: row.revision } },
});

export const blockEnrichmentHandler: ActionHandler = {
  resolveTarget: resolveContact,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(blockEnrichmentCommandSchema, command);
    const at = clockInstant(now);
    await lockContactEnrichment(tx, binding.tenantId, payload.contactId);
    const row = (await tx.query<ProfileRow>(
      `INSERT INTO crm_contact_profile (tenant_id, contact_id, do_not_enrich_at, do_not_enrich_reason, updated_at)
       VALUES ($1,$2,$3,$4,$3)
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET do_not_enrich_at=EXCLUDED.do_not_enrich_at,
         do_not_enrich_reason=EXCLUDED.do_not_enrich_reason, revision=crm_contact_profile.revision+1, updated_at=EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [binding.tenantId, payload.contactId, at, payload.reason])).rows[0]!;
    return profileResult(row, "contact.enrichment.blocked", payload.contactId);
  },
};

export const unblockEnrichmentHandler: ActionHandler = {
  resolveTarget: resolveContact,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(unblockEnrichmentCommandSchema, command);
    const at = clockInstant(now);
    const row = (await tx.query<ProfileRow>(
      `INSERT INTO crm_contact_profile (tenant_id, contact_id, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET do_not_enrich_at=NULL, do_not_enrich_reason=NULL,
         revision=crm_contact_profile.revision+1, updated_at=EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [binding.tenantId, payload.contactId, at])).rows[0]!;
    return profileResult(row, "contact.enrichment.unblocked", payload.contactId);
  },
};

export const attestRegionHandler: ActionHandler = {
  resolveTarget: resolveContact,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(attestRegionCommandSchema, command);
    const at = clockInstant(now);
    const row = (await tx.query<ProfileRow>(
      `INSERT INTO crm_contact_profile (tenant_id, contact_id, outside_eu_uk_attested_by, outside_eu_uk_attested_at, updated_at)
       VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET outside_eu_uk_attested_by=EXCLUDED.outside_eu_uk_attested_by,
         outside_eu_uk_attested_at=EXCLUDED.outside_eu_uk_attested_at, revision=crm_contact_profile.revision+1, updated_at=EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [binding.tenantId, payload.contactId, binding.actorId, at])).rows[0]!;
    return profileResult(row, "contact.region.attested", payload.contactId);
  },
};

/** E-14: the profile column each field lands in. */
const FIELD_COLUMNS: Readonly<Record<EnrichmentField, { column: string; integer: boolean }>> = Object.freeze({
  name: { column: "company_name", integer: false },
  domain: { column: "company_domain", integer: false },
  industry: { column: "company_industry", integer: false },
  description: { column: "company_description", integer: false },
  employees: { column: "company_employees", integer: true },
  founded: { column: "company_founded", integer: true },
  location: { column: "company_location", integer: false },
  linkedin_url: { column: "company_linkedin_url", integer: false },
});

/** F-4 for the source this slice owns: one record per contact and source, kept at the newest observation. */
async function observeEnrichmentSource(
  tx: Transaction,
  input: { tenantId: string; contactId: string; callId: string; observedAt: Date; actorId: string; recordId: string; at: string },
) {
  await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`source-record:${input.tenantId}:contact:${input.contactId}:${ENRICHMENT_SOURCE}`]);
  const stored = (await tx.query<{ id: string; observed_at: Date }>(
    `SELECT id, observed_at FROM source_records
      WHERE tenant_id=$1 AND subject_type='contact' AND subject_id=$2 AND source=$3 FOR UPDATE`,
    [input.tenantId, input.contactId, ENRICHMENT_SOURCE])).rows[0];
  const observed = input.observedAt.toISOString();
  if (!stored) {
    await tx.query(
      `INSERT INTO source_records (tenant_id,id,subject_type,subject_id,source,source_ref,observed_at,revision,recorded_by,recorded_at,updated_at)
       VALUES ($1,$2,'contact',$3,$4,$5,$6,1,$7,$8,$8)`,
      [input.tenantId, input.recordId, input.contactId, ENRICHMENT_SOURCE, input.callId, observed, input.actorId, input.at]);
  } else if (input.observedAt.getTime() > stored.observed_at.getTime()) {
    await tx.query(
      `UPDATE source_records SET source_ref=$3, observed_at=$4, revision=revision+1, updated_at=GREATEST($5::timestamptz, recorded_at)
        WHERE tenant_id=$1 AND id=$2`,
      [input.tenantId, stored.id, input.callId, observed, input.at]);
  }
}

export const applyProfileHandler: ActionHandler = {
  resolveTarget: resolveContact,
  async handle({ tx, command, binding, now, generateId }) {
    const { payload } = parseOrFail(applyProfileCommandSchema, command);
    const tenantId = binding.tenantId;
    const at = clockInstant(now);
    const result = (await tx.query<ResultRow>(
      `SELECT ${RESULT_COLUMNS} FROM enrichment_results WHERE tenant_id=$1 AND id=$2`, [tenantId, payload.resultId])).rows[0];
    // E-14: the result must exist, belong to this contact and be unexpired.
    if (!result || result.expires_at.getTime() <= now.getTime()) throw refuse("enrichment_result_expired");
    if (result.contact_id !== payload.contactId) throw new TenantDenied();
    // E-6: a later block stops the write even though an owner approved it.
    await lockContactEnrichment(tx, tenantId, payload.contactId);
    await loadProfile(tx, tenantId, payload.contactId, true);
    if (await enrichmentBlockedNow(tx, tenantId, payload.contactId)) throw refuse("enrichment_blocked");
    const { column, integer } = FIELD_COLUMNS[result.field];
    const value = integer ? Number(result.value) : result.value;
    // `column` comes from the fixed map above, never from input.
    const row = (await tx.query<ProfileRow>(
      `INSERT INTO crm_contact_profile (tenant_id, contact_id, ${column}, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET ${column}=EXCLUDED.${column}, revision=crm_contact_profile.revision+1,
         updated_at=EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [tenantId, payload.contactId, value, at])).rows[0]!;
    await observeEnrichmentSource(tx, {
      tenantId, contactId: payload.contactId, callId: result.treg_call_id,
      observedAt: result.fetched_at.getTime() > now.getTime() ? now : result.fetched_at, actorId: binding.actorId,
      recordId: generateId(), at,
    });
    return {
      result: profileRecord(row),
      event: { type: "contact.profile.applied", payload: { contactId: payload.contactId, resultId: payload.resultId, field: result.field } },
    };
  },
};

export const enrichmentHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [ENRICHMENT_REQUEST_ACTION]: enrichmentRequestHandler,
  [ENRICHMENT_BLOCK_ACTION]: blockEnrichmentHandler,
  [ENRICHMENT_UNBLOCK_ACTION]: unblockEnrichmentHandler,
  [REGION_ATTEST_ACTION]: attestRegionHandler,
  [PROFILE_APPLY_ACTION]: applyProfileHandler,
});
