// Industry templates (docs/requirements/industry-templates.md IT-4, IT-5, IT-11): the apply action
// and the booking page publish action, through the shared dispatcher. Templates are code
// (@zs/contracts), so the apply reads no catalog rows. Original code.
import {
  actionCommandSchema,
  applyTemplatePayloadSchema,
  BOOKING_PAGE_SET_PUBLISHED_ACTION,
  Conflict,
  INDUSTRY_TEMPLATES,
  NotFound,
  parseTemplateDraft,
  TEMPLATE_APPLIED_EVENT,
  TEMPLATE_APPLY_ACTION,
  templateApplyKey,
  uuidSchema,
  ValidationFailed,
  type BookingPagePublished,
  type JsonValue,
  type Target,
  type TemplateApplied,
} from "@zs/contracts";
import { z } from "zod";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail, tenantVisible } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import { templateDigest, templateIdFor } from "../templates/store.js";
import { loadSetup } from "./reads.js";

export const TENANT_SETUP_TARGET = "tenant_setup";
export const BOOKING_PAGE_TARGET = "booking_page";

const applyCommandSchema = actionCommandSchema.extend({
  actionType: z.literal(TEMPLATE_APPLY_ACTION),
  payload: applyTemplatePayloadSchema,
});
const setPublishedCommandSchema = actionCommandSchema.extend({
  actionType: z.literal(BOOKING_PAGE_SET_PUBLISHED_ACTION),
  payload: z.strictObject({ pageId: uuidSchema, published: z.boolean() }),
});

/** The setup target is the tenant itself: one setup per tenant. */
async function resolveSetup(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== TENANT_SETUP_TARGET) throw new ValidationFailed("A template apply requires a tenant_setup target");
  if (target.id !== target.tenantId || !(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: TENANT_SETUP_TARGET, id: target.id };
}

/** PostgreSQL knows the zone, so the profile trigger and the booking rules agree with the check. */
export async function zoneKnown(tx: Transaction, name: string): Promise<boolean> {
  return (await tx.query("SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = $1", [name])).rowCount === 1;
}

/**
 * IT-4: one transaction writes the confirmed zone, the pipeline and stages, the resource, the
 * unpublished page and its resource link, the setup row and the missing message templates. It
 * inserts only, so an existing pipeline, resource or page stays. IT-5: at most 10 queries of its
 * own, whatever the number of stages or messages (multi-row inserts). The IT-4 checks run here too,
 * so a direct dispatch cannot skip them: the server's `template:<id>` key, the zone, and the setup row.
 */
export const applyTemplateHandler: ActionHandler = {
  resolveTarget: resolveSetup,
  async handle({ tx, command, binding, now, generateId, actionId }) {
    const tenantId = binding.tenantId;
    // Queries 1 and 2: the membership lock and read.
    await requireMember(tx, tenantId, binding.actorId, "business");
    const { payload } = parseOrFail(applyCommandSchema, command);
    if (!actionId) throw new ValidationFailed("The dispatcher did not offer an action ID");
    // IT-4 inside the handler: the reserved key for this template, a zone PostgreSQL knows, and
    // no setup yet (queries 3 and 4). The session reads the same facts first to answer a replay.
    if (command.idempotencyKey !== templateApplyKey(payload.templateId))
      throw new ValidationFailed("A template apply uses the server's template key");
    if (!(await zoneKnown(tx, payload.timeZone))) throw new ValidationFailed("Unknown time zone");
    const existing = await loadSetup(tx, tenantId);
    if (existing)
      throw new Conflict("A template is already applied", { reason: "template_already_applied" });
    const template = INDUSTRY_TEMPLATES[payload.templateId];
    const at = clockInstant(now);
    const ids = {
      action: actionId(),
      pipeline: generateId(),
      stages: template.pipeline.stages.map(() => generateId()),
      resource: generateId(),
      page: generateId(),
    };

    // Query 5: the owner confirmed the zone on the preview. A missing profile aborts the apply.
    const profile = await tx.query(
      `UPDATE business_profiles SET time_zone=$2, revision=revision+1, updated_by=$3, updated_at=$4
        WHERE tenant_id=$1 RETURNING tenant_id`,
      [tenantId, payload.timeZone, binding.actorId, at]);
    if (profile.rowCount !== 1) throw new NotFound("The business profile is missing");

    // Query 6: the pipeline and its stages in one statement.
    await tx.query(
      `WITH p AS (INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3) RETURNING tenant_id,id)
       INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome)
       SELECT p.tenant_id, s.id, p.id, s.name, s.position, s.outcome
         FROM p, jsonb_to_recordset($4::jsonb) AS s(id uuid, name text, position integer, outcome text)`,
      [tenantId, ids.pipeline, template.pipeline.name, JSON.stringify(template.pipeline.stages.map((stage, position) => ({
        id: ids.stages[position], name: stage.name, position, outcome: stage.outcome,
      })))]);

    // Query 7: the one resource, in the confirmed zone.
    const resource = template.resource;
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7,$8,$9,$10,$11)`,
      [tenantId, ids.resource, resource.name, payload.timeZone, JSON.stringify(resource.weekly), resource.slotLengthMinutes,
        resource.slotStepMinutes, resource.bufferBeforeMinutes, resource.bufferAfterMinutes, resource.minimumNoticeMinutes,
        resource.bookingHorizonMinutes]);

    // Query 8: the page, off line until IT-11, and its resource link. The disclosure trigger
    // records the first disclosure version.
    await tx.query(
      `WITH page AS (
         INSERT INTO booking_pages (tenant_id,id,title,description,published,disclosure_version,disclosure_text,created_at)
         VALUES ($1,$2,$3,$4,false,'v1',$5,$6) RETURNING tenant_id,id)
       INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) SELECT tenant_id,id,$7,0 FROM page`,
      [tenantId, ids.page, template.bookingPage.title, template.bookingPage.description, template.bookingPage.disclosureText,
        at, ids.resource]);

    // Query 9: the setup row; the primary key makes a second apply lose here.
    await tx.query(
      `INSERT INTO tenant_setups (tenant_id,template_id,template_version,action_id,pipeline_id,resource_id,booking_page_id,applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, template.id, template.version, ids.action, ids.pipeline, ids.resource, ids.page, at]);

    // Query 10: each message template the tenant lacks, with its first revision and no standing
    // approval. A kind the tenant already has is skipped, never overwritten.
    const messages = template.messages.map(({ agentKind, ...draft }) => {
      const checked = parseTemplateDraft(agentKind, draft);
      return {
        template_id: templateIdFor(tenantId, agentKind), revision_id: generateId(), agent_kind: agentKind,
        channel: checked.channel, purpose: checked.purpose, subject: checked.subject, body: checked.body,
        variables: checked.variables, timing_hours: checked.timingHours,
        content_digest: templateDigest({ kind: agentKind, ...checked }),
      };
    });
    const created = messages.length === 0 ? [] : (await tx.query<{ template_id: string }>(
      `WITH m AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS m(template_id uuid, revision_id uuid, agent_kind text, channel text,
           purpose text, subject text, body text, variables text[], timing_hours integer, content_digest text)),
       t AS (
         INSERT INTO message_templates (tenant_id,id,agent_kind,current_revision,created_at)
         SELECT $1, m.template_id, m.agent_kind, 1, $3 FROM m ON CONFLICT DO NOTHING RETURNING id)
       INSERT INTO message_template_revisions (tenant_id,id,template_id,revision,channel,purpose,subject,body,variables,
         timing_hours,content_digest,created_by,created_at)
       SELECT $1, m.revision_id, m.template_id, 1, m.channel, m.purpose, m.subject, m.body, m.variables, m.timing_hours,
         m.content_digest, $4, $3
         FROM m JOIN t ON t.id = m.template_id
       RETURNING template_id`,
      [tenantId, JSON.stringify(messages), at, binding.actorId])).rows;
    const createdIds = new Set(created.map((row) => row.template_id));

    const result: TemplateApplied = {
      templateId: template.id,
      templateVersion: template.version,
      timeZone: payload.timeZone,
      appliedAt: at,
      pipelineId: ids.pipeline,
      stageIds: ids.stages,
      resourceId: ids.resource,
      bookingPageId: ids.page,
      messageTemplateIds: messages.map((message) => message.template_id).filter((id) => createdIds.has(id)),
    };
    const json = result as unknown as JsonValue;
    return { result: json, event: { type: TEMPLATE_APPLIED_EVENT, payload: { actionId: ids.action, ...result } as unknown as JsonValue } };
  },
};

/** IT-11: a page of the caller's tenant; none, or another tenant's, is 404. */
async function resolvePage(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== BOOKING_PAGE_TARGET) throw new ValidationFailed("A page action requires a booking_page target");
  const found = await tx.query("SELECT 1 FROM booking_pages WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
  if (found.rowCount !== 1) throw new NotFound("No such booking page");
  return { tenantId: target.tenantId, type: BOOKING_PAGE_TARGET, id: target.id };
}

/** IT-11: changes only `published`; a page that already has the value is left as it is. */
export const setBookingPagePublishedHandler: ActionHandler = {
  resolveTarget: resolvePage,
  async handle({ tx, command, binding }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "business");
    const { payload, target } = parseOrFail(setPublishedCommandSchema, command);
    if (payload.pageId !== target.id) throw new ValidationFailed("The page and the target differ");
    const changed = await tx.query(
      "UPDATE booking_pages SET published=$3 WHERE tenant_id=$1 AND id=$2 AND published IS DISTINCT FROM $3",
      [binding.tenantId, payload.pageId, payload.published]);
    const result: BookingPagePublished = { pageId: payload.pageId, published: payload.published, changed: changed.rowCount === 1 };
    return { result: result as unknown as JsonValue };
  },
};

export const setupHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [TEMPLATE_APPLY_ACTION]: applyTemplateHandler,
  [BOOKING_PAGE_SET_PUBLISHED_ACTION]: setBookingPagePublishedHandler,
});
