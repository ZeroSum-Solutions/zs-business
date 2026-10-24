import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { CURRENCY_CODES } from "@zs/contracts";
import { migrate } from "../src/migrate.js";
import { asService } from "../src/scoped.js";
import { withTestDatabase } from "../src/testing.js";
import { expectedOwner } from "./owners.js";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);

/**
 * Migrations shipped on main, with the checksum the runner records when it applies them.
 * A database migrated at main holds these rows, so an edit to one fails every upgrade with
 * "Applied migration changed". Change the schema in a new migration instead. Add an entry
 * when a migration lands on main; never edit one.
 */
const shipped: Record<string, string> = {
  "20261017150322_shared_actions.sql": "365f66a76d36be9b93b77a5fee56cc059709d9092ecbc399f26439cb9bac576b",
  "20261017155900_dispatcher_owner_role.sql": "65962246bd4270269b28441cbb414f4e53c6c2bd8030538fd212b8e3fd8faf55",
  "20261017160000_dispatcher_boundary.sql": "e41a17d1a0d0af604d92d4f983e25e38280e2c10234d25a07cd2fecba1a708ed",
  "20261017170000_booking.sql": "a58d0d558bb560fbccc61a15726ad628132caefa77781a1414b9e142cd62d093",
  "20261017170100_crm.sql": "4b90ad716bce286e447d56c84edbb11b2d33dbbc8ff1b69c494219086e583ec9",
  "20261018090000_function_hardening.sql": "104a8c4f9dd25a76eadd4500e92f524535967d153a6b4863ff623e7a6466dca2",
  "20261018120000_booking_multi_resource.sql": "715a1a92788f566562c6cff962583a3ca7de2bce8f2d4789c483699641a6ba14",
  // Ships with the audit fixes; frozen here so the commit that lands it cannot drift.
  "20261018180000_read_indexes.sql": "ed61fd5d247f4389bf03b33c401718bdda5bd7624d311ba7b2b9032c75f8134e",
  // Frozen ahead of landing (REVIEW r1 on #9): any later intake change ships as a new migration.
  "20261018200000_public_intake.sql": "85d553cabf471202999f1872a853d15c59e84fe213186dc07d71a506fd30ab97",
  // M2a auth (#8).
  "20261019090000_members_and_sessions.sql": "ea534900166381f1665ab4cf173882bc0f94e5c5ef0c0f7449acb0f12f08ad30",
  // M3b approvals and source records (#12).
  "20261020100000_approvals.sql": "6cc3330683f223a71ace1235d550edfe5142b71b7f2ece4533e0d4c8f4939e87",
  "20261020100100_source_records.sql": "8aa230cd0371b4841c73cef4937b2a79cc57797a2dae870a08bd8625af276b27",
  // M3c inbox and home (#13).
  "20261020200000_inbox_home.sql": "58201a2358a7da916f36d547f170551536bada26c7be55c4751a1572f266b1fa",
  // M3d wallet and delivery (#14).
  "20261020300000_wallet_and_delivery.sql": "6604e6ffea01774b25b497c0a01e02d4e04e6183cc98dc12dd52bc6feb4d4bd7",
  // Shared public rate limiter (#16).
  "20261020400000_public_rate_limits.sql": "a67ceae100ca08b7346c4668300e9a3fdcf89a51eb98134285d60809b033e333",
  // M4b site releases (#17).
  "20261020700000_site_releases.sql": "74d642bd382324eb07556c4e7c238be307aea7bbd7453d933f894e52fd94a51b",
  "20261020710000_site_release_numbers.sql": "7d6d864b54115011989fcd18af88038ef712abc2319189434a6ed3d591efe4ce",
  "20261020800000_followup_agent.sql": "95869333255fb52335210a2641e621a9dc9030ed5ce26d11758eb26a6eb0977a",
  // M5 Activepieces (#24).
  "20261020640000_activepieces.sql": "500ead2a2d04a2bab161a792598ee37dbc85af0e97e1aebaecfb9e0333559879",
  // M5 Twilio SMS (#22).
  "20261020620000_twilio_sms.sql": "42e1bcc3da20188caa7441dadaa4eb3151a04fe127e7e2b13642448b0d4def0f",
  // M5 Stripe top-ups (#21).
  "20261020610000_stripe_topups.sql": "9b3022d4b0a94970f2288cf77604e073d66b34e4efacbb9060295b0838a34224",
  // M5 Google Calendar (#23).
  "20261020630000_google_calendar.sql": "cd60300403ddd8c63ae25c3000e452fc11b53ddc47d632f63d8dc48113451d21",
};
/**
 * Main before M3 public intake, with M2a members: the intake migration sorts earlier but is
 * applied after it, since the runner applies every file it has no row for. Later migrations
 * (M3b onward) build on intake, so this state stops at M2a.
 */
const beforeIntake = Object.keys(shipped).filter((name) =>
  name !== "20261018200000_public_intake.sql" && name <= "20261019090000_members_and_sessions.sql");
/** Main before M2a members (#8): bookings, contacts and resources exist, members do not. */
const beforeMembers = beforeIntake.filter((name) => name !== "20261019090000_members_and_sessions.sql");
/** Main before the read indexes (the audit fixes). */
const beforeReadIndexes = beforeMembers.filter((name) => name !== "20261018180000_read_indexes.sql");
/** Main before multi-resource booking (#3). */
const beforeMultiResource = beforeReadIndexes.filter((name) => name !== "20261018120000_booking_multi_resource.sql");
/** Main before the hardening follow-ups (#2): the state hosted databases upgraded from. */
const beforeHardening = beforeMultiResource.filter((name) =>
  !["20261017155900_dispatcher_owner_role.sql", "20261018090000_function_hardening.sql"].includes(name));
const checksum = async (name: string) =>
  createHash("sha256").update(await readFile(new URL(name, migrations), "utf8")).digest("hex");

it("keeps every shipped migration byte for byte", async () => {
  const actual: Record<string, string> = {};
  for (const name of Object.keys(shipped)) actual[name] = await checksum(name);
  expect(actual).toEqual(shipped);
});

/** Names, owners, grants, settings and definitions of everything the migrations create. */
async function schemaState(pool: Pool) {
  const queries = {
    functions: `SELECT p.oid::regprocedure::text AS fn, p.proowner::regrole::text AS owner, p.prosecdef,
      p.proconfig, p.proacl::text, pg_get_functiondef(p.oid) AS body
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1`,
    relations: `SELECT c.relname, c.relkind, c.relowner::regrole::text AS owner, c.relacl::text,
      c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace ORDER BY 1`,
    columns: `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
      a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS default, a.attacl::text
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1,2`,
    constraints: `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`,
    indexes: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1",
    policies: `SELECT tablename, policyname, permissive, roles::text, cmd, qual, with_check
      FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`,
    triggers: `SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`,
    schemas: "SELECT nspname, nspowner::regrole::text AS owner, nspacl::text FROM pg_namespace WHERE nspname IN ('public','zs_internal') ORDER BY 1",
  };
  const state: Record<string, unknown[]> = {};
  for (const [key, sql] of Object.entries(queries)) state[key] = (await pool.query(sql)).rows;
  return state;
}

it.each([
  ["main", Object.keys(shipped)],
  ["main before public intake", beforeIntake],
  ["main before members", beforeMembers],
  ["main before the read indexes", beforeReadIndexes],
  ["main before multi-resource booking", beforeMultiResource],
  ["main before the hardening follow-ups", beforeHardening],
])("upgrades a database migrated at %s to the same schema as a fresh install", async (_, baseline) => {
  const atMain = await mkdtemp(join(tmpdir(), "zs-migrations-main-"));
  try {
    for (const name of baseline) {
      // Fail here, not with a misleading pass, if a shipped file was edited.
      expect(await checksum(name), name).toBe(shipped[name]);
      await copyFile(new URL(name, migrations), join(atMain, name));
    }
    const upgraded = await withTestDatabase(async (database) => {
      await migrate(database.pool);
      const applied = await database.pool.query<{ name: string }>(
        "SELECT name FROM zs_internal.schema_migrations ORDER BY name",
      );
      expect(applied.rows.map((row) => row.name)).toEqual(
        (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort(),
      );
      return schemaState(database.pool);
    }, undefined, { migrations: pathToFileURL(`${atMain}/`) });
    const fresh = await withTestDatabase((database) => schemaState(database.pool));
    expect(upgraded.functions).toHaveLength(29);
    expect(upgraded).toEqual(fresh);
  } finally {
    await rm(atMain, { recursive: true, force: true });
  }
}, 30000);

it("the full chain applies as a non-superuser CREATEROLE migrator and hands functions to their owner roles", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ fn: string; owner: string; definer: boolean }>(`
      SELECT p.oid::regprocedure::text AS fn, p.proowner::regrole::text AS owner, p.prosecdef AS definer
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1`);
    expect(rows.map((row) => row.fn)).toEqual(expect.arrayContaining([
      "booking_resources_time_zone_known()", expect.stringMatching(/^record_action_and_event\(/),
    ]));
    for (const row of rows) {
      expect(row.owner).toBe(expectedOwner(row));
    }
    const tables = await database.pool.query<{ owner: string }>(
      "SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname='public'",
    );
    expect(tables.rows).toEqual([{ owner: database.migrator }]);
  }, undefined, { nonSuperuserMigrator: true });
});

it("creates our roles naming NOLOGIN only, as hosted Supabase's supautils requires", async () => {
  // Each CREATE ROLE sits behind IF NOT EXISTS, so only a role's first one in migration
  // order ever runs. The shipped 20261017160000 still names NO* attributes; 20261017155900
  // creates zs_dispatcher before it.
  const first: Record<string, string> = {};
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    const source = await readFile(new URL(name, migrations), "utf8");
    for (const statement of source.match(/CREATE ROLE zs_\w+[^;]*;/g) ?? []) {
      first[statement.split(" ")[2]!] ??= statement;
    }
  }
  expect(first).toEqual({
    zs_dispatcher: "CREATE ROLE zs_dispatcher NOLOGIN;",
    zs_function_owner: "CREATE ROLE zs_function_owner NOLOGIN;",
    zs_rate_limiter: "CREATE ROLE zs_rate_limiter NOLOGIN;",
  });
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

it("adds public intake over a pre-M3 database that holds bookings and contacts", async () => {
  const partial = await mkdtemp(join(tmpdir(), "zs-migrations-pre-m3-"));
  try {
    for (const name of beforeIntake) await copyFile(new URL(name, migrations), join(partial, name));
    const after = await withTestDatabase(async (database) => {
      const tenantId = randomUUID();
      const resourceId = randomUUID();
      await asService(database.servicePool, async (tx) => {
        await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant')", [tenantId]);
        await tx.query(
          `INSERT INTO booking_resources (tenant_id,id,name,time_zone,slot_length_minutes,slot_step_minutes,
             buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
           VALUES ($1,$2,'Room','UTC',60,60,0,0,0,20160)`, [tenantId, resourceId]);
        await tx.query(
          `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,
             buffer_before_minutes,buffer_after_minutes,status,created_at)
           VALUES ($1,$2,$3,'2026-10-19T09:00Z','2026-10-19T10:00Z','2026-10-19T09:00Z','2026-10-19T10:00Z',0,0,
             'confirmed','2026-10-18T09:00Z')`, [tenantId, randomUUID(), resourceId]);
        await tx.query(
          `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at)
           VALUES ($1,$2,'Mira Rowe','mira@haldenrowe.example','2026-10-18T09:00Z','2026-10-18T09:00Z')`,
          [tenantId, randomUUID()]);
      });
      // Every remaining migration, as the non-superuser migrator hosted databases use.
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name >= "20261018200000"))
        await copyFile(new URL(name, migrations), join(partial, name));
      const url = new URL(database.url);
      url.username = database.migrator!;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      try {
        await migrate(migrator, pathToFileURL(`${partial}/`));
      } finally {
        await migrator.end();
      }
      return asService(database.servicePool, async (tx) => ({
        bookings: (await tx.query("SELECT source, intake_item_id FROM bookings")).rows,
        contacts: (await tx.query("SELECT display_name FROM crm_contacts")).rows,
      }));
    }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true });
    expect(after).toEqual({ bookings: [{ source: "owner", intake_item_id: null }], contacts: [{ display_name: "Mira Rowe" }] });
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}, 30000);

it("numbers the releases a database already holds, per site and in the order they were made", async () => {
  const numbers = "20261020710000_site_release_numbers.sql";
  const partial = await mkdtemp(join(tmpdir(), "zs-migrations-pre-numbers-"));
  try {
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < numbers))
      await copyFile(new URL(name, migrations), join(partial, name));
    const tenants = [randomUUID(), randomUUID()];
    const sites = [randomUUID(), randomUUID(), randomUUID()];
    // [tenant, site, release, created_at]: out of order on disk, and two at one instant (id breaks the tie).
    const [low, high] = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const releases: [number, number, string, string][] = [
      [0, 0, randomUUID(), "2026-10-20T12:00Z"], [0, 0, high, "2026-10-20T11:00Z"], [0, 0, low, "2026-10-20T11:00Z"],
      [0, 1, randomUUID(), "2026-10-20T09:00Z"], [1, 2, randomUUID(), "2026-10-20T08:00Z"],
    ];
    const after = await withTestDatabase(async (database) => {
      await asService(database.servicePool, async (tx) => {
        for (const tenantId of tenants) await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant')", [tenantId]);
        for (const [i, siteId] of sites.entries())
          await tx.query("INSERT INTO sites (tenant_id,id,name,created_at,updated_at) VALUES ($1,$2,'Site',now(),now())", [tenants[i === 2 ? 1 : 0], siteId]);
        for (const [tenant, site, id, createdAt] of releases)
          await tx.query(
            `INSERT INTO site_releases (tenant_id,id,site_id,spec,entry,file_count,total_bytes,created_by,created_at)
             VALUES ($1,$2,$3,'{}','index.html',1,1,$4,$5)`, [tenants[tenant], id, sites[site], randomUUID(), createdAt]);
      });
      await copyFile(new URL(numbers, migrations), join(partial, numbers));
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name > numbers))
        await copyFile(new URL(name, migrations), join(partial, name));
      // As the non-superuser migrator hosted databases use, which forced RLS would blind.
      const url = new URL(database.url);
      url.username = database.migrator!;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      try {
        await migrate(migrator, pathToFileURL(`${partial}/`));
      } finally {
        await migrator.end();
      }
      const state = await database.pool.query<{ force: boolean; enabled: string }>(
        `SELECT c.relforcerowsecurity AS force, t.tgenabled AS enabled FROM pg_class c
           JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname='site_releases_append_only' WHERE c.oid='public.site_releases'::regclass`);
      return {
        state: state.rows,
        numbers: await asService(database.servicePool, async (tx) =>
          (await tx.query<{ id: string; number: number }>("SELECT id, number FROM site_releases")).rows),
      };
    }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true });
    expect(after.state).toEqual([{ force: true, enabled: "O" }]);
    const byId = Object.fromEntries(after.numbers.map((row) => [row.id, row.number]));
    expect(releases.map(([, , id]) => byId[id])).toEqual([3, 2, 1, 1, 1]);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}, 30000);

it("a dry run rolls back, and an apply commits only the set the dry run reported", async () => {
  const atMain = await mkdtemp(join(tmpdir(), "zs-migrations-dry-"));
  try {
    for (const name of beforeHardening) await copyFile(new URL(name, migrations), join(atMain, name));
    await withTestDatabase(async (database) => {
      const names = async () => (await database.pool.query<{ name: string }>(
        "SELECT name FROM zs_internal.schema_migrations ORDER BY name")).rows.map((row) => row.name);
      const before = await names();
      const pending = await migrate(database.pool, migrations, { dryRun: true });
      expect(pending.map((row) => row.name)).toEqual(Object.keys(shipped).filter((name) => !before.includes(name))
        .concat((await readdir(migrations)).filter((name) => name.endsWith(".sql") && !(name in shipped))).sort());
      expect(await names()).toEqual(before);
      // A file that changed after the dry run (here: a stale checksum) rolls back the apply.
      const stale = pending.map((row, index) => index === 0 ? { ...row, checksum: "0".repeat(64) } : row);
      await expect(migrate(database.pool, migrations, { expect: stale })).rejects.toThrow(/differ from the expected set/);
      expect(await names()).toEqual(before);
      expect(await migrate(database.pool, migrations, { expect: pending })).toEqual(pending);
      expect(await names()).toEqual([...before, ...pending.map((row) => row.name)].sort());
    }, undefined, { migrations: pathToFileURL(`${atMain}/`) });
  } finally {
    await rm(atMain, { recursive: true, force: true });
  }
}, 30000);

const currencyIso = "20261022520000_deal_currency_iso.sql";
const currencyPreflight = new URL("../../../supabase/preflight/20261022520000_deal_currency_iso.sql", import.meta.url);
/**
 * Applies migrations before the ISO currency check, stores one deal per currency (as the old
 * three-capitals check allowed), then runs the rest as the non-superuser migrator.
 */
async function migrateOverStoredCurrencies(currencies: string[]) {
  const partial = await mkdtemp(join(tmpdir(), "zs-migrations-pre-currency-"));
  try {
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < currencyIso))
      await copyFile(new URL(name, migrations), join(partial, name));
    return await withTestDatabase(async (database) => {
      const tenantId = randomUUID();
      const [contactId, pipelineId, stageId] = [randomUUID(), randomUUID(), randomUUID()];
      const deals = Object.fromEntries(currencies.map((currency) => [currency, randomUUID()]));
      await asService(database.servicePool, async (tx) => {
        await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant')", [tenantId]);
        await tx.query(
          `INSERT INTO crm_contacts (tenant_id,id,display_name,created_at,updated_at)
           VALUES ($1,$2,'Mira Rowe','2026-10-18T09:00Z','2026-10-18T09:00Z')`, [tenantId, contactId]);
        await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
        await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0)", [tenantId, stageId, pipelineId]);
        for (const [currency, id] of Object.entries(deals))
          await tx.query(
            `INSERT INTO crm_deals (tenant_id,id,contact_id,pipeline_id,stage_id,title,revision,created_at,updated_at,value_minor,currency)
             VALUES ($1,$2,$3,$4,$5,'Commission',1,'2026-10-18T09:00Z','2026-10-18T09:00Z',1234,$6)`,
            [tenantId, id, contactId, pipelineId, stageId, currency]);
      });
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name >= currencyIso))
        await copyFile(new URL(name, migrations), join(partial, name));
      const url = new URL(database.url);
      url.username = database.migrator!;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      const notices: string[] = [];
      migrator.on("connect", (client) => client.on("notice", (notice) => notices.push(notice.message ?? "")));
      try {
        await migrate(migrator, pathToFileURL(`${partial}/`));
      } finally {
        await migrator.end();
      }
      const check = await database.pool.query<{ validated: boolean }>(
        "SELECT convalidated AS validated FROM pg_constraint WHERE conrelid='public.crm_deals'::regclass AND conname='crm_deals_currency_code'");
      const preflight = await readFile(currencyPreflight, "utf8");
      return {
        validated: check.rows[0]!.validated,
        notices: notices.filter((message) => message.includes("crm_deals")),
        // The owner's read-only preflight, as service_role (BYPASSRLS), the role it names.
        offending: await asService(database.servicePool, async (tx) =>
          (await tx.query<{ tenant_id: string; id: string; currency: string }>(preflight)).rows),
        stored: await asService(database.servicePool, async (tx) =>
          (await tx.query<{ id: string; currency: string }>("SELECT id, currency FROM crm_deals ORDER BY currency")).rows),
        // New and updated rows are checked at once, validated or not.
        write: await asService(database.servicePool, (tx) => tx.query(
          "UPDATE crm_deals SET currency='QQQ' WHERE tenant_id=$1 AND id=$2", [tenantId, deals.USD])).then(() => "ok", (error: { code?: string }) => error.code),
        tenantId,
        deals,
      };
    }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true });
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}

it("upgrades over a deal with a non-ISO currency: the check stays unvalidated and the preflight lists the row", async () => {
  const after = await migrateOverStoredCurrencies(["USD", "ZZZ"]);
  expect(after.validated).toBe(false);
  expect(after.notices).toEqual([expect.stringMatching(/^crm_deals holds 1 deal/)]);
  expect(after.offending).toEqual([expect.objectContaining({ tenant_id: after.tenantId, id: after.deals.ZZZ, currency: "ZZZ" })]);
  // The migration rewrites and deletes nothing.
  expect(after.stored).toEqual([{ id: after.deals.USD, currency: "USD" }, { id: after.deals.ZZZ, currency: "ZZZ" }]);
  expect(after.write).toBe("23514");
}, 30000);

it("validates the currency check at once when every stored deal passes", async () => {
  const after = await migrateOverStoredCurrencies(["USD", "EUR"]);
  expect(after).toMatchObject({ validated: true, notices: [], offending: [], write: "23514" });
}, 30000);

it("the currency preflight checks the same ISO 4217 list as the contract", async () => {
  const preflight = await readFile(currencyPreflight, "utf8");
  expect([...preflight.matchAll(/'([A-Z]{3})'/g)].map((match) => match[1]).sort()).toEqual([...CURRENCY_CODES].sort());
});
