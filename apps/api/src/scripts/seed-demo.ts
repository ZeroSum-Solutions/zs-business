// Entry point: seed the Halden & Rowe demo tenant into a local database and print a dev JWT.
// DATABASE_URL is the local admin connection (for example postgres@127.0.0.1:55432/zs_dev).
// Writes go through the action path as RUNTIME_DATABASE_URL (default: same URL as zs_runtime).
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";
import { bookingPageSnippets, signBookingKey } from "@zs/core";
import { migrate } from "@zs/db";
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
  const token = await signDevToken(jwtSecret, summary.principal, clock);
  console.log(formatSeedReport(summary, runtimeTarget));
  // The booking key is signed with the API's secret, so print it only when that secret is set.
  const keySecret = process.env.PUBLIC_BOOKING_KEY_SECRET;
  if (keySecret && keySecret.length >= 32) {
    const key = signBookingKey(keySecret, { tenantId: summary.principal.tenantId, pageId: summary.bookingPageId });
    const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? "8787"}`;
    const snippets = bookingPageSnippets(base, key);
    console.log(`\nBooking page: ${snippets.bookingUrl}\nWidget snippet:\n${snippets.embedScript}`);
  } else {
    console.log("\nSet PUBLIC_BOOKING_KEY_SECRET to print the demo booking page URL.");
  }
  console.log(`\nDev JWT (7 days, tenant ${summary.principal.tenantId}; the API accepts it only with JWT_MAX_TTL_SECONDS=604800):\n${token}`);
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
