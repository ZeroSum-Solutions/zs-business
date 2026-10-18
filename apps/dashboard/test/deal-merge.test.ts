import { describe, expect, it } from "vitest";
import type { DealRecord } from "../src/lib/api";
import { completeList } from "../src/lib/api/types";
import { preferNewerDeals } from "../src/lib/deal-merge";

const deal = (id: string, revision: number, stageId: string): DealRecord => ({
  id, tenantId: "t", contactId: "c", pipelineId: "p", stageId, title: id, revision,
  createdAt: "2026-10-01T12:00:00.000Z", updatedAt: `2026-10-0${revision}T12:00:00.000Z`,
});

describe("preferNewerDeals", () => {
  it("keeps a moved deal when a refetch that left before the move lands after it", () => {
    const afterMove = completeList([deal("a", 3, "won"), deal("b", 1, "new")]);
    const lateRefetch = completeList([deal("a", 2, "quoted"), deal("b", 1, "new")]);
    const merged = preferNewerDeals(afterMove, lateRefetch);
    expect(merged.items.map((item) => [item.id, item.revision, item.stageId])).toEqual([["a", 3, "won"], ["b", 1, "new"]]);
  });

  it("takes newer revisions, new deals and dropped deals from the server", () => {
    const held = completeList([deal("a", 2, "quoted"), deal("gone", 1, "new")]);
    const fresh = { items: [deal("a", 4, "lost"), deal("c", 1, "new")], incomplete: true, loaded: 2 };
    expect(preferNewerDeals(held, fresh)).toEqual(fresh);
    expect(preferNewerDeals(undefined, fresh)).toBe(fresh);
  });
});
