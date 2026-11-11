// Entry point, owner-run, local only: grant a Hub plan to a tenant, or clear the grant
// (src/plan-grant.ts; docs/requirements/plans.md PL-21..PL-24). Hosted projects use
// src/scripts/hosted-plan-grant.ts (db:hosted-plan-grant).
//   DATABASE_URL   the local admin URL (loopback only); writes run as service_role
// Modes:
//   --tenant <uuid> --plan <solo|studio|pro> [--until <date>] --note <text> --by <name> --dry-run
//   --tenant <uuid> --clear --by <name> --dry-run
//   ... --apply --receipt <file>      --receipt must not exist yet; it is reserved first and
//                                     always records the outcome
// Output and the receipt hold ids, names, the plan and the note only, never credentials.
import { resolve } from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { assertLocalDatabaseUrl, describeDatabase } from "../config.js";
import { redactSecrets } from "../hosted.js";
import { parsePlanGrantFlags, planGrant, readGrantFacts, runPlanGrant } from "../plan-grant.js";

let pool: Pool | undefined;
try {
  const flags = parsePlanGrantFlags(process.argv.slice(2), { hosted: false, resolve });
  const target = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
  const local = new Pool({ connectionString: target.connectionString, max: 2 });
  pool = local;
  const clock = { now: () => new Date() };
  await runPlanGrant(flags.mode, {
    input: { tenantId: flags.tenantId, request: flags.request },
    target: describeDatabase(target),
    grant: (input) => planGrant({ service: local, clock }, input),
    readGrant: (tenantId) => readGrantFacts(local, tenantId),
    clock,
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  });
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
