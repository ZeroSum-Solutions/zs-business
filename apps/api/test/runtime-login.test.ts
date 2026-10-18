import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { ensureRuntimeLogin } from "../src/seed/runtime-login.js";

let database: TestDatabase;
const roles: string[] = [];
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => {
  for (const role of roles) await database?.pool.query(`DROP ROLE IF EXISTS ${role}`);
  await database?.close();
});

/** A throwaway LOGIN role on the test cluster with the given attributes. */
async function role(attributes: string): Promise<string> {
  const name = `zs_t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  roles.push(name);
  await database.pool.query(`CREATE ROLE ${name} LOGIN ${attributes}`);
  return name;
}

describe("ensureRuntimeLogin", () => {
  it.each(["SUPERUSER", "BYPASSRLS", "CREATEROLE"])("refuses a %s login", async (attribute) => {
    const name = await role(attribute);
    await expect(ensureRuntimeLogin(database.pool, name)).rejects.toThrow(/Unsafe runtime login/);
    const member = await database.pool.query("SELECT 1 FROM pg_auth_members WHERE member=$1::regrole", [name]);
    expect(member.rowCount).toBe(0);
  });

  it("resets stored role settings in every database", async () => {
    const name = await role("");
    await database.pool.query(`ALTER ROLE ${name} SET search_path = pg_temp, public`);
    await database.pool.query(`ALTER ROLE ${name} IN DATABASE "${database.name}" SET statement_timeout = 0`);
    await database.pool.query(`ALTER ROLE ${name} IN DATABASE postgres SET work_mem = '1GB'`);
    await ensureRuntimeLogin(database.pool, name);
    const settings = await database.pool.query("SELECT 1 FROM pg_db_role_setting WHERE setrole=$1::regrole", [name]);
    expect(settings.rowCount).toBe(0);
    const { rows } = await database.pool.query<{ rolconfig: string[] | null; authenticated: boolean }>(
      "SELECT rolconfig, pg_has_role(oid, 'authenticated', 'MEMBER') AS authenticated FROM pg_roles WHERE rolname=$1", [name]);
    expect(rows[0]).toEqual({ rolconfig: null, authenticated: true });
  });
});
