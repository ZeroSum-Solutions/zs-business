// Pipeline stage editor (crm.md revision 4, C-25..C-33). Original code. Five actions outside
// `crmHandlers` (C-23 keeps that map to its three keys). A stage is archived, never deleted.
import {
  archiveStageCommandSchema,
  Conflict,
  createStageCommandSchema,
  MAX_LIVE_STAGES,
  MAX_TOTAL_STAGES,
  renameStageCommandSchema,
  reorderStagesCommandSchema,
  restoreStageCommandSchema,
  stageOutputSchema,
  TenantDenied,
  ValidationFailed,
  type ActionCommand,
  type ActionResult,
  type ArchiveStageCommand,
  type CreateStageCommand,
  type PipelineSummary,
  type RenameStageCommand,
  type ReorderStagesCommand,
  type RestoreStageCommand,
  type StageOutput,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { getPipeline } from "../reads/crm.js";
import { clockInstant, idInUse, parseOrFail, pgCode, pgConstraint, tenantVisible } from "./rows.js";

export const CREATE_STAGE_ACTION = "crm.stage.create";
export const RENAME_STAGE_ACTION = "crm.stage.rename";
export const REORDER_STAGES_ACTION = "crm.stage.reorder";
export const ARCHIVE_STAGE_ACTION = "crm.stage.archive";
export const RESTORE_STAGE_ACTION = "crm.stage.restore";

interface StageRow { id: string; pipeline_id: string; name: string; position: number; archived_at: Date | null }

const owned = async (tx: Transaction, sql: string, params: unknown[]) => (await tx.query(sql, params)).rowCount === 1;
/** At least one row: a name check must not pass because two stages already share a name. */
const exists = async (tx: Transaction, sql: string, params: unknown[]) => ((await tx.query(sql, params)).rowCount ?? 0) > 0;

/** C-25: two edits of one pipeline never interleave. */
async function lockPipeline(tx: Transaction, tenantId: string, pipelineId: string): Promise<void> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('crm-pipeline:' || $1::uuid::text || ':' || $2::uuid::text, 0))",
    [tenantId, pipelineId]);
}

async function loadStage(tx: Transaction, tenantId: string, stageId: string): Promise<StageRow | undefined> {
  return (await tx.query<StageRow>(
    "SELECT id, pipeline_id, name, position, archived_at FROM crm_stages WHERE tenant_id=$1 AND id=$2",
    [tenantId, stageId])).rows[0];
}

/** The stage by ID, then again under the pipeline lock, because an archive may have run between. */
async function loadStageLocked(tx: Transaction, tenantId: string, stageId: string): Promise<StageRow> {
  const first = await loadStage(tx, tenantId, stageId);
  if (!first) throw new TenantDenied();
  await lockPipeline(tx, tenantId, first.pipeline_id);
  return (await loadStage(tx, tenantId, stageId)) ?? first;
}

async function liveCount(tx: Transaction, tenantId: string, pipelineId: string): Promise<number> {
  return Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM crm_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL",
    [tenantId, pipelineId])).rows[0]!.n);
}

async function nextPosition(tx: Transaction, tenantId: string, pipelineId: string): Promise<number> {
  return Number((await tx.query<{ next: string }>(
    "SELECT (coalesce(max(position), -1) + 1)::text AS next FROM crm_stages WHERE tenant_id=$1 AND pipeline_id=$2",
    [tenantId, pipelineId])).rows[0]!.next);
}

async function requireFreeName(tx: Transaction, tenantId: string, pipelineId: string, name: string, exceptId: string | null) {
  const taken = await exists(tx,
    `SELECT 1 FROM crm_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL
        AND lower(name) = lower($3) AND ($4::uuid IS NULL OR id <> $4)`,
    [tenantId, pipelineId, name, exceptId]);
  if (taken) throw new Conflict("Another stage in this pipeline has that name", { reason: "name_in_use" });
}

async function requireRoom(tx: Transaction, tenantId: string, pipelineId: string) {
  if (await liveCount(tx, tenantId, pipelineId) >= MAX_LIVE_STAGES)
    throw new Conflict(`A pipeline holds at most ${MAX_LIVE_STAGES} stages`, { reason: "stage_limit", limit: MAX_LIVE_STAGES });
}

/** C-27: archived stages stay for good, so a pipeline also holds a bounded number of stages in all. */
async function requireTotalRoom(tx: Transaction, tenantId: string, pipelineId: string) {
  const total = Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM crm_stages WHERE tenant_id=$1 AND pipeline_id=$2", [tenantId, pipelineId])).rows[0]!.n);
  if (total >= MAX_TOTAL_STAGES)
    throw new Conflict(`A pipeline holds at most ${MAX_TOTAL_STAGES} stages, archived ones included`, { reason: "stage_limit", limit: MAX_TOTAL_STAGES });
}

async function answer(tx: Transaction, tenantId: string, pipelineId: string): Promise<{ result: PipelineSummary }> {
  const pipeline = await getPipeline(tx, tenantId, pipelineId);
  if (!pipeline) throw new TenantDenied();
  return { result: pipeline };
}

/** An existing owned stage is the target; anything else is TenantDenied (C-25). */
const stageTarget: ActionHandler["resolveTarget"] = async (tx, target) =>
  target.type === "stage" && await owned(tx, "SELECT 1 FROM crm_stages WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])
    ? { tenantId: target.tenantId, type: "stage", id: target.id }
    : null;

/** A move or archive racing a deal ends in the database's refusal; give it the same answer as the pre-check. */
const mapStageError: ActionHandler["mapError"] = (error) => {
  if (pgCode(error) !== "23514") return undefined;
  if (pgConstraint(error) === "crm_stages_archive_empty")
    return new Conflict("The stage still holds deals", { reason: "stage_has_deals" });
  if (pgConstraint(error) === "crm_deals_stage_live")
    return new Conflict("The stage is archived", { reason: "stage_archived" });
  // inbox-home.md H-1 revision 4: a deal stored under the old currency check cannot move until its value is fixed.
  if (pgConstraint(error) === "crm_deals_currency_code")
    return new Conflict("A deal's currency is not an ISO 4217 code; set its value first", { reason: "invalid_currency" });
  return undefined;
};

export const createStageHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "stage" || !(await tenantVisible(tx, target.tenantId))) return null;
    if (await owned(tx, "SELECT 1 FROM crm_stages WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]))
      throw idInUse("stage");
    return { tenantId: target.tenantId, type: "stage", id: target.id };
  },
  async handle({ tx, command, binding }) {
    const { payload: input } = parseOrFail(createStageCommandSchema, command);
    const tenantId = binding.tenantId;
    if (!(await owned(tx, "SELECT 1 FROM crm_pipelines WHERE tenant_id=$1 AND id=$2", [tenantId, input.pipelineId])))
      throw new TenantDenied();
    await lockPipeline(tx, tenantId, input.pipelineId);
    await requireFreeName(tx, tenantId, input.pipelineId, input.name, null);
    await requireRoom(tx, tenantId, input.pipelineId);
    await requireTotalRoom(tx, tenantId, input.pipelineId);
    await tx.query(
      "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,$4,$5,$6)",
      [tenantId, input.stageId, input.pipelineId, input.name, await nextPosition(tx, tenantId, input.pipelineId), input.outcome]);
    return answer(tx, tenantId, input.pipelineId);
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "crm_stages_pkey")
      return new Conflict("The stage ID is already in use", { reason: "id_in_use", postgresCode: "23505", constraint: "crm_stages_pkey" });
    return undefined;
  },
};

export const renameStageHandler: ActionHandler = {
  resolveTarget: stageTarget,
  async handle({ tx, command, binding }) {
    const { payload: input } = parseOrFail(renameStageCommandSchema, command);
    const tenantId = binding.tenantId;
    const stage = await loadStageLocked(tx, tenantId, input.stageId);
    if (stage.archived_at !== null) throw new Conflict("The stage is archived", { reason: "stage_archived" });
    if (stage.name !== input.name) {
      await requireFreeName(tx, tenantId, stage.pipeline_id, input.name, stage.id);
      await tx.query("UPDATE crm_stages SET name=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, stage.id, input.name]);
    }
    return answer(tx, tenantId, stage.pipeline_id);
  },
};

export const reorderStagesHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    return target.type === "pipeline"
      && await owned(tx, "SELECT 1 FROM crm_pipelines WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])
      ? { tenantId: target.tenantId, type: "pipeline", id: target.id }
      : null;
  },
  async handle({ tx, command, binding }) {
    const { payload: input } = parseOrFail(reorderStagesCommandSchema, command);
    const tenantId = binding.tenantId;
    await lockPipeline(tx, tenantId, input.pipelineId);
    const stages = (await tx.query<{ id: string; archived_at: Date | null }>(
      "SELECT id, archived_at FROM crm_stages WHERE tenant_id=$1 AND pipeline_id=$2 ORDER BY position, id",
      [tenantId, input.pipelineId])).rows;
    const live = new Set(stages.filter((stage) => stage.archived_at === null).map((stage) => stage.id));
    // C-29: the caller's list must be exactly today's live stages, or someone changed the pipeline.
    if (live.size !== input.stageIds.length || input.stageIds.some((id) => !live.has(id)))
      throw new Conflict("The pipeline's stages changed", { reason: "stage_set_changed" });
    const order = [...input.stageIds, ...stages.filter((stage) => stage.archived_at !== null).map((stage) => stage.id)];
    // The unique position constraint is checked row by row: lift every stage clear of 0..n-1, then place.
    const lift = await nextPosition(tx, tenantId, input.pipelineId);
    await tx.query("UPDATE crm_stages SET position = position + $3 WHERE tenant_id=$1 AND pipeline_id=$2",
      [tenantId, input.pipelineId, lift]);
    await tx.query(
      `UPDATE crm_stages s SET position = v.pos
         FROM unnest($3::uuid[], $4::int[]) AS v(id, pos)
        WHERE s.tenant_id=$1 AND s.pipeline_id=$2 AND s.id = v.id`,
      [tenantId, input.pipelineId, order, order.map((_, index) => index)]);
    return answer(tx, tenantId, input.pipelineId);
  },
};

export const archiveStageHandler: ActionHandler = {
  resolveTarget: stageTarget,
  async handle({ tx, command, binding, now }) {
    const at = clockInstant(now);
    const { payload: input } = parseOrFail(archiveStageCommandSchema, command);
    const tenantId = binding.tenantId;
    const stage = await loadStageLocked(tx, tenantId, input.stageId);
    if (stage.archived_at !== null) return answer(tx, tenantId, stage.pipeline_id);
    if (input.moveDealsTo === stage.id) throw new ValidationFailed("Deals cannot move to the stage being archived");
    if (input.moveDealsTo !== null) {
      const destination = await loadStage(tx, tenantId, input.moveDealsTo);
      if (!destination) throw new TenantDenied();
      if (destination.pipeline_id !== stage.pipeline_id)
        throw new ValidationFailed("The destination stage does not belong to the pipeline");
      if (destination.archived_at !== null) throw new Conflict("The destination stage is archived", { reason: "stage_archived" });
    }
    if (await liveCount(tx, tenantId, stage.pipeline_id) <= 1)
      throw new Conflict("A pipeline keeps at least one stage", { reason: "last_stage" });
    const dealCount = Number((await tx.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM crm_deals WHERE tenant_id=$1 AND stage_id=$2", [tenantId, stage.id])).rows[0]!.n);
    if (dealCount > 0) {
      if (input.moveDealsTo === null)
        throw new Conflict("The stage holds deals; choose where they go", { reason: "stage_has_deals", dealCount });
      await tx.query(
        `UPDATE crm_deals SET stage_id=$3, revision=revision+1, updated_at=$4
          WHERE tenant_id=$1 AND stage_id=$2 AND revision < 9007199254740991`,
        [tenantId, stage.id, input.moveDealsTo, at]);
    }
    await tx.query("UPDATE crm_stages SET archived_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, stage.id, at]);
    return answer(tx, tenantId, stage.pipeline_id);
  },
  mapError: mapStageError,
};

export const restoreStageHandler: ActionHandler = {
  resolveTarget: stageTarget,
  async handle({ tx, command, binding }) {
    const { payload: input } = parseOrFail(restoreStageCommandSchema, command);
    const tenantId = binding.tenantId;
    const stage = await loadStageLocked(tx, tenantId, input.stageId);
    if (stage.archived_at === null) return answer(tx, tenantId, stage.pipeline_id);
    await requireRoom(tx, tenantId, stage.pipeline_id);
    await requireFreeName(tx, tenantId, stage.pipeline_id, stage.name, stage.id);
    await tx.query("UPDATE crm_stages SET archived_at=NULL, position=$3 WHERE tenant_id=$1 AND id=$2",
      [tenantId, stage.id, await nextPosition(tx, tenantId, stage.pipeline_id)]);
    return answer(tx, tenantId, stage.pipeline_id);
  },
};

export const stageHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CREATE_STAGE_ACTION]: createStageHandler,
  [RENAME_STAGE_ACTION]: renameStageHandler,
  [REORDER_STAGES_ACTION]: reorderStagesHandler,
  [ARCHIVE_STAGE_ACTION]: archiveStageHandler,
  [RESTORE_STAGE_ACTION]: restoreStageHandler,
});

interface StageWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
const run = async (schema: Parameters<typeof parseOrFail>[0], command: unknown, ctx: StageWriteContext): Promise<StageOutput> =>
  parseOrFail(stageOutputSchema, await ctx.dispatch(parseOrFail(schema, command) as ActionCommand));

export const createStage = (command: CreateStageCommand, ctx: StageWriteContext) => run(createStageCommandSchema, command, ctx);
export const renameStage = (command: RenameStageCommand, ctx: StageWriteContext) => run(renameStageCommandSchema, command, ctx);
export const reorderStages = (command: ReorderStagesCommand, ctx: StageWriteContext) => run(reorderStagesCommandSchema, command, ctx);
export const archiveStage = (command: ArchiveStageCommand, ctx: StageWriteContext) => run(archiveStageCommandSchema, command, ctx);
export const restoreStage = (command: RestoreStageCommand, ctx: StageWriteContext) => run(restoreStageCommandSchema, command, ctx);
