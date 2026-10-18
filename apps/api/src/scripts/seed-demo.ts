// Entry point: seed the Halden & Rowe demo tenant into a local database and print a dev JWT.
// DATABASE_URL is the local admin connection (for example postgres@127.0.0.1:55432/zs_dev).
// Writes go through the action path as RUNTIME_DATABASE_URL (default: same URL as zs_runtime).
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";
import { createScopedDatabase, migrate } from "@zs/db";
import { assertLocalDatabaseUrl } from "../config.js";
import { signDevToken } from "../dev-token.js";
import { seedDemo } from "../seed/demo.js";
import { ensureRuntimeLogin } from "../seed/runtime-login.js";

const adminUrl = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
const jwtSecret = process.env.JWT_SECRET ?? "";
if (jwtSecret.length < 32) throw new Error("Set JWT_SECRET (32+ characters) to the value the API uses");
const runtimeUrl = process.env.RUNTIME_DATABASE_URL
  ? assertLocalDatabaseUrl(process.env.RUNTIME_DATABASE_URL)
  : Object.assign(new URL(adminUrl), { username: "zs_runtime", password: "" });

const clock = { now: () => new Date() };
const admin = new Pool({ connectionString: adminUrl.href, max: 2 });
const runtime = new Pool({ connectionString: runtimeUrl.href, max: 2 });
try {
  await migrate(admin);
  await ensureRuntimeLogin(admin, runtimeUrl.username);
  const summary = await seedDemo({ service: admin, db: createScopedDatabase(runtime), clock, generateId: randomUUID });
  const token = await signDevToken(jwtSecret, summary.principal, clock);
  console.log(JSON.stringify({ ...summary, runtimeDatabaseUrl: runtimeUrl.href }, null, 2));
  console.log(`\nDev JWT (7 days, tenant ${summary.principal.tenantId}):\n${token}`);
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
