// Every CRM, intake and source writer checks the injected clock before it touches the
// database: outside UTC years 0001 through 9999 the instant cannot be stored exactly.
import { describe, expect, it } from "vitest";
import { ValidationFailed, type ActionBinding, type ActionCommand } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { crmHandlers, dealDetailsHandlers, intakeHandlers, sourceHandlers } from "../src/index.js";

const writers = { ...crmHandlers, ...dealDetailsHandlers, ...intakeHandlers, ...sourceHandlers };

describe("clock range in CRM, intake and source writers", () => {
  it.each(Object.keys(writers))("%s refuses a clock outside UTC years 0001-9999 before any query", async (actionType) => {
    for (const clock of ["0000-06-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"]) {
      const queries: string[] = [];
      const tx = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as Transaction;
      const error = await writers[actionType]!.handle({
        tx, command: {} as ActionCommand, binding: {} as ActionBinding, now: new Date(clock), clock: () => new Date(clock), config: {}, generateId: () => "",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ValidationFailed);
      expect((error as Error).message).toMatch(/outside UTC years 0001 through 9999/);
      expect(queries).toEqual([]);
    }
  });
});
