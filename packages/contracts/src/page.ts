import { z } from "zod";

/** Query strings arrive as text; coerce, then bound. */
export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  /**
   * Where the page starts: the previous page's `nextCursor`. Unlike `offset`, rows added or
   * moved ahead of it while a caller pages do not repeat or skip rows after it. Opaque, and
   * only meaningful for the same list and sort; not combined with an offset.
   */
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/, "Not a page cursor").optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** One page of a list route. */
export const pageSchema = <Item extends z.ZodType>(item: Item) => z.strictObject({
  items: z.array(item),
  limit: z.number().int(),
  offset: z.number().int(),
  /** The next page by offset; null on the last page and when this page was read by cursor. */
  nextOffset: z.number().int().nullable(),
  /** The next page by cursor, which stays put when rows are added ahead of it; null on the last page. */
  nextCursor: z.string().nullable(),
});
