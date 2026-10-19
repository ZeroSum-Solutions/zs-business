import type { PageQuery } from "@zs/contracts";

/**
 * Callers fetch limit + 1 rows; the extra row only signals that another page exists.
 * `cursorAfter(index)` is the cursor that starts after `items[index]`.
 */
export function page<Item>(rows: readonly Item[], query: PageQuery, cursorAfter: (index: number) => string) {
  const more = rows.length > query.limit;
  return {
    items: rows.slice(0, query.limit),
    limit: query.limit,
    offset: query.offset,
    nextOffset: more && query.cursor === undefined ? query.offset + query.limit : null,
    nextCursor: more ? cursorAfter(query.limit - 1) : null,
  };
}
