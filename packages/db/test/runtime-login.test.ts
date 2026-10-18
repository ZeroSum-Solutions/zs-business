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

it("accepts the unprivileged runtime login", async () => {
  await expect(assertRuntimeLogin(database.runtimePool)).resolves.toBeUndefined();
});
