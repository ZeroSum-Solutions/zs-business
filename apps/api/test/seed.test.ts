import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { assertNoHostedSeedArgs, hostedOwnerSteps, seedDemo, seedHostedTenant } from "../src/seed/demo.js";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin.js";
import { FAKE_REF, FAKE_SERVICE_KEY, fakeGoTrue } from "./fake-gotrue.js";
import { formatSeedReport, runtimeTargetFor } from "../src/seed/report.js";
import { clock } from "./helpers.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

describe("demo seed", () => {
  it("seeds the jeweler tenant through the action path and is idempotent", async () => {
    const deps = { service: database.servicePool, runtime: database.runtimePool, clock, generateId: randomUUID };
    const first = await seedDemo(deps);
    expect(first).toMatchObject({ contacts: 12, deals: 8 });
    expect(first.resources.map((resource) => resource.name)).toEqual(["Showroom appointments", "Repair intake"]);
    expect(first.bookings).toBe(6);
    const again = await seedDemo(deps);
    expect(again).toEqual(first);
    const counts = (await database.pool.query<{ actions: number; deals: number; moved: number; detailed: number }>(
      `SELECT (SELECT count(*)::int FROM actions WHERE tenant_id=$1) AS actions,
              (SELECT count(*)::int FROM crm_deals WHERE tenant_id=$1) AS deals,
              (SELECT count(*)::int FROM actions WHERE tenant_id=$1 AND action_type='crm.deal.move-stage') AS moved,
              (SELECT count(*)::int FROM actions WHERE tenant_id=$1 AND action_type='crm.deal.set-details') AS detailed`,
      [first.principal.tenantId],
    )).rows[0];
    // 12 contacts + 8 deals + 6 stage moves + 4 deal details + 6 bookings, each recorded once.
    expect(counts).toEqual({ actions: 36, deals: 8, moved: 6, detailed: 4 });
    // H-2: the seed marks the won stage itself; the deal moved into it carries the seed clock's won date.
    const stages = (await database.pool.query<{ name: string; outcome: string }>(
      "SELECT name, outcome FROM crm_stages WHERE tenant_id=$1 ORDER BY position", [first.principal.tenantId],
    )).rows;
    expect(stages).toEqual([
      { name: "Inquiry", outcome: "open" }, { name: "Consultation", outcome: "open" }, { name: "Design", outcome: "open" },
      { name: "Deposit", outcome: "open" }, { name: "Delivered", outcome: "won" },
    ]);
    const deals = (await database.pool.query<{ title: string; revision: string; value: string | null; currency: string | null; source: string | null; won: Date | null }>(
      `SELECT title, revision::text AS revision, value_minor::text AS value, currency, lead_source AS source, won_at AS won
         FROM crm_deals WHERE tenant_id=$1 ORDER BY title`, [first.principal.tenantId],
    )).rows;
    const won = new Date(clock.now());
    expect(deals).toEqual([
      { title: "Anniversary eternity band", revision: "3", value: "465000", currency: "USD", source: "walk_in", won },
      { title: "Custom pendant, mother's birthstones", revision: "2", value: "120000", currency: "USD", source: "social", won: null },
      { title: "Diamond stud upgrade", revision: "1", value: null, currency: null, source: null, won: null },
      { title: "Engagement ring, oval sapphire halo", revision: "3", value: "840000", currency: "USD", source: "website", won: null },
      { title: "Heirloom brooch restoration", revision: "2", value: null, currency: null, source: null, won: null },
      { title: "Matching wedding bands", revision: "3", value: "290000", currency: "USD", source: "referral", won: null },
      { title: "Pearl strand restring and clasp", revision: "2", value: null, currency: null, source: null, won: null },
      { title: "Signet ring with family crest", revision: "2", value: null, currency: null, source: null, won: null },
    ]);
    // A database seeded before stage outcomes existed gets the won stage on the next run.
    await database.pool.query("UPDATE crm_stages SET outcome='open' WHERE tenant_id=$1", [first.principal.tenantId]);
    expect(await seedDemo(deps)).toEqual(first);
    const restored = await database.pool.query<{ name: string }>(
      "SELECT name FROM crm_stages WHERE tenant_id=$1 AND outcome='won'", [first.principal.tenantId]);
    expect(restored.rows).toEqual([{ name: "Delivered" }]);
    const page = (await database.pool.query<{ published: boolean; resources: number }>(
      `SELECT p.published, (SELECT count(*)::int FROM booking_page_resources r WHERE r.tenant_id=p.tenant_id AND r.page_id=p.id) AS resources
         FROM booking_pages p WHERE p.tenant_id=$1 AND p.id=$2`,
      [first.principal.tenantId, first.bookingPageId],
    )).rows;
    expect(page).toEqual([{ published: true, resources: 2 }]);
  });

  it("refuses remote or unchecked pools before any query", async () => {
    const remote = new Pool({ connectionString: "postgres://postgres@db.abcd.supabase.co:5432/postgres" });
    const overridden = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "db.example.com" });
    const bare = new Pool({ host: "127.0.0.1", port: 55432, user: "postgres", database: "zs_dev" });
    try {
      const cases: [Pool, Pool][] = [
        [remote, database.runtimePool], [database.servicePool, remote], [overridden, database.runtimePool], [bare, database.runtimePool],
      ];
      for (const [service, runtime] of cases)
        await expect(seedDemo({ service, runtime, clock, generateId: randomUUID })).rejects.toThrow(/Refusing to run/);
      for (const pool of [remote, overridden, bare]) expect(pool.totalCount).toBe(0);
    } finally {
      await Promise.all([remote.end(), overridden.end(), bare.end()]);
    }
  });

  it("refuses non-loopback database URLs", () => {
    expect(() => assertLocalDatabaseUrl("postgres://u@db.abcd.supabase.co:5432/postgres")).toThrow(/127.0.0.1 or localhost/);
  });

  it("accepts loopback URLs and reports their effective destination", () => {
    expect(assertLocalDatabaseUrl("postgres://postgres@127.0.0.1:55432/zs_dev")).toMatchObject({
      connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "127.0.0.1", port: "55432", database: "zs_dev", user: "postgres",
    });
    expect(assertLocalDatabaseUrl("postgresql://postgres@localhost/zs_dev").host).toBe("localhost");
    expect(assertLocalDatabaseUrl("postgres://postgres@[::1]:55432/zs_dev").host).toBe("::1");
  });

  // pg (through pg-connection-string) lets query parameters override the URL's host and port.
  it.each([
    "postgres://postgres@127.0.0.1:55432/zs_dev?host=db.example.com",
    "postgres://postgres@127.0.0.1:55432/zs_dev?hostaddr=203.0.113.7",
    "postgres://postgres@127.0.0.1:55432/zs_dev?port=6543",
    "postgres://postgres@127.0.0.1:55432/zs_dev?sslmode=disable",
    "postgres://postgres@localhost/zs_dev?host=%2Fvar%2Frun%2Fremote",
    "postgres://postgres@127.0.0.1,db.example.com:5432/zs_dev",
    "postgres://postgres@%2Fvar%2Frun%2Fpostgresql/zs_dev",
    "postgres://postgres@/zs_dev",
    "socket://postgres@/var/run/postgresql?db=zs_dev",
    "/var/run/postgresql zs_dev",
    "mysql://root@127.0.0.1/zs_dev",
  ])("refuses %s", (value) => {
    expect(() => assertLocalDatabaseUrl(value)).toThrow(/Refusing to run/);
  });

  it("prints the runtime database without credentials", async () => {
    const summary = await seedDemo({ service: database.servicePool, runtime: database.runtimePool, clock, generateId: randomUUID });
    const admin = assertLocalDatabaseUrl("postgres://postgres:admin-pw@127.0.0.1:55432/zs_dev");
    const runtime = runtimeTargetFor(admin, "postgres://zs_runtime:runtime-pw@127.0.0.1:55432/zs_dev");
    const report = formatSeedReport(summary, runtime);
    expect(report).not.toMatch(/runtime-pw|admin-pw|postgres:\/\//);
    expect(JSON.parse(report).runtimeDatabase).toEqual({ host: "127.0.0.1", port: "55432", database: "zs_dev" });
    expect(runtimeTargetFor(admin, undefined)).toMatchObject({ user: "zs_runtime", host: "127.0.0.1", database: "zs_dev" });
    expect(runtimeTargetFor(admin, undefined).connectionString).not.toContain("admin-pw");
  });
});

describe("hosted seed", () => {
  let hosted: TestDatabase;
  beforeAll(async () => { hosted = await createTestDatabase(); });
  afterAll(async () => { await hosted?.close(); });

  const members = (tenantId: string) => hosted.pool.query<{ email: string; user_id: string | null; role: string }>(
    "SELECT email, user_id, role::text AS role FROM tenant_members WHERE tenant_id=$1 ORDER BY email", [tenantId]).then((result) => result.rows);

  it("removes the seed's own member, leaves the tenant with no member and never calls Supabase Auth", async () => {
    const gotrue = fakeGoTrue();
    gotrue.addUser("devin@example.com");
    const auth = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
    const deps = { service: hosted.servicePool, runtime: hosted.runtimePool, clock, generateId: randomUUID };

    // An owner handed in the old way is ignored: the seed has no path to Auth or a real membership.
    const first = await (seedHostedTenant as (...args: unknown[]) => ReturnType<typeof seedHostedTenant>)(deps, { email: "devin@example.com", auth });
    expect(first).toMatchObject({ contacts: 12, deals: 8, bookings: 6, seedMemberRemoved: true });
    expect(first).not.toHaveProperty("provisionedOwner");
    const tenantId = first.principal.tenantId;
    expect(await members(tenantId)).toEqual([]);
    expect(gotrue.requests).toEqual([]);

    // A rerun replays the seed and removes its member again.
    const again = await seedHostedTenant(deps);
    expect(again).toMatchObject({ seedMemberRemoved: true, bookings: 6 });
    expect(await members(tenantId)).toEqual([]);
    const actions = await hosted.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM actions WHERE tenant_id=$1", [tenantId]);
    expect(actions.rows[0]!.n).toBe(36);
  });

  it("names the tenant and the guarded db:hosted-provision-owner steps that give it an owner", () => {
    const tenantId = randomUUID();
    expect(hostedOwnerSteps(tenantId, "abcdefghijklmnopqrst")).toEqual([
      `mise exec -- pnpm --filter @zs/api db:hosted-provision-owner --tenant ${tenantId} --email <addr> --dry-run`,
      "mise exec -- pnpm --filter @zs/api db:hosted-backup --out ~/Backups/zs-business/abcdefghijklmnopqrst-<date>.dump",
      `mise exec -- pnpm --filter @zs/api db:hosted-provision-owner --tenant ${tenantId} --email <addr> --apply ` +
        "--backup ~/Backups/zs-business/abcdefghijklmnopqrst-<date>.dump --receipt <file.json>",
    ]);
  });

  it("seed:hosted refuses --owner-email and any other argument", () => {
    expect(() => assertNoHostedSeedArgs(["--owner-email", "devin@example.com"])).toThrow(/takes no arguments.*db:hosted-provision-owner/);
    expect(() => assertNoHostedSeedArgs(["--owner-email=devin@example.com"])).toThrow(/takes no arguments/);
    expect(() => assertNoHostedSeedArgs([])).not.toThrow();
  });
});
