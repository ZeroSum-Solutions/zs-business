import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRuntimeLogin } from "../src/runtime-login.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

it("refuses a superuser login", async () => {
  await expect(assertRuntimeLogin(database.pool)).rejects.toThrow(/Refusing to start/);
});

it("refuses a login that inherits BYPASSRLS through service_role", async () => {
  await expect(assertRuntimeLogin(database.servicePool)).rejects.toThrow(/Refusing to start/);
});

it("refuses a superuser login that sets role to the runtime role in the URL options", async () => {
  // current_user is authenticated here; session_user is still the superuser.
  const url = new URL(database.url);
  url.searchParams.set("options", "-c role=authenticated");
  const pool = new Pool({ connectionString: url.href, max: 1 });
  try {
    const { rows } = await pool.query("SELECT session_user::text AS login, current_user::text AS role");
    expect(rows[0].role).toBe("authenticated");
    expect(rows[0].login).not.toBe("authenticated");
    await expect(assertRuntimeLogin(pool)).rejects.toThrow(/Refusing to start/);
  } finally {
    await pool.end();
  }
});

/** One-connection superuser pool whose session first runs `setup`, as a URL cannot. */
async function withSwitchedSuperuser(setup: string, check: (pool: Pool) => Promise<void>) {
  const pool = new Pool({ connectionString: database.url, max: 1 });
  try {
    const client = await pool.connect();
    try { await client.query(setup); } finally { client.release(); }
    await check(pool);
  } finally {
    await pool.end();
  }
}

it("refuses a superuser login that ran SET SESSION AUTHORIZATION to the runtime role", async () => {
  // session_user and current_user both read zs_runtime, yet RESET SESSION AUTHORIZATION
  // would restore the superuser: only the authenticated backend user tells them apart.
  await withSwitchedSuperuser("SET SESSION AUTHORIZATION zs_runtime", async (pool) => {
    const { rows } = await pool.query("SELECT session_user::text AS login, current_user::text AS role");
    expect(rows[0]).toEqual({ login: "zs_runtime", role: "zs_runtime" });
    await expect(assertRuntimeLogin(pool)).rejects.toThrow(/Refusing to start/);
  });
});

it("refuses a superuser login that switched session authorization and then SET ROLE", async () => {
  await withSwitchedSuperuser("SET SESSION AUTHORIZATION zs_runtime; SET ROLE authenticated", async (pool) => {
    const { rows } = await pool.query("SELECT session_user::text AS login, current_user::text AS role");
    expect(rows[0]).toEqual({ login: "zs_runtime", role: "authenticated" });
    await expect(assertRuntimeLogin(pool)).rejects.toThrow(/Refusing to start/);
  });
});

it("refuses a superuser login that ran SET ROLE to the runtime role", async () => {
  await withSwitchedSuperuser("SET ROLE zs_runtime", async (pool) => {
    const { rows } = await pool.query("SELECT current_user::text AS role");
    expect(rows[0].role).toBe("zs_runtime");
    await expect(assertRuntimeLogin(pool)).rejects.toThrow(/Refusing to start/);
  });
});

it("fails closed when the backend's pg_stat_activity row is missing", async () => {
  const pool = { query: async () => ({ rows: [{ login: null, rolsuper: false, rolbypassrls: false }] }) } as unknown as Pool;
  await expect(assertRuntimeLogin(pool)).rejects.toThrow(/Refusing to start/);
});

it("accepts the unprivileged runtime login", async () => {
  await expect(assertRuntimeLogin(database.runtimePool)).resolves.toBeUndefined();
});
