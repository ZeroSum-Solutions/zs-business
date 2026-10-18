import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { asService } from "../src/scoped.js";
import { withTestDatabase } from "../src/testing.js";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);

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

it("creates our roles naming NOLOGIN only, as hosted Supabase's supautils requires", async () => {
  const statements: string[] = [];
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql"))) {
    const source = await readFile(new URL(name, migrations), "utf8");
    statements.push(...(source.match(/CREATE ROLE zs_\w+[^;]*;/g) ?? []));
  }
  expect(statements).toEqual(["CREATE ROLE zs_dispatcher NOLOGIN;", "CREATE ROLE zs_function_owner NOLOGIN;"]);
});

/** Applies migrations before 20261018090000, stores one resource, then runs the rest as the migrator. */
async function migrateOverStoredZone(timeZone: string) {
  const partial = await mkdtemp(join(tmpdir(), "zs-migrations-"));
  try {
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name < "20261018090000") {
        await copyFile(new URL(name, migrations), join(partial, name));
      }
    }
    return await withTestDatabase(async (database) => {
      const tenantId = randomUUID();
      await asService(database.servicePool, async (tx) => {
        await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant')", [tenantId]);
        await tx.query(
          `INSERT INTO booking_resources (tenant_id,id,time_zone,slot_length_minutes,slot_step_minutes,
             buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
           VALUES ($1,$2,$3,30,30,0,0,0,60)`, [tenantId, randomUUID(), timeZone]);
      });
      const url = new URL(database.url);
      url.username = database.migrator!;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      try {
        await migrate(migrator);
      } finally {
        await migrator.end();
      }
      const stored = await database.pool.query("SELECT time_zone FROM booking_resources");
      const force = await database.pool.query("SELECT relforcerowsecurity AS force FROM pg_class WHERE oid='public.booking_resources'::regclass");
      return { rows: stored.rows, force: force.rows[0].force };
    }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true });
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}

it("migrates over an existing booking resource whose zone is a lowercase IANA name", async () => {
  expect(await migrateOverStoredZone("america/new_york"))
    .toEqual({ rows: [{ time_zone: "america/new_york" }], force: true });
});

it("refuses to migrate over a stored unknown zone, though forced RLS hides rows from the migrator", async () => {
  await expect(migrateOverStoredZone("Foo/Bar")).rejects.toThrow(/holds unknown time zones/);
});
