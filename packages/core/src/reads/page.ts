import type { PageQuery } from "@zs/contracts";

/** Callers fetch limit + 1 rows; the extra row only signals that another page exists. */
export function page<Item>(rows: readonly Item[], query: PageQuery) {
  const more = rows.length > query.limit;
  return {
    items: rows.slice(0, query.limit),
    limit: query.limit,
    offset: query.offset,
    nextOffset: more ? query.offset + query.limit : null,
  };
}
