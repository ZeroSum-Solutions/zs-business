import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endAuthSession, installAuthStub, startAuthSession, upsertAuthUser } from "../src/local-auth.js";
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

/** Asked the way the API asks: as the runtime login, inside a tenant transaction. */
const isLive = (sessionId: string | null, userId: string | null, now: Date | null = NOW) =>
  fixture.a.run(async (tx) => (await tx.query<{ live: boolean }>(
    "SELECT public.auth_session_is_live($1, $2, $3) AS live", [sessionId, userId, now],
  )).rows[0]!.live);

const newUser = () => upsertAuthUser(database.pool, { email: `${randomUUID()}@example.com` });

describe("auth_session_is_live", () => {
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

  it("is the runtime's only way into the auth schema", async () => {
    for (const sql of ["SELECT 1 FROM auth.sessions", "SELECT 1 FROM auth.users"])
      await expect(fixture.a.run((tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
    const acl = await database.pool.query<{ role: string }>(`
      SELECT DISTINCT grantee AS role FROM information_schema.column_privileges
      WHERE table_schema='auth' AND table_name IN ('sessions','users') AND privilege_type='SELECT'
        AND grantee NOT IN (SELECT tableowner FROM pg_tables WHERE schemaname='auth')`);
    expect(acl.rows).toEqual([{ role: "zs_session_reader" }]);
  });

  it("fails closed on plain Postgres without an auth schema", async () => {
    await withTestDatabase(async (bare) => {
      const tenantId = randomUUID();
      await bare.pool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Bare')", [tenantId]);
      await expect(bare.db.tenant(tenantId, (tx) => tx.query(
        "SELECT public.auth_session_is_live($1, $2, $3)", [randomUUID(), randomUUID(), NOW],
      ))).rejects.toMatchObject({ code: "42P01" });
    }, undefined, { authStub: false });
  });

  it("grants on an auth schema that exists before the migration, as on hosted Supabase", async () => {
    const before = await mkdtemp(join(tmpdir(), "zs-migrations-auth-"));
    try {
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < "20261019090000"))
        await copyFile(new URL(name, migrations), join(before, name));
      await withTestDatabase(async (upgraded) => {
        // The stub is in place; take away anything it granted so only the migration can grant.
        await installAuthStub(upgraded.pool);
        await upgraded.pool.query(`DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_session_reader') THEN
            REVOKE ALL ON auth.sessions, auth.users FROM zs_session_reader;
            REVOKE ALL ON SCHEMA auth FROM zs_session_reader;
          END IF;
        END $$`);
        await migrate(upgraded.pool);
        const user = await upsertAuthUser(upgraded.pool, { email: "owner@example.com" });
        const session = await startAuthSession(upgraded.pool, user);
        const tenantId = randomUUID();
        await upgraded.pool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Upgraded')", [tenantId]);
        expect(await upgraded.db.tenant(tenantId, async (tx) => (await tx.query<{ live: boolean }>(
          "SELECT public.auth_session_is_live($1, $2, $3) AS live", [session, user, NOW],
        )).rows[0]!.live)).toBe(true);
      }, undefined, { migrations: pathToFileURL(`${before}/`), authStub: false });
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  }, 30000);
});

describe("local auth stub", () => {
  it("refuses a pool that is not on loopback", async () => {
    const remote = new Pool({ connectionString: "postgres://postgres@db.abcd.supabase.co:5432/postgres" });
    const overridden = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "db.example.com" });
    try {
      for (const pool of [remote, overridden]) {
        await expect(installAuthStub(pool)).rejects.toThrow(/loopback/);
        await expect(upsertAuthUser(pool, { email: "a@example.com" })).rejects.toThrow(/loopback/);
        expect(pool.totalCount).toBe(0);
      }
    } finally {
      await Promise.all([remote.end(), overridden.end()]);
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
