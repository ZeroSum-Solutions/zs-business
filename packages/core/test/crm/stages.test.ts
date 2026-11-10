// crm.md C-25..C-33: the pipeline stage editor through the session and the shared dispatcher under the
// runtime role. Real Postgres: names, order under the unique position constraint, archive with and without
// deals, the deal refusals, the database triggers, replay, permissions and two-tenant denial.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, type MemberRole, type PipelineSummary } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, type EdgeDependencies, type Session } from "../../src/index.js";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");

let database: TestDatabase;
let fixture: TwoTenantFixture;
let owner: string;
let staff: string;
let ownerB: string;
let a: Session;
let b: Session;
let contactId: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock: { now: () => new Date(NOW) }, generateId: randomUUID });
const sessionFor = (actorId: string, tenantId = fixture.a.tenantId): Session => createSession(deps(), { tenantId, actorId });

async function addMember(tenantId: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(NOW)],
  ));
  return userId;
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}
async function sqlRejection(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try { await promise; } catch (error) { return error as { code?: string; constraint?: string }; }
  throw new Error("Expected a rejection");
}

/** A fresh pipeline with the named stages, seeded as the service role (the way setup does). */
async function pipeline(tenantId: string, names: string[], outcomes: Record<string, "won" | "lost"> = {}) {
  const id = randomUUID();
  const stageIds: string[] = [];
  await fixture.service(async (tx) => {
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3)", [tenantId, id, `Sales ${id.slice(0, 6)}`]);
    for (const [position, name] of names.entries()) {
      const stageId = randomUUID();
      stageIds.push(stageId);
      await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,$4,$5,$6)",
        [tenantId, stageId, id, name, position, outcomes[name] ?? "open"]);
    }
  });
  return { id, stageIds };
}
const names = (view: PipelineSummary) => view.stages.map((stage) => stage.name);
const view = async (id: string) => (await a.listPipelines()).find((item) => item.id === id)!;
async function deal(pipelineId: string, stageId: string, title = "Deal") {
  return (await a.createDeal({ contactId, pipelineId, stageId, title }, randomUUID())).result;
}
const stageRow = async (id: string) => (await fixture.service((tx) => tx.query<{ position: number; archived_at: Date | null; name: string; outcome: string }>(
  "SELECT position, archived_at, name, outcome FROM crm_stages WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, id]))).rows[0]!;
const eventsFor = async (actionId: string) => Number((await fixture.service((tx) => tx.query<{ n: string }>(
  "SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND action_id=$2", [fixture.a.tenantId, actionId]))).rows[0]!.n);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  owner = await addMember(fixture.a.tenantId, "owner");
  staff = await addMember(fixture.a.tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
  a = sessionFor(staff);
  b = sessionFor(ownerB, fixture.b.tenantId);
  contactId = (await a.upsertContact({ displayName: "Pat Customer", email: "pat@example.com" }, randomUUID())).result.contact.id;
});
afterAll(async () => { await database?.close(); });

describe("create (C-27)", () => {
  it("adds a stage last, trims the name, keeps the outcome and answers with the whole pipeline", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Won"], { Won: "won" });
    const done = await a.createStage(p.id, { name: "  Proposal sent  ", outcome: "open" }, randomUUID());
    expect(done.result.id).toBe(p.id);
    expect(names(done.result)).toEqual(["New", "Won", "Proposal sent"]);
    expect(done.result.archivedStages).toEqual([]);
    expect(done.result.stages.map((stage) => stage.position)).toEqual([0, 1, 2]);
    expect(await eventsFor(done.actionId)).toBe(1);
    const lost = await a.createStage(p.id, { name: "Lost", outcome: "lost" }, randomUUID());
    expect(lost.result.stages.at(-1)).toMatchObject({ name: "Lost", outcome: "lost" });
  });

  it("defaults the outcome to open", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New"]);
    const done = await a.createStage(p.id, { name: "Next" }, randomUUID());
    expect(done.result.stages.at(-1)).toMatchObject({ name: "Next", outcome: "open" });
  });

  it("refuses a name another live stage has, whatever its case, and allows an archived stage's name", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Old"]);
    const dup = await rejection(a.createStage(p.id, { name: "  nEW " }, randomUUID()));
    expect(dup).toMatchObject({ code: "Conflict", details: { reason: "name_in_use" } });
    await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    expect(names((await a.createStage(p.id, { name: "Old" }, randomUUID())).result)).toEqual(["New", "Old"]);
  });

  it("stops at 30 live stages", async () => {
    const p = await pipeline(fixture.a.tenantId, Array.from({ length: 30 }, (_, n) => `Stage ${n}`));
    expect(await rejection(a.createStage(p.id, { name: "One more" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_limit" } });
  });

  it("rejects an empty, multi-line or oversized name and an unknown outcome before it writes", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New"]);
    for (const body of [{ name: "   " }, { name: "a\nb" }, { name: "x".repeat(101) }, { name: "ok", outcome: "maybe" }, { name: "ok", extra: 1 }])
      expect(await rejection(a.createStage(p.id, body, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect(names(await view(p.id))).toEqual(["New"]);
  });

  it("appends after archived stages, so positions stay unique", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C"]);
    await a.archiveStage(p.stageIds[2]!, {}, randomUUID());
    const done = await a.createStage(p.id, { name: "D" }, randomUUID());
    expect(done.result.stages.map((stage) => [stage.name, stage.position])).toEqual([["A", 0], ["B", 1], ["D", 3]]);
  });
});

describe("rename (C-28)", () => {
  it("renames, keeps position and outcome, and is a no-op for the same name", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Won"], { Won: "won" });
    const done = await a.renameStage(p.stageIds[1]!, { name: " Closed won " }, randomUUID());
    expect(done.result.stages[1]).toMatchObject({ name: "Closed won", position: 1, outcome: "won" });
    const same = await a.renameStage(p.stageIds[1]!, { name: "Closed won" }, randomUUID());
    expect(names(same.result)).toEqual(["New", "Closed won"]);
  });

  it("refuses a live stage's name and an archived stage", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Open", "Gone"]);
    expect(await rejection(a.renameStage(p.stageIds[0]!, { name: "open" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "name_in_use" } });
    await a.archiveStage(p.stageIds[2]!, {}, randomUUID());
    expect(await rejection(a.renameStage(p.stageIds[2]!, { name: "Back" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_archived" } });
  });
});

describe("reorder (C-29)", () => {
  it("rewrites the order under the unique position constraint and keeps archived stages last", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C", "D"]);
    await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    const [sa, , sc, sd] = p.stageIds;
    const done = await a.reorderStages(p.id, { stageIds: [sd!, sa!, sc!] }, randomUUID());
    expect(done.result.stages.map((stage) => [stage.name, stage.position])).toEqual([["D", 0], ["A", 1], ["C", 2]]);
    expect(done.result.archivedStages.map((stage) => [stage.name, stage.position])).toEqual([["B", 3]]);
    expect(names(await view(p.id))).toEqual(["D", "A", "C"]);
  });

  it("swaps two stages and reverses a long pipeline", async () => {
    const p = await pipeline(fixture.a.tenantId, Array.from({ length: 12 }, (_, n) => `S${n}`));
    const reversed = [...p.stageIds].reverse();
    const done = await a.reorderStages(p.id, { stageIds: reversed }, randomUUID());
    expect(done.result.stages.map((stage) => stage.id)).toEqual(reversed);
  });

  it("refuses a list that misses a live stage, adds an archived or foreign one, or repeats one", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C"]);
    const other = await pipeline(fixture.a.tenantId, ["X"]);
    await a.archiveStage(p.stageIds[2]!, {}, randomUUID());
    const [sa, sb, sc] = p.stageIds;
    for (const stageIds of [[sa!], [sa!, sb!, sc!], [sa!, sb!, other.stageIds[0]!], [sa!, sb!, randomUUID()]])
      expect(await rejection(a.reorderStages(p.id, { stageIds }, randomUUID())))
        .toMatchObject({ code: "Conflict", details: { reason: "stage_set_changed" } });
    expect(await rejection(a.reorderStages(p.id, { stageIds: [sa!, sa!] }, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect(names(await view(p.id))).toEqual(["A", "B"]);
  });
});

describe("archive and restore (C-30)", () => {
  it("archives an empty stage: it leaves the board, keeps its row and its name, and the clock stamps it", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Spare"]);
    const done = await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    expect(names(done.result)).toEqual(["New"]);
    expect(done.result.archivedStages.map((stage) => stage.name)).toEqual(["Spare"]);
    expect((await stageRow(p.stageIds[1]!)).archived_at?.toISOString()).toBe(new Date(NOW).toISOString());
    // Archiving again changes nothing.
    const again = await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    expect(again.result).toEqual(done.result);
  });

  it("refuses a stage that holds deals until the owner says where they go, and writes nothing", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Busy"]);
    await deal(p.id, p.stageIds[1]!);
    await deal(p.id, p.stageIds[1]!);
    const refused = await rejection(a.archiveStage(p.stageIds[1]!, {}, randomUUID()));
    expect(refused).toMatchObject({ code: "Conflict", details: { reason: "stage_has_deals", dealCount: 2 } });
    expect((await stageRow(p.stageIds[1]!)).archived_at).toBeNull();
  });

  it("moves the deals with the archive, bumping each revision, and reports the new board", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Busy"]);
    const one = await deal(p.id, p.stageIds[1]!, "One");
    await deal(p.id, p.stageIds[1]!, "Two");
    const done = await a.archiveStage(p.stageIds[1]!, { moveDealsTo: p.stageIds[0]! }, randomUUID());
    expect(names(done.result)).toEqual(["New"]);
    const deals = (await a.listDeals({ pipelineId: p.id })).items;
    expect(deals.map((item) => item.stageId)).toEqual([p.stageIds[0], p.stageIds[0]]);
    expect(deals.find((item) => item.id === one.id)!.revision).toBe(one.revision + 1);
    expect(deals.every((item) => item.updatedAt === new Date(NOW).toISOString())).toBe(true);
  });

  it("checks the destination: itself, archived, another pipeline, a foreign or unknown stage", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C"]);
    const other = await pipeline(fixture.a.tenantId, ["X"]);
    const foreign = await pipeline(fixture.b.tenantId, ["F"]);
    await a.archiveStage(p.stageIds[2]!, {}, randomUUID());
    const [sa, sb, sc] = p.stageIds;
    expect(await rejection(a.archiveStage(sb!, { moveDealsTo: sb! }, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect(await rejection(a.archiveStage(sb!, { moveDealsTo: sc! }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_archived" } });
    expect(await rejection(a.archiveStage(sb!, { moveDealsTo: other.stageIds[0]! }, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
    expect(await rejection(a.archiveStage(sb!, { moveDealsTo: foreign.stageIds[0]! }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(a.archiveStage(sb!, { moveDealsTo: randomUUID() }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect((await stageRow(sb!)).archived_at).toBeNull();
    expect(sa).toBeDefined();
  });

  it("keeps at least one live stage", async () => {
    const p = await pipeline(fixture.a.tenantId, ["Only"]);
    expect(await rejection(a.archiveStage(p.stageIds[0]!, {}, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "last_stage" } });
  });

  it("restores a stage to the end, is a no-op for a live stage, and refuses a name now taken", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C"]);
    await a.archiveStage(p.stageIds[0]!, {}, randomUUID());
    const back = await a.restoreStage(p.stageIds[0]!, randomUUID());
    expect(names(back.result)).toEqual(["B", "C", "A"]);
    expect(back.result.archivedStages).toEqual([]);
    expect((await a.restoreStage(p.stageIds[0]!, randomUUID())).result).toEqual(back.result);
    await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    await a.createStage(p.id, { name: "B" }, randomUUID());
    expect(await rejection(a.restoreStage(p.stageIds[1]!, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "name_in_use" } });
  });

  it("refuses a restore past the 30 stage limit", async () => {
    const p = await pipeline(fixture.a.tenantId, Array.from({ length: 30 }, (_, n) => `S${n}`));
    await a.archiveStage(p.stageIds[0]!, {}, randomUUID());
    await a.createStage(p.id, { name: "Extra" }, randomUUID());
    expect(await rejection(a.restoreStage(p.stageIds[0]!, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_limit" } });
  });
});

describe("deals and archived stages (C-31)", () => {
  it("create and move refuse an archived stage with stage_archived", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Gone", "Next"]);
    const live = await deal(p.id, p.stageIds[0]!);
    await a.archiveStage(p.stageIds[1]!, {}, randomUUID());
    expect(await rejection(a.createDeal({ contactId, pipelineId: p.id, stageId: p.stageIds[1]!, title: "X" }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_archived" } });
    expect(await rejection(a.moveDealStage(live.id, { pipelineId: p.id, stageId: p.stageIds[1]!, expectedRevision: live.revision }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stage_archived" } });
    const moved = await a.moveDealStage(live.id, { pipelineId: p.id, stageId: p.stageIds[2]!, expectedRevision: live.revision }, randomUUID());
    expect(moved.result.stageId).toBe(p.stageIds[2]);
  });

  it("the database refuses both on its own, whoever writes", async () => {
    const p = await pipeline(fixture.a.tenantId, ["New", "Busy", "Gone"]);
    await a.archiveStage(p.stageIds[2]!, {}, randomUUID());
    const sql = (text: string, params: unknown[]) => fixture.service((tx) => tx.query(text, params));
    expect(await sqlRejection(sql(
      "INSERT INTO crm_deals (tenant_id,id,contact_id,pipeline_id,stage_id,title,revision,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'x',1,now(),now())",
      [fixture.a.tenantId, randomUUID(), contactId, p.id, p.stageIds[2]!]))).toMatchObject({ code: "23514", constraint: "crm_deals_stage_live" });
    await deal(p.id, p.stageIds[1]!);
    expect(await sqlRejection(sql("UPDATE crm_stages SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, p.stageIds[1]!])))
      .toMatchObject({ code: "23514", constraint: "crm_stages_archive_empty" });
  });

  it("a deal move racing an archive ends in one clean refusal, never a deal in an archived stage", async () => {
    for (let round = 0; round < 6; round += 1) {
      const p = await pipeline(fixture.a.tenantId, ["New", "Target"]);
      const d = await deal(p.id, p.stageIds[0]!);
      const results = await Promise.allSettled([
        a.moveDealStage(d.id, { pipelineId: p.id, stageId: p.stageIds[1]!, expectedRevision: d.revision }, randomUUID()),
        a.archiveStage(p.stageIds[1]!, {}, randomUUID()),
      ]);
      const stage = await stageRow(p.stageIds[1]!);
      const dealStage = (await a.listDeals({ pipelineId: p.id })).items[0]!.stageId;
      if (stage.archived_at !== null) expect(dealStage).not.toBe(p.stageIds[1]);
      else expect(results[1]!.status).toBe("rejected");
      for (const result of results)
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ActionError);
          expect(["stage_has_deals", "stage_archived"]).toContain((result.reason as ActionError).details?.reason);
        }
    }
  });

  it("an archive that moves deals racing a create into that stage never strands a deal", async () => {
    for (let round = 0; round < 6; round += 1) {
      const p = await pipeline(fixture.a.tenantId, ["New", "Busy"]);
      await deal(p.id, p.stageIds[1]!);
      const results = await Promise.allSettled([
        a.archiveStage(p.stageIds[1]!, { moveDealsTo: p.stageIds[0]! }, randomUUID()),
        a.createDeal({ contactId, pipelineId: p.id, stageId: p.stageIds[1]!, title: "Late" }, randomUUID()),
      ]);
      const stranded = await fixture.service((tx) => tx.query(
        "SELECT 1 FROM crm_deals d JOIN crm_stages s ON s.tenant_id=d.tenant_id AND s.id=d.stage_id WHERE d.tenant_id=$1 AND d.pipeline_id=$2 AND s.archived_at IS NOT NULL",
        [fixture.a.tenantId, p.id]));
      expect(stranded.rowCount).toBe(0);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ActionError);
    }
  });
});

describe("reads (C-32)", () => {
  it("listPipelines puts live stages in `stages` and archived ones in `archivedStages`, by position", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B", "C"]);
    await a.archiveStage(p.stageIds[0]!, {}, randomUUID());
    const listed = await view(p.id);
    expect(names(listed)).toEqual(["B", "C"]);
    expect(listed.archivedStages.map((stage) => stage.name)).toEqual(["A"]);
  });
});

describe("idempotency (C-25)", () => {
  it("replays each action to the same stored answer and writes once", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B"]);
    const key = randomUUID();
    const first = await a.createStage(p.id, { name: "C" }, key);
    const replay = await a.createStage(p.id, { name: "C" }, key);
    expect(replay.actionId).toBe(first.actionId);
    expect(names(await view(p.id))).toEqual(["A", "B", "C"]);
    const archiveKey = randomUUID();
    const archived = await a.archiveStage(p.stageIds[0]!, {}, archiveKey);
    await a.restoreStage(p.stageIds[0]!, randomUUID());
    expect((await a.archiveStage(p.stageIds[0]!, {}, archiveKey)).actionId).toBe(archived.actionId);
    expect(names(await view(p.id))).toEqual(["B", "C", "A"]);
  });

  it("the same key with a different body is an idempotency conflict", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A"]);
    const key = randomUUID();
    await a.createStage(p.id, { name: "B" }, key);
    expect(await rejection(a.createStage(p.id, { name: "C" }, key))).toMatchObject({ code: "IdempotencyConflict" });
  });
});

describe("who may edit (C-25)", () => {
  it("someone who is not a member cannot; an owner and staff can", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B"]);
    const v = sessionFor(randomUUID());
    expect(await rejection(v.createStage(p.id, { name: "C" }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(v.renameStage(p.stageIds[0]!, { name: "Z" }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(v.archiveStage(p.stageIds[0]!, {}, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(v.restoreStage(p.stageIds[0]!, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(v.reorderStages(p.id, { stageIds: [p.stageIds[1]!, p.stageIds[0]!] }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(names(await view(p.id))).toEqual(["A", "B"]);
    expect(names((await sessionFor(owner).createStage(p.id, { name: "C" }, randomUUID())).result)).toEqual(["A", "B", "C"]);
  });
});

describe("two tenants (C-33)", () => {
  it("tenant B cannot touch tenant A's pipeline or stages, and learns nothing about them", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B"]);
    const attempts: Array<() => Promise<unknown>> = [
      () => b.createStage(p.id, { name: "Mine" }, randomUUID()),
      () => b.renameStage(p.stageIds[0]!, { name: "Mine" }, randomUUID()),
      () => b.reorderStages(p.id, { stageIds: [p.stageIds[1]!, p.stageIds[0]!] }, randomUUID()),
      () => b.archiveStage(p.stageIds[0]!, {}, randomUUID()),
      () => b.restoreStage(p.stageIds[0]!, randomUUID()),
    ];
    for (const attempt of attempts) expect(await rejection(attempt())).toMatchObject({ code: "TenantDenied" });
    expect(names(await view(p.id))).toEqual(["A", "B"]);
    expect((await b.listPipelines()).some((item) => item.id === p.id)).toBe(false);
  });

  it("a stage ID in use in another tenant is unused here (C-1), and a foreign move target is denied", async () => {
    const mine = await pipeline(fixture.a.tenantId, ["A", "B"]);
    const theirs = await pipeline(fixture.b.tenantId, ["X"]);
    await deal(mine.id, mine.stageIds[1]!);
    expect(await rejection(a.archiveStage(mine.stageIds[1]!, { moveDealsTo: theirs.stageIds[0]! }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
  });

  it("the runtime role cannot write another tenant's stages, delete a stage, or change its outcome or pipeline", async () => {
    const p = await pipeline(fixture.a.tenantId, ["A", "B"]);
    const theirs = await pipeline(fixture.b.tenantId, ["X"]);
    const crossed = await fixture.a.run((tx) => tx.query("UPDATE crm_stages SET name='Hacked' WHERE id=$1", [theirs.stageIds[0]!]));
    expect(crossed.rowCount).toBe(0);
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'Z',9)",
      [fixture.b.tenantId, randomUUID(), theirs.id])))).toMatchObject({ code: "42501" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("DELETE FROM crm_stages WHERE id=$1", [p.stageIds[0]!])))).toMatchObject({ code: "42501" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE crm_stages SET outcome='won' WHERE id=$1", [p.stageIds[0]!])))).toMatchObject({ code: "42501" });
    expect(await sqlRejection(fixture.a.run((tx) => tx.query("UPDATE crm_stages SET pipeline_id=$2 WHERE id=$1", [p.stageIds[0]!, theirs.id])))).toMatchObject({ code: "42501" });
    expect((await stageRow(p.stageIds[0]!)).outcome).toBe("open");
  });
});
