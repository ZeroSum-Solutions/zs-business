import { replaceEqualDeep } from "@tanstack/react-query";
import type { DealRecord, ListResult } from "./api";

/**
 * Revisions only go up on the server. A refetch that left before a move can land after it,
 * carrying the deal's old revision; keeping the higher revision per deal stops that answer
 * from rolling the board back and making the next move fail as stale.
 */
export function preferNewerDeals<T extends DealRecord>(previous: ListResult<T> | undefined, next: ListResult<T>): ListResult<T> {
  if (!previous) return next;
  const known = new Map(previous.items.map((deal) => [deal.id, deal]));
  const items = next.items.map((deal) => {
    const held = known.get(deal.id);
    return held && held.revision > deal.revision ? held : deal;
  });
  return replaceEqualDeep(previous, { ...next, items });
}
