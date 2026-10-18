import { assertLocalDatabaseUrl, describeDatabase, type LocalDatabaseTarget } from "../config.js";
import type { SeedSummary } from "./demo.js";

/** RUNTIME_DATABASE_URL when set, else the admin URL as `zs_runtime` with no password; both validated. */
export function runtimeTargetFor(admin: LocalDatabaseTarget, runtimeUrl: string | undefined): LocalDatabaseTarget {
  if (runtimeUrl) return assertLocalDatabaseUrl(runtimeUrl);
  const url = new URL(admin.connectionString);
  url.username = "zs_runtime";
  url.password = "";
  return assertLocalDatabaseUrl(url.href);
}

/** The seed script's summary line: carries host, port and database only, never credentials. */
export function formatSeedReport(summary: SeedSummary, runtime: LocalDatabaseTarget): string {
  return JSON.stringify({ ...summary, runtimeDatabase: describeDatabase(runtime) }, null, 2);
}
