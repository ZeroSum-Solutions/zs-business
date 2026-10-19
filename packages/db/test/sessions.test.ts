import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  endAuthSession,
  findAuthUserByEmail,
  installAuthStub,
  readAuthUserTenant,
  setAuthUserTenant,
  startAuthSession,
  upsertAuthUser,
} from "../src/local-auth.js";
import { migrate } from "../src/migrate.js";
import { createTestDatabase, createTwoTenantFixture, withTestDatabase, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const NOW = new Date("2026-10-19T08:00:00.000Z");

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

/** Asked the way the API's local-stub session check asks: as the runtime login, inside a tenant transaction. */
const isLive = (sessionId: string | null, userId: string | null, now: Date | null = NOW) =>
  fixture.a.run(async (tx) => (await tx.query<{ live: boolean }>(
    "SELECT zs_local_auth.session_is_live($1, $2, $3) AS live", [sessionId, userId, now],
  )).rows[0]!.live);

const newUser = () => upsertAuthUser(database.pool, { email: `${randomUUID()}@example.com` });

describe("zs_local_auth.session_is_live (local stub)", () => {
  it("is true for a live session of the user and false once it signs out", async () => {
    const user = await newUser();
    const session = await startAuthSession(database.pool, user);
    expect(await isLive(session, user)).toBe(true);
    await endAuthSession(database.pool, session);
    expect(await isLive(session, user)).toBe(false);
  });

  it("is false for another user's session, an unknown session and null arguments", async () => {
    const [user, other] = [await newUser(), await newUser()];
    const session = await startAuthSession(database.pool, user);
    expect(await isLive(session, other)).toBe(false);
    expect(await isLive(randomUUID(), user)).toBe(false);
    expect(await isLive(null, user)).toBe(false);
    expect(await isLive(session, null)).toBe(false);
    expect(await isLive(session, user, null)).toBe(false);
  });

  it("uses the caller's clock for not_after and bans", async () => {
    const user = await newUser();
    const session = await startAuthSession(database.pool, user, { notAfter: new Date("2026-10-19T09:00:00.000Z") });
    expect(await isLive(session, user, new Date("2026-10-19T08:59:59.000Z"))).toBe(true);
    expect(await isLive(session, user, new Date("2026-10-19T09:00:00.000Z"))).toBe(false);
    await database.pool.query("UPDATE auth.users SET banned_until='2026-10-19T10:00:00Z' WHERE id=$1", [user]);
    expect(await isLive(session, user, new Date("2026-10-19T08:30:00.000Z"))).toBe(false);
  });

  it("is false for a deleted user", async () => {
    const user = await newUser();
    const session = await startAuthSession(database.pool, user);
    await database.pool.query("UPDATE auth.users SET deleted_at=$2 WHERE id=$1", [user, NOW]);
    expect(await isLive(session, user)).toBe(false);
  });

  it("is the runtime's only way into the auth schema; nobody but the owner holds a grant there", async () => {
    for (const sql of ["SELECT 1 FROM auth.sessions", "SELECT 1 FROM auth.users"])
      await expect(fixture.a.run((tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
    const grants = await database.pool.query(`
      SELECT 1 FROM information_schema.column_privileges
      WHERE table_schema='auth' AND grantee NOT IN (SELECT tableowner FROM pg_tables WHERE schemaname='auth')`);
    expect(grants.rowCount).toBe(0);
  });

  it("keeps RLS on with no policies, as hosted Supabase does: a granted non-owner still sees no rows", async () => {
    const user = await newUser();
    await startAuthSession(database.pool, user);
    const rls = await database.pool.query<{ relname: string; relrowsecurity: boolean; policies: number }>(`
      SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
    expect(rls.rows).toEqual([
      { relname: "sessions", relrowsecurity: true, policies: 0 },
      { relname: "users", relrowsecurity: true, policies: 0 },
    ]);
    const reader = `zs_test_reader_${randomUUID().replaceAll("-", "")}`;
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${reader} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA auth TO ${reader}; GRANT SELECT ON auth.sessions, auth.users TO ${reader}`);
      await client.query(`SET LOCAL ROLE ${reader}`);
      expect((await client.query("SELECT count(*)::int AS n FROM auth.sessions")).rows[0].n).toBe(0);
      expect((await client.query("SELECT count(*)::int AS n FROM auth.users")).rows[0].n).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("members migration on a hosted-shaped auth schema", () => {
  it("applies as the non-superuser migrator without touching auth.*, which another role owns behind RLS", async () => {
    const before = await mkdtemp(join(tmpdir(), "zs-migrations-auth-"));
    try {
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < "20261019090000"))
        await copyFile(new URL(name, migrations), join(before, name));
      await withTestDatabase(async (upgraded) => {
        // Like hosted Supabase: auth tables owned by another role, RLS on, no policies, no grant option for the migrator.
        const owner = `zs_test_auth_admin_${randomUUID().replaceAll("-", "")}`;
        await upgraded.pool.query(`CREATE ROLE ${owner} NOLOGIN`);
        try {
          await upgraded.pool.query(`
            CREATE SCHEMA auth AUTHORIZATION ${owner};
            CREATE TABLE auth.users (id uuid PRIMARY KEY, banned_until timestamptz, deleted_at timestamptz);
            CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, not_after timestamptz);
            ALTER TABLE auth.users OWNER TO ${owner};
            ALTER TABLE auth.sessions OWNER TO ${owner};
            ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
            ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;`);
          const acl = () => upgraded.pool.query("SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'auth'::regnamespace ORDER BY 1");
          const aclBefore = (await acl()).rows;
          const url = new URL(upgraded.url);
          url.username = upgraded.migrator!;
          const migrator = new Pool({ connectionString: url.href, max: 1 });
          try {
            await migrate(migrator);
          } finally {
            await migrator.end();
          }
          expect((await acl()).rows).toEqual(aclBefore);
          const ledger = await upgraded.pool.query("SELECT 1 FROM zs_internal.schema_migrations WHERE name LIKE '20261019090000%'");
          expect(ledger.rowCount).toBe(1);
        } finally {
          await upgraded.pool.query(`DROP SCHEMA IF EXISTS auth CASCADE; DROP ROLE IF EXISTS ${owner}`);
        }
      }, undefined, { migrations: pathToFileURL(`${before}/`), authStub: false, nonSuperuserMigrator: true });
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  }, 30000);

  it("ships no auth.* grant, role or function in any migration", async () => {
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql"))) {
      const sql = (await readFile(new URL(name, migrations), "utf8")).replace(/--.*$/gm, "");
      expect(sql, name).not.toMatch(/\bauth\.(users|sessions)\b|ON SCHEMA auth\b|zs_session_reader/i);
    }
  });
});

describe("local auth stub", () => {
  it("refuses a pool that is not on loopback", async () => {
    const remote = new Pool({ connectionString: "postgres://postgres@db.abcd.supabase.co:5432/postgres" });
    const overridden = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "db.example.com" });
    // pg lets query parameters override the URL's host: the stub checks the effective destination.
    const queryHost = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev?host=db.example.com" });
    const queryAddr = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev?hostaddr=203.0.113.7" });
    try {
      for (const pool of [remote, overridden, queryHost, queryAddr]) {
        await expect(installAuthStub(pool)).rejects.toThrow(/loopback/);
        await expect(upsertAuthUser(pool, { email: "a@example.com" })).rejects.toThrow(/loopback/);
        await expect(startAuthSession(pool, randomUUID())).rejects.toThrow(/loopback/);
        await expect(endAuthSession(pool, randomUUID())).rejects.toThrow(/loopback/);
        await expect(findAuthUserByEmail(pool, "a@example.com")).rejects.toThrow(/loopback/);
        await expect(setAuthUserTenant(pool, randomUUID(), randomUUID())).rejects.toThrow(/loopback/);
        await expect(readAuthUserTenant(pool, randomUUID())).rejects.toThrow(/loopback/);
        expect(pool.totalCount).toBe(0);
      }
    } finally {
      await Promise.all([remote.end(), overridden.end(), queryHost.end(), queryAddr.end()]);
    }
  });

  it("refuses a database with a real Supabase auth schema", async () => {
    await withTestDatabase(async (real) => {
      await real.pool.query("CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, encrypted_password text)");
      await expect(installAuthStub(real.pool)).rejects.toThrow(/real Supabase auth schema/);
    }, undefined, { authStub: false });
  });
});

describe("tenant_members under the runtime role", () => {
  const insertMember = (columns: string, values: unknown[]) => fixture.a.run((tx) => tx.query(
    `INSERT INTO tenant_members (${columns}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`, values,
  ));

  it("may add a pending member but never bind a user to it", async () => {
    const id = randomUUID();
    await insertMember("tenant_id,id,email,role,created_at,updated_at", [fixture.a.tenantId, id, "pending@example.com", "staff", NOW, NOW]);
    await expect(insertMember("tenant_id,id,email,user_id,role,created_at,updated_at",
      [fixture.a.tenantId, randomUUID(), "bound@example.com", randomUUID(), "owner", NOW, NOW])).rejects.toMatchObject({ code: "42501" });
    for (const set of ["user_id = gen_random_uuid()", "email = 'other@example.com'", "tenant_id = tenant_id"])
      await expect(fixture.a.run((tx) => tx.query(`UPDATE tenant_members SET ${set} WHERE id=$1`, [id])))
        .rejects.toMatchObject({ code: "42501" });
  });

  it("keeps emails canonical and unique per tenant", async () => {
    await expect(insertMember("tenant_id,id,email,role,created_at,updated_at",
      [fixture.a.tenantId, randomUUID(), "Mixed@Example.com", "staff", NOW, NOW])).rejects.toMatchObject({ code: "23514" });
    const email = `${randomUUID()}@example.com`;
    await insertMember("tenant_id,id,email,role,created_at,updated_at", [fixture.a.tenantId, randomUUID(), email, "staff", NOW, NOW]);
    await expect(insertMember("tenant_id,id,email,role,created_at,updated_at",
      [fixture.a.tenantId, randomUUID(), email, "staff", NOW, NOW])).rejects.toMatchObject({ code: "23505" });
    // The same address may belong to another tenant.
    await fixture.b.run((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) VALUES ($1,$2,$3,'owner',$4,$4)",
      [fixture.b.tenantId, randomUUID(), email, NOW],
    ));
  });
});
