// Industry templates (docs/requirements/industry-templates.md IT-4, IT-6): what a tenant applied,
// read before an apply dispatches and by GET /v1/setup. Runs as the runtime role; RLS scopes rows.
import {
  INDUSTRY_TEMPLATE_IDS,
  INDUSTRY_TEMPLATES,
  industryTemplatePreview,
  type AppliedSetup,
  type IndustryTemplateId,
  type JsonValue,
  type SetupRead,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";

interface SetupRow {
  template_id: IndustryTemplateId;
  template_version: number;
  action_id: string;
  pipeline_id: string;
  resource_id: string;
  booking_page_id: string;
  applied_at: Date;
  published: boolean;
}
export interface StoredSetup {
  readonly setup: AppliedSetup;
  readonly actionId: string;
}

/** The tenant's setup row with its page's live state, or null before any apply. */
export async function loadSetup(tx: Transaction, tenantId: string): Promise<StoredSetup | null> {
  const row = (await tx.query<SetupRow>(
    `SELECT s.template_id, s.template_version, s.action_id, s.pipeline_id, s.resource_id, s.booking_page_id, s.applied_at, p.published
       FROM tenant_setups s
       JOIN booking_pages p ON p.tenant_id = s.tenant_id AND p.id = s.booking_page_id
      WHERE s.tenant_id = $1`,
    [tenantId])).rows[0];
  if (!row) return null;
  return {
    actionId: row.action_id,
    setup: {
      templateId: row.template_id,
      templateVersion: row.template_version,
      appliedAt: row.applied_at.toISOString(),
      pipelineId: row.pipeline_id,
      resourceId: row.resource_id,
      bookingPageId: row.booking_page_id,
      published: row.published,
    },
  };
}

/** The stored result of the action that applied the template (the IT-4 replay answer). */
export async function storedApplyResult(tx: Transaction, tenantId: string, actionId: string): Promise<JsonValue | null> {
  return (await tx.query<{ result: JsonValue }>(
    "SELECT result FROM actions WHERE tenant_id=$1 AND id=$2", [tenantId, actionId])).rows[0]?.result ?? null;
}

/** IT-6: the applied setup, the profile's zone and every template's resolved preview. */
export async function readSetup(tx: Transaction, tenantId: string): Promise<SetupRead> {
  const stored = await loadSetup(tx, tenantId);
  const zone = (await tx.query<{ time_zone: string | null }>(
    "SELECT time_zone FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0]?.time_zone ?? null;
  return {
    applied: stored?.setup ?? null,
    timeZone: zone,
    templates: INDUSTRY_TEMPLATE_IDS.map((id) => industryTemplatePreview(INDUSTRY_TEMPLATES[id])),
  };
}
