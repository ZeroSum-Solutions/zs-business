import { expect, it } from "vitest";
import { withTestDatabase } from "../src/testing.js";

it("the full chain applies as a non-superuser CREATEROLE migrator and hands functions to their owner roles", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ fn: string; owner: string; definer: boolean }>(`
      SELECT p.oid::regprocedure::text AS fn, p.proowner::regrole::text AS owner, p.prosecdef AS definer
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1`);
    expect(rows.map((row) => row.fn)).toEqual(expect.arrayContaining([
      "booking_resources_time_zone_known()", expect.stringMatching(/^record_action_and_event\(/),
    ]));
    for (const row of rows) {
      expect(row.owner).toBe(row.definer ? "zs_dispatcher" : "zs_function_owner");
    }
    const tables = await database.pool.query<{ owner: string }>(
      "SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname='public'",
    );
    expect(tables.rows).toEqual([{ owner: database.migrator }]);
  }, undefined, { nonSuperuserMigrator: true });
});
