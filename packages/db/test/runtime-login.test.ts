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

it("accepts the unprivileged runtime login", async () => {
  await expect(assertRuntimeLogin(database.runtimePool)).resolves.toBeUndefined();
});
