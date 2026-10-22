import {
  Conflict,
  TenantDenied,
  ValidationFailed,
  createDealCommandSchema,
  moveDealStageCommandSchema,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import {
  clockInstant,
  dealColumns,
  dealRecord,
  idInUse,
  parseOrFail,
  pgCode,
  pgConstraint,
  tenantVisible,
  type DealRow,
} from "./rows.js";

const exists = async (tx: Transaction, sql: string, params: unknown[]) => (await tx.query(sql, params)).rowCount === 1;

async function stagePipeline(tx: Transaction, tenantId: string, stageId: string): Promise<string | undefined> {
  return (await tx.query<{ pipeline_id: string }>(
    "SELECT pipeline_id FROM crm_stages WHERE tenant_id=$1 AND id=$2", [tenantId, stageId],
  )).rows[0]?.pipeline_id;
}

async function pipelineOwned(tx: Transaction, tenantId: string, pipelineId: string): Promise<boolean> {
  return exists(tx, "SELECT 1 FROM crm_pipelines WHERE tenant_id=$1 AND id=$2", [tenantId, pipelineId]);
}

export const createDealHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "deal" || !(await tenantVisible(tx, target.tenantId))) return null;
    // C-18: an owned existing deal is a domain conflict, never a valid create target.
    if (await exists(tx, "SELECT 1 FROM crm_deals WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]))
      throw idInUse("deal");
    return { tenantId: target.tenantId, type: "deal", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const at = clockInstant(now);
    const { payload: input } = parseOrFail(createDealCommandSchema, command);
    const tenantId = binding.tenantId;
    // C-13: every parent's ownership first (TenantDenied), then stage membership (ValidationFailed).
    const contactOwned = await exists(tx,
      "SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE", [tenantId, input.contactId]);
    const pipelineFound = await pipelineOwned(tx, tenantId, input.pipelineId);
    const stagePipelineId = await stagePipeline(tx, tenantId, input.stageId);
    if (!contactOwned || !pipelineFound || stagePipelineId === undefined) throw new TenantDenied();
    if (stagePipelineId !== input.pipelineId)
      throw new ValidationFailed("The stage does not belong to the pipeline");
    const row = (await tx.query<DealRow>(
      `INSERT INTO crm_deals (tenant_id,id,contact_id,pipeline_id,stage_id,title,revision,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7) RETURNING ${dealColumns}`,
      [tenantId, input.dealId, input.contactId, input.pipelineId, input.stageId, input.title, at],
    )).rows[0]!;
    return { result: dealRecord(row) };
  },
  mapError(error) {
    // A concurrent create of the same ID after resolution keeps the SQL details and adds the reason.
    if (pgCode(error) === "23505" && pgConstraint(error) === "crm_deals_pkey")
      return new Conflict("The deal ID is already in use", {
        reason: "id_in_use", postgresCode: "23505", constraint: "crm_deals_pkey",
      });
    return undefined;
  },
};

async function currentRevision(tx: Transaction, tenantId: string, dealId: string): Promise<number> {
  const row = (await tx.query<{ revision: string }>(
    "SELECT revision::text AS revision FROM crm_deals WHERE tenant_id=$1 AND id=$2", [tenantId, dealId],
  )).rows[0];
  if (!row) throw new TenantDenied();
  return Number(row.revision);
}

export const moveDealStageHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "deal") return null;
    const owned = await exists(tx, "SELECT 1 FROM crm_deals WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
    return owned ? { tenantId: target.tenantId, type: "deal", id: target.id } : null;
  },
  async handle({ tx, command, binding, now }) {
    const at = clockInstant(now);
    const { payload: input } = parseOrFail(moveDealStageCommandSchema, command);
    const tenantId = binding.tenantId;
    // C-14 order: ownership, then pipeline/stage membership, then the revision compare-and-set.
    const deal = (await tx.query<{ pipeline_id: string }>(
      "SELECT pipeline_id FROM crm_deals WHERE tenant_id=$1 AND id=$2", [tenantId, input.dealId],
    )).rows[0];
    const pipelineFound = await pipelineOwned(tx, tenantId, input.pipelineId);
    const stagePipelineId = await stagePipeline(tx, tenantId, input.stageId);
    if (!deal || !pipelineFound || stagePipelineId === undefined) throw new TenantDenied();
    if (input.pipelineId !== deal.pipeline_id)
      throw new ValidationFailed("Deals cannot move between pipelines");
    if (stagePipelineId !== input.pipelineId)
      throw new ValidationFailed("The stage does not belong to the deal's pipeline");
    const row = (await tx.query<DealRow>(
      `UPDATE crm_deals SET stage_id=$4, revision=revision+1, updated_at=$6
       WHERE tenant_id=$1 AND id=$2 AND pipeline_id=$3 AND revision=$5 AND revision < 9007199254740991
       RETURNING ${dealColumns}`,
      [tenantId, input.dealId, input.pipelineId, input.stageId, input.expectedRevision, at],
    )).rows[0];
    if (!row)
      throw new Conflict("The deal revision changed", {
        reason: "stale_revision",
        currentRevision: await currentRevision(tx, tenantId, input.dealId),
      });
    return { result: dealRecord(row) };
  },
};
