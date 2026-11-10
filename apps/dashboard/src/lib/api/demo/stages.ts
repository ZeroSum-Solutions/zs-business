/**
 * The demo adapter's stage editor (crm.md C-25..C-32). It keeps the rules the API enforces: names are
 * unique among live stages, a pipeline holds 30, reorder lists every live stage, a stage with deals
 * needs a destination, the last stage stays, and deals never enter an archived stage. Each call answers
 * with the whole pipeline. The data is in memory and starts again on every page load.
 */
import type { z } from "zod";
import {
  archiveStageRequestSchema, createStageRequestSchema, MAX_LIVE_STAGES, MAX_TOTAL_STAGES, renameStageRequestSchema, reorderStagesRequestSchema,
  type DealSummary, type PipelineSummary, type StageSummary,
} from "@zs/contracts";
import { demoError } from "../errors";
import type { CrmApi, WriteOptions } from "../types";

export interface DemoStagesContext {
  now(): Date;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  newId(): string;
  pipelines(): PipelineSummary[];
  setPipelines(next: PipelineSummary[]): void;
  deals: Map<string, DealSummary>;
}

type StageCalls = Pick<CrmApi, "createStage" | "renameStage" | "reorderStages" | "archiveStage" | "restoreStage">;

export function createDemoStages(ctx: DemoStagesContext): StageCalls {
  const clone = <T>(value: T): T => structuredClone(value);
  const nextPosition = (pipeline: PipelineSummary) =>
    Math.max(-1, ...pipeline.stages.map((stage) => stage.position), ...pipeline.archivedStages.map((stage) => stage.position)) + 1;
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  function pipelineOf(id: string): PipelineSummary {
    const pipeline = ctx.pipelines().find((item) => item.id === id);
    if (!pipeline) throw demoError("Forbidden");
    return pipeline;
  }
  function locate(stageId: string): { pipeline: PipelineSummary; stage: StageSummary; archived: boolean } {
    for (const pipeline of ctx.pipelines()) {
      const live = pipeline.stages.find((item) => item.id === stageId);
      if (live) return { pipeline, stage: live, archived: false };
      const gone = pipeline.archivedStages.find((item) => item.id === stageId);
      if (gone) return { pipeline, stage: gone, archived: true };
    }
    throw demoError("Forbidden");
  }
  const requireFreeName = (pipeline: PipelineSummary, name: string, exceptId: string | null) => {
    if (pipeline.stages.some((item) => item.id !== exceptId && sameName(item.name, name)))
      throw demoError("Conflict", { reason: "name_in_use" });
  };
  const requireRoom = (pipeline: PipelineSummary) => {
    if (pipeline.stages.length >= MAX_LIVE_STAGES) throw demoError("Conflict", { reason: "stage_limit" });
  };
  const requireTotalRoom = (pipeline: PipelineSummary) => {
    if (pipeline.stages.length + pipeline.archivedStages.length >= MAX_TOTAL_STAGES) throw demoError("Conflict", { reason: "stage_limit" });
  };
  const commit = (pipeline: PipelineSummary) => {
    ctx.setPipelines(ctx.pipelines().map((item) => (item.id === pipeline.id ? pipeline : item)));
    return clone(pipeline);
  };

  return {
    createStage(input, options) {
      return ctx.idempotent("crm.stage.create", input, options, () => {
        const { pipelineId, ...body } = input;
        const request = ctx.parse(createStageRequestSchema, body);
        const pipeline = clone(pipelineOf(pipelineId));
        requireFreeName(pipeline, request.name, null);
        requireRoom(pipeline);
        requireTotalRoom(pipeline);
        pipeline.stages.push({ id: ctx.newId(), name: request.name, position: nextPosition(pipeline), outcome: request.outcome });
        return commit(pipeline);
      });
    },

    renameStage(input, options) {
      return ctx.idempotent("crm.stage.rename", input, options, () => {
        const { stageId, ...body } = input;
        const request = ctx.parse(renameStageRequestSchema, body);
        const found = locate(stageId);
        if (found.archived) throw demoError("Conflict", { reason: "stage_archived" });
        const pipeline = clone(found.pipeline);
        const stage = pipeline.stages.find((item) => item.id === stageId)!;
        if (stage.name !== request.name) {
          requireFreeName(pipeline, request.name, stageId);
          stage.name = request.name;
        }
        return commit(pipeline);
      });
    },

    reorderStages(input, options) {
      return ctx.idempotent("crm.stage.reorder", input, options, () => {
        const { pipelineId, ...body } = input;
        const request = ctx.parse(reorderStagesRequestSchema, body);
        const pipeline = clone(pipelineOf(pipelineId));
        const live = new Set(pipeline.stages.map((item) => item.id));
        if (live.size !== request.stageIds.length || request.stageIds.some((id) => !live.has(id)))
          throw demoError("Conflict", { reason: "stage_set_changed" });
        const byId = new Map(pipeline.stages.map((item) => [item.id, item]));
        pipeline.stages = request.stageIds.map((id, index) => ({ ...byId.get(id)!, position: index }));
        pipeline.archivedStages = pipeline.archivedStages.map((item, index) => ({ ...item, position: request.stageIds.length + index }));
        return commit(pipeline);
      });
    },

    archiveStage(input, options) {
      return ctx.idempotent("crm.stage.archive", input, options, () => {
        const { stageId, ...body } = input;
        const request = ctx.parse(archiveStageRequestSchema, body);
        const found = locate(stageId);
        const pipeline = clone(found.pipeline);
        if (found.archived) return clone(pipeline);
        const to = request.moveDealsTo;
        if (to === stageId) throw demoError("ValidationFailed", { issues: [{ path: "moveDealsTo", message: "Deals cannot move to the stage being archived" }] });
        if (to !== null) {
          const target = locate(to);
          if (target.pipeline.id !== pipeline.id) throw demoError("ValidationFailed", { issues: [{ path: "moveDealsTo", message: "The destination stage does not belong to the pipeline" }] });
          if (target.archived) throw demoError("Conflict", { reason: "stage_archived" });
        }
        if (pipeline.stages.length <= 1) throw demoError("Conflict", { reason: "last_stage" });
        const held = [...ctx.deals.values()].filter((deal) => deal.stageId === stageId);
        if (held.length > 0) {
          if (to === null) throw demoError("Conflict", { reason: "stage_has_deals", dealCount: held.length });
          const at = ctx.now().toISOString();
          const won = pipeline.stages.find((item) => item.id === to)?.outcome === "won";
          for (const deal of held)
            ctx.deals.set(deal.id, { ...deal, stageId: to, revision: deal.revision + 1, updatedAt: at, wonAt: won ? (deal.wonAt ?? at) : null });
        }
        const stage = pipeline.stages.find((item) => item.id === stageId)!;
        pipeline.stages = pipeline.stages.filter((item) => item.id !== stageId);
        pipeline.archivedStages = [...pipeline.archivedStages, stage].sort((a, b) => a.position - b.position);
        return commit(pipeline);
      });
    },

    restoreStage(input, options) {
      return ctx.idempotent("crm.stage.restore", input, options, () => {
        const found = locate(input.stageId);
        const pipeline = clone(found.pipeline);
        if (!found.archived) return clone(pipeline);
        requireRoom(pipeline);
        requireFreeName(pipeline, found.stage.name, null);
        // The position counts the archived stage too, as the server's max(position) + 1 does.
        const position = nextPosition(pipeline);
        pipeline.archivedStages = pipeline.archivedStages.filter((item) => item.id !== input.stageId);
        pipeline.stages.push({ ...found.stage, position });
        return commit(pipeline);
      });
    },
  };
}
