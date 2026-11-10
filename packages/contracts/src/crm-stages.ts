import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { stageOutcomeSchema } from "./home.js";
import { isPostgresText } from "./json.js";

// Root re-exports this module; defer access to the shared schema until parsing.
const idSchema = z.lazy(() => uuidSchema);

/** crm.md C-27: at most this many live stages in one pipeline. */
export const MAX_LIVE_STAGES = 30;

/** crm.md C-27: trimmed, 1 to 100 characters, one line. */
export const stageNameSchema = z.string().trim().min(1).max(100)
  .refine((name) => !/[\r\n\u2028\u2029]/.test(name), "A stage name is one line")
  .refine(isPostgresText, "Invalid Postgres text");

export const stageSummarySchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  position: z.number().int(),
  outcome: stageOutcomeSchema,
});
export type StageSummary = z.infer<typeof stageSummarySchema>;

/** crm.md C-32: live stages in `stages`, archived ones in `archivedStages`, both by position. */
export const pipelineSummarySchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  stages: z.array(stageSummarySchema),
  // Default empty: an API from before the stage editor omits it, and a newer dashboard still reads its list.
  archivedStages: z.array(stageSummarySchema).default([]),
});
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;

const stageResult = z.lazy(() => actionResultSchema.extend({ result: pipelineSummarySchema }));

export const createStageInputSchema = z.strictObject({
  stageId: idSchema,
  pipelineId: idSchema,
  name: stageNameSchema,
  outcome: stageOutcomeSchema,
});
export const createStageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.stage.create"),
  target: targetSchema.extend({ type: z.literal("stage") }),
  payload: createStageInputSchema,
}).refine((command) => command.target.id === command.payload.stageId, "Target must equal the pre-minted stage ID"));
export type CreateStageCommand = z.infer<typeof createStageCommandSchema>;

export const renameStageInputSchema = z.strictObject({ stageId: idSchema, name: stageNameSchema });
export const renameStageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.stage.rename"),
  target: targetSchema.extend({ type: z.literal("stage") }),
  payload: renameStageInputSchema,
}).refine((command) => command.target.id === command.payload.stageId, "Target must equal the stage ID"));
export type RenameStageCommand = z.infer<typeof renameStageCommandSchema>;

export const reorderStagesInputSchema = z.strictObject({
  pipelineId: idSchema,
  stageIds: z.array(idSchema).min(1).max(MAX_LIVE_STAGES)
    .refine((ids) => new Set(ids).size === ids.length, "Each stage appears once"),
});
export const reorderStagesCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.stage.reorder"),
  target: targetSchema.extend({ type: z.literal("pipeline") }),
  payload: reorderStagesInputSchema,
}).refine((command) => command.target.id === command.payload.pipelineId, "Target must equal the pipeline ID"));
export type ReorderStagesCommand = z.infer<typeof reorderStagesCommandSchema>;

export const archiveStageInputSchema = z.strictObject({ stageId: idSchema, moveDealsTo: idSchema.nullable() });
export const archiveStageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.stage.archive"),
  target: targetSchema.extend({ type: z.literal("stage") }),
  payload: archiveStageInputSchema,
}).refine((command) => command.target.id === command.payload.stageId, "Target must equal the stage ID"));
export type ArchiveStageCommand = z.infer<typeof archiveStageCommandSchema>;

export const restoreStageInputSchema = z.strictObject({ stageId: idSchema });
export const restoreStageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.stage.restore"),
  target: targetSchema.extend({ type: z.literal("stage") }),
  payload: restoreStageInputSchema,
}).refine((command) => command.target.id === command.payload.stageId, "Target must equal the stage ID"));
export type RestoreStageCommand = z.infer<typeof restoreStageCommandSchema>;

export const stageOutputSchema = stageResult;
export type StageOutput = z.infer<typeof stageOutputSchema>;

/** HTTP and MCP bodies (the IDs travel in the path). */
export const createStageRequestSchema = z.strictObject({
  name: stageNameSchema,
  outcome: stageOutcomeSchema.default("open"),
});
export type CreateStageRequest = z.input<typeof createStageRequestSchema>;
export const renameStageRequestSchema = z.strictObject({ name: stageNameSchema });
export type RenameStageRequest = z.infer<typeof renameStageRequestSchema>;
export const reorderStagesRequestSchema = z.strictObject({ stageIds: reorderStagesInputSchema.shape.stageIds });
export type ReorderStagesRequest = z.infer<typeof reorderStagesRequestSchema>;
export const archiveStageRequestSchema = z.strictObject({ moveDealsTo: idSchema.nullable().default(null) });
export type ArchiveStageRequest = z.input<typeof archiveStageRequestSchema>;
