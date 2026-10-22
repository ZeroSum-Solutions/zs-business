import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conflict, TenantDenied, ValidationFailed } from "@zs/contracts";
import { createDeal, createOrFindContact, moveDealStage, setDealDetails } from "../../src/index.js";
import { inLosAngeles } from "../zoned.js";
import { contactCommand, createHarness, dealCommand, detailsCommand, moveCommand, NOW, rejection, type Harness } from "./helpers.js";

let h: Harness;
let a: string;
let b: string;
let contactId: string;
let pipe: { pipelineId: string; stages: [string, string] };
let otherPipe: { pipelineId: string; stages: [string, string] };
let foreign: { pipelineId: string; stages: [string, string]; contactId: string };
const T1 = "2026-10-01T08:00:00.000Z";

beforeAll(async () => {
  h = await createHarness();
  a = h.fixture.a.tenantId;
  b = h.fixture.b.tenantId;
  pipe = await h.seedPipeline(a);
  otherPipe = await h.seedPipeline(a);
  const contact = await createOrFindContact(contactCommand(a, { email: "deal@example.test" }), h.ctx(a));
  contactId = contact.result.contact.id;
  const bPipe = await h.seedPipeline(b);
  const bContact = await createOrFindContact(contactCommand(b, { email: "deal@example.test" }), h.ctx(b));
  foreign = { ...bPipe, contactId: bContact.result.contact.id };
});
afterAll(async () => { await h?.close(); });

const newDeal = async (now = T1) => (await createDeal(dealCommand(a, {
  contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], title: "Consult",
}), h.ctx(a, now))).result;

const readDeal = (id: string) => h.fixture.service(async (tx) => (await tx.query(
  "SELECT stage_id, revision::integer AS revision, updated_at FROM crm_deals WHERE tenant_id=$1 AND id=$2", [a, id])).rows[0]);

describe("deal creation", () => {
  it("C-13: inserts revision 1 with injected timestamps; several deals per contact", async () => {
    const deal = await newDeal(NOW);
    expect(deal).toMatchObject({ tenantId: a, contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], revision: 1, createdAt: NOW, updatedAt: NOW });
    expect((await newDeal()).id).not.toBe(deal.id);
  });

  it("C-13: an owned stage from another pipeline is ValidationFailed", async () => {
    const error = await rejection(createDeal(dealCommand(a, {
      contactId, pipelineId: pipe.pipelineId, stageId: otherPipe.stages[0], title: "Bad",
    }), h.ctx(a)));
    expect(error).toBeInstanceOf(ValidationFailed);
  });

  it("C-1/C-13: foreign parents are TenantDenied, even with a wrong-pipeline stage", async () => {
    for (const payload of [
      { contactId: foreign.contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0] },
      { contactId, pipelineId: foreign.pipelineId, stageId: foreign.stages[0] },
      { contactId, pipelineId: pipe.pipelineId, stageId: foreign.stages[0] },
      { contactId: foreign.contactId, pipelineId: pipe.pipelineId, stageId: otherPipe.stages[0] },
      { contactId: randomUUID(), pipelineId: pipe.pipelineId, stageId: pipe.stages[0] },
    ]) {
      const error = await rejection(createDeal(dealCommand(a, { ...payload, title: "X" }), h.ctx(a)));
      expect(error).toBeInstanceOf(TenantDenied);
    }
  });

  it("C-13/C-18: reusing an owned deal ID is id_in_use; an ID used only in another tenant is free", async () => {
    const deal = await newDeal();
    const error = await rejection(createDeal(dealCommand(a, {
      dealId: deal.id, contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], title: "Again",
    }), h.ctx(a)));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "id_in_use" } });
    const inB = await createDeal(dealCommand(b, {
      dealId: deal.id, contactId: foreign.contactId, pipelineId: foreign.pipelineId, stageId: foreign.stages[0], title: "B",
    }), h.ctx(b));
    expect(inB.result).toMatchObject({ id: deal.id, tenantId: b, revision: 1 });
  });
});

describe("deal clock range", () => {
  it("a year-0001 clock creates and moves a deal with exact timestamps under a non-UTC time zone", async () => {
    const clock = "0001-01-01T00:00:00.000Z";
    await inLosAngeles(h.database, async (db) => {
      const deal = (await createDeal(dealCommand(a, {
        contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], title: "Ancient",
      }), h.ctx(a, clock, db))).result;
      expect(deal).toMatchObject({ createdAt: clock, updatedAt: clock });
      const moved = (await moveDealStage(moveCommand(a, {
        dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 1,
      }), h.ctx(a, clock, db))).result;
      expect(moved).toMatchObject({ revision: 2, createdAt: clock, updatedAt: clock });
      const detailed = (await setDealDetails(detailsCommand(a, {
        dealId: deal.id, expectedRevision: 2, value: { amountMinor: 500, currency: "USD" }, leadSource: null,
      }), h.ctx(a, clock, db))).result;
      expect(detailed).toMatchObject({ revision: 3, createdAt: clock, updatedAt: clock });
    });
  });

  it("a clock outside UTC years 0001-9999 is ValidationFailed and writes nothing", async () => {
    const deal = await newDeal();
    const counts = async () => Promise.all((["actions", "crm_deals"] as const).map((table) => h.count(table, a)));
    const before = await counts();
    for (const clock of ["0000-06-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"]) {
      expect(await rejection(createDeal(dealCommand(a, {
        contactId, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], title: "Out of range",
      }), h.ctx(a, clock)))).toBeInstanceOf(ValidationFailed);
      expect(await rejection(moveDealStage(moveCommand(a, {
        dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 1,
      }), h.ctx(a, clock)))).toBeInstanceOf(ValidationFailed);
      expect(await rejection(setDealDetails(detailsCommand(a, {
        dealId: deal.id, expectedRevision: 1, value: null, leadSource: null,
      }), h.ctx(a, clock)))).toBeInstanceOf(ValidationFailed);
    }
    expect(await counts()).toEqual(before);
    expect(await readDeal(deal.id)).toMatchObject({ revision: 1 });
  });
});

describe("deal stage moves", () => {
  it("C-14/C-15: a move increments revision by one, even to the same stage", async () => {
    const deal = await newDeal();
    const moved = await moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 1,
    }), h.ctx(a, NOW));
    expect(moved.result).toEqual({ ...deal, stageId: pipe.stages[1], revision: 2, updatedAt: NOW });
    const same = await moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 2,
    }), h.ctx(a, NOW));
    expect(same.result.revision).toBe(3);
  });

  it("C-14/C-19: a stale move raises typed Conflict and leaves the deal and history unchanged", async () => {
    const deal = await newDeal();
    await moveDealStage(moveCommand(a, { dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 1 }), h.ctx(a, NOW));
    const before = await readDeal(deal.id);
    const actions = await h.count("actions", a);
    const outbox = await h.count("outbox", a);
    const error = await rejection(moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], expectedRevision: 1,
    }), h.ctx(a, "2026-10-20T08:00:00.000Z")));
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 } });
    expect(await readDeal(deal.id)).toEqual(before);
    expect(before).toMatchObject({ stage_id: pipe.stages[1], revision: 2 });
    expect(await h.count("actions", a)).toBe(actions);
    expect(await h.count("outbox", a)).toBe(outbox);
  });

  it("C-14/C-15: wrong pipeline (even when stale) is ValidationFailed; foreign deal or stage is TenantDenied", async () => {
    const deal = await newDeal();
    expect(await rejection(moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: otherPipe.pipelineId, stageId: otherPipe.stages[1], expectedRevision: 5,
    }), h.ctx(a)))).toBeInstanceOf(ValidationFailed);
    expect(await rejection(moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: otherPipe.stages[1], expectedRevision: 1,
    }), h.ctx(a)))).toBeInstanceOf(ValidationFailed);
    expect(await rejection(moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: foreign.stages[1], expectedRevision: 5,
    }), h.ctx(a)))).toBeInstanceOf(TenantDenied);
    const error = await rejection(moveDealStage(moveCommand(b, {
      dealId: deal.id, pipelineId: foreign.pipelineId, stageId: foreign.stages[1], expectedRevision: 1,
    }), h.ctx(b)));
    expect(error).toBeInstanceOf(TenantDenied);
    expect(error).not.toHaveProperty("details.currentRevision");
    expect((await readDeal(deal.id))!.revision).toBe(1);
  });

  it("C-16: of two concurrent moves from one revision, exactly one commits", async () => {
    const deal = await newDeal();
    const settled = await Promise.allSettled([pipe.stages[1], pipe.stages[0]].map((stageId) =>
      moveDealStage(moveCommand(a, { dealId: deal.id, pipelineId: pipe.pipelineId, stageId, expectedRevision: 1 }), h.ctx(a))));
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 } });
    expect((await readDeal(deal.id))!.revision).toBe(2);
  });

  it("C-16: an exact replay returns its original revision after later moves", async () => {
    const deal = await newDeal();
    const ctx = h.ctx(a);
    const command = moveCommand(a, { dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 1 });
    const first = await moveDealStage(command, ctx);
    await moveDealStage(moveCommand(a, { dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[0], expectedRevision: 2 }), ctx);
    expect(await moveDealStage(command, ctx)).toEqual(first);
    expect(first.result.revision).toBe(2);
    expect((await readDeal(deal.id))!.revision).toBe(3);
  });

  it("C-15: the revision cannot pass the safe-integer boundary", async () => {
    const deal = await newDeal();
    await h.fixture.service((tx) => tx.query("UPDATE crm_deals SET revision=9007199254740991 WHERE tenant_id=$1 AND id=$2", [a, deal.id]));
    const error = await rejection(moveDealStage(moveCommand(a, {
      dealId: deal.id, pipelineId: pipe.pipelineId, stageId: pipe.stages[1], expectedRevision: 9007199254740990,
    }), h.ctx(a)));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 9007199254740991 } });
  });
});
