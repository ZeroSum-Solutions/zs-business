// Entry point: seed the Halden & Rowe demo tenant into a local database and print a dev JWT.
// DATABASE_URL is the local admin connection (for example postgres@127.0.0.1:55432/zs_dev).
// Writes go through the action path as RUNTIME_DATABASE_URL (default: same URL as zs_runtime).
// Plain Postgres has no Supabase Auth, so the seed installs the local auth stub, adds the owner
// as an auth user and starts a session; the dev JWT carries that session's id.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";
import { migrate } from "@zs/db";
import { installAuthStub, startAuthSession, upsertAuthUser } from "@zs/db/local-auth";
import { assertLocalDatabaseUrl, jwtSecretSchema } from "../config.js";
import { signDevToken } from "../dev-token.js";
import { seedDemo } from "../seed/demo.js";
import { formatSeedReport, runtimeTargetFor } from "../seed/report.js";
import { ensureRuntimeLogin } from "../seed/runtime-login.js";

const adminTarget = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
const secret = jwtSecretSchema.safeParse(process.env.JWT_SECRET ?? "");
if (!secret.success) throw new Error(`Set JWT_SECRET to the value the API uses: ${secret.error.issues[0]?.message}`);
const jwtSecret = secret.data;
const runtimeTarget = runtimeTargetFor(adminTarget, process.env.RUNTIME_DATABASE_URL);

const clock = { now: () => new Date() };
const admin = new Pool({ connectionString: adminTarget.connectionString, max: 2 });
const runtime = new Pool({ connectionString: runtimeTarget.connectionString, max: 2 });
try {
  await migrate(admin);
  await ensureRuntimeLogin(admin, runtimeTarget.user);
  const summary = await seedDemo({ service: admin, runtime, clock, generateId: randomUUID });
  await installAuthStub(admin);
  await upsertAuthUser(admin, {
    id: summary.principal.actorId, email: summary.owner.email, appMetadata: { tenant_id: summary.principal.tenantId },
  });
  const sessionId = await startAuthSession(admin, summary.principal.actorId);
  const token = await signDevToken(jwtSecret, { ...summary.principal, sessionId }, clock);
  console.log(formatSeedReport(summary, runtimeTarget));
  console.log(`\nDev JWT (7 days, tenant ${summary.principal.tenantId}; the API accepts it only with JWT_MAX_TTL_SECONDS=604800):\n${token}`);
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
