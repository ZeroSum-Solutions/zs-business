// The demo adapter keeps the API's stage-editor rules (crm.md C-25..C-32): unique live names, a limit of
// 30, a full reorder list, archive needs a destination when deals sit in the stage, the last stage stays,
// restore goes last, and deals never enter an archived stage.
import { describe, expect, it } from "vitest";
import { MAX_LIVE_STAGES } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_PIPELINE } from "../src/lib/api/demo/seed";

const NOW = new Date("2026-10-18T13:00:00.000Z");
function adapter() {
  let ids = 0;
  return createDemoAdapter({
    clock: { now: () => NOW },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
}
let keys = 0;
const key = () => ({ idempotencyKey: `stage-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const PIPELINE = DEMO_PIPELINE.id;
const names = (stages: { name: string }[]) => stages.map((stage) => stage.name);

describe("demo adapter: stage editor", () => {
  it("adds a stage last, refuses a repeated name in any case, and replays one key", async () => {
    const api = adapter();
    const options = key();
    const input = { pipelineId: PIPELINE, name: "  Quote sent ", outcome: "open" } as const;
    const made = await api.createStage(input, options);
    expect(names(made.stages)).toEqual([...names(DEMO_PIPELINE.stages), "Quote sent"]);
    expect(await api.createStage(input, options)).toEqual(made);
    expect(await failure(api.createStage({ pipelineId: PIPELINE, name: "QUOTE SENT" }, key()))).toMatchObject({ kind: "conflict", reason: "name_in_use" });
    expect((await api.listPipelines())[0]!.stages).toHaveLength(DEMO_PIPELINE.stages.length + 1);
  });

  it("stops at the stage limit", async () => {
    const api = adapter();
    for (let n = DEMO_PIPELINE.stages.length; n < MAX_LIVE_STAGES; n += 1) await api.createStage({ pipelineId: PIPELINE, name: `Extra ${n}` }, key());
    expect(await failure(api.createStage({ pipelineId: PIPELINE, name: "One too many" }, key()))).toMatchObject({ kind: "conflict", reason: "stage_limit" });
  });

  it("renames a stage and refuses a name another live stage holds", async () => {
    const api = adapter();
    const renamed = await api.renameStage({ stageId: DEMO_PIPELINE.stages[0]!.id, name: "Enquiry" }, key());
    expect(renamed.stages[0]!.name).toBe("Enquiry");
    expect(await failure(api.renameStage({ stageId: DEMO_PIPELINE.stages[1]!.id, name: "enquiry" }, key()))).toMatchObject({ reason: "name_in_use" });
  });

  it("reorders only with the full set of live stages", async () => {
    const api = adapter();
    const ids = DEMO_PIPELINE.stages.map((stage) => stage.id);
    const flipped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const done = await api.reorderStages({ pipelineId: PIPELINE, stageIds: flipped }, key());
    expect(names(done.stages).slice(0, 2)).toEqual(["Consultation", "Inquiry"]);
    expect(done.stages.map((stage) => stage.position)).toEqual([0, 1, 2, 3, 4]);
    expect(await failure(api.reorderStages({ pipelineId: PIPELINE, stageIds: ids.slice(1) }, key()))).toMatchObject({ reason: "stage_set_changed" });
  });

  it("archives an empty stage, keeps a stage with deals until a destination is named, and restores last", async () => {
    const api = adapter();
    const empty = await api.createStage({ pipelineId: PIPELINE, name: "Scratch" }, key());
    const scratch = empty.stages.at(-1)!;
    const archived = await api.archiveStage({ stageId: scratch.id, moveDealsTo: null }, key());
    expect(names(archived.archivedStages)).toEqual(["Scratch"]);
    expect(names(archived.stages)).not.toContain("Scratch");

    const inquiry = DEMO_PIPELINE.stages[0]!;
    const before = (await api.listDeals({ pipelineId: PIPELINE })).items.filter((deal) => deal.stageId === inquiry.id);
    expect(before.length).toBeGreaterThan(0);
    expect(await failure(api.archiveStage({ stageId: inquiry.id, moveDealsTo: null }, key()))).toMatchObject({ reason: "stage_has_deals" });
    const target = DEMO_PIPELINE.stages[1]!.id;
    await api.archiveStage({ stageId: inquiry.id, moveDealsTo: target }, key());
    const after = await api.listDeals({ pipelineId: PIPELINE });
    for (const deal of before) expect(after.items.find((item) => item.id === deal.id)).toMatchObject({ stageId: target, revision: deal.revision + 1 });

    const restored = await api.restoreStage({ stageId: scratch.id }, key());
    expect(restored.stages.at(-1)!.name).toBe("Scratch");
    expect(names(restored.archivedStages)).toEqual(["Inquiry"]);
  });

  it("keeps the last stage and refuses deals in an archived stage", async () => {
    const api = adapter();
    const [first, ...rest] = DEMO_PIPELINE.stages;
    for (const stage of rest) await api.archiveStage({ stageId: stage.id, moveDealsTo: first!.id }, key());
    expect(await failure(api.archiveStage({ stageId: first!.id, moveDealsTo: null }, key()))).toMatchObject({ reason: "last_stage" });
    const contactId = (await api.listDeals({ pipelineId: PIPELINE })).items[0]!.contactId;
    expect(await failure(api.createDeal({ contactId, pipelineId: PIPELINE, stageId: rest[0]!.id, title: "Late" }, key()))).toMatchObject({ reason: "stage_archived" });
  });
});
