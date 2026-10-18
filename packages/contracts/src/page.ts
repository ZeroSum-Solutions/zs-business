import { z } from "zod";

/** One page of a list route; `nextOffset` is null on the last page. */
export const pageSchema = <Item extends z.ZodType>(item: Item) => z.strictObject({
  items: z.array(item),
  limit: z.number().int(),
  offset: z.number().int(),
  nextOffset: z.number().int().nullable(),
});
