// The HTTP client edits stages with POST routes under /v1/crm, the key in the header, and sorts the
// pipeline it gets back by position (crm.md C-32).
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const PIPELINE = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000b1";
const A = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000c1";
const B = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000c2";
interface Call { url: URL; init: RequestInit }
function client(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "/api",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const KEY = { idempotencyKey: "00000000-0000-4000-8000-000000000001" };
const answer = { actionId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000f1", result: {
  id: PIPELINE, name: "Sales",
  stages: [{ id: B, name: "Won", position: 1, outcome: "won" }, { id: A, name: "Inquiry", position: 0, outcome: "open" }],
  archivedStages: [],
} };
const body = (call: Call) => JSON.parse(String(call.init.body));

describe("http client: stage editor", () => {
  it("creates a stage with a POST and returns the stages in order", async () => {
    const { api, calls } = client([json(201, answer)]);
    const result = await api.createStage({ pipelineId: PIPELINE, name: "Quote", outcome: "open" }, KEY);
    expect(result.stages.map((stage) => stage.name)).toEqual(["Inquiry", "Won"]);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/crm/pipelines/${PIPELINE}/stages`);
    expect(body(calls[0]!)).toEqual({ name: "Quote", outcome: "open" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY.idempotencyKey);
  });

  it("renames, reorders, archives and restores on their own routes", async () => {
    const { api, calls } = client([json(200, answer), json(200, answer), json(200, answer), json(200, answer)]);
    await api.renameStage({ stageId: A, name: "Enquiry" }, KEY);
    await api.reorderStages({ pipelineId: PIPELINE, stageIds: [B, A] }, KEY);
    await api.archiveStage({ stageId: A, moveDealsTo: B }, KEY);
    await api.restoreStage({ stageId: A }, KEY);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      `/api/v1/crm/stages/${A}/rename`, `/api/v1/crm/pipelines/${PIPELINE}/stages/order`,
      `/api/v1/crm/stages/${A}/archive`, `/api/v1/crm/stages/${A}/restore`,
    ]);
    expect(calls.map(body)).toEqual([{ name: "Enquiry" }, { stageIds: [B, A] }, { moveDealsTo: B }, {}]);
  });

  it("surfaces stage_has_deals as a conflict with its reason", async () => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "Deals are in the stage", details: { reason: "stage_has_deals", dealCount: 2 } } })]);
    await expect(api.archiveStage({ stageId: A, moveDealsTo: null }, KEY)).rejects.toMatchObject({ kind: "conflict", reason: "stage_has_deals" });
  });
});
