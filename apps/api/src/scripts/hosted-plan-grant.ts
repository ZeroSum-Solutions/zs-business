// Entry point, owner-run: grant a Hub plan to a tenant on one hosted Supabase project, or clear
// the grant (src/hosted-plan-grant.ts, the same planGrant as the local db:plan-grant;
// docs/requirements/plans.md PL-21..PL-24).
//   ZS_TARGET_REF         the project ref; the URL must name it
//   SERVICE_DATABASE_URL  postgres.<ref> on the session pooler (port 5432), no query string;
//                         the writes run as service_role. No Supabase Auth key is needed.
// Modes:
//   --tenant <uuid> --plan <solo|studio|pro> [--until <date>] --note <text> --by <name> --dry-run
//   --tenant <uuid> --clear --by <name> --dry-run
//   ... --apply --backup <file> --receipt <file>
//       --backup is an archive from db:hosted-backup of this project, taken within the last two
//       hours; --receipt must not exist yet, is reserved first and always records the outcome
//       --until 2027-01-31 ends the grant at the end of that day, UTC
// Output and the receipt hold ids, names, the plan and the note only, never credentials.
import process from "node:process";
import { checkBackup, currentTables, readLedger } from "../hosted-backup.js";
import { hostedPool, redactSecrets } from "../hosted.js";
import { parseHostedPlanGrantArgs, runHostedPlanGrant } from "../hosted-plan-grant.js";

let pool: ReturnType<typeof hostedPool> | undefined;
try {
  // Parsed inside the try, so an argument or URL error is redacted like every other error.
  const config = parseHostedPlanGrantArgs(process.argv.slice(2), process.env);
  const hosted = hostedPool(config.target, 2);
  pool = hosted;
  const clock = { now: () => new Date() };
  await runHostedPlanGrant(config, {
    service: hosted,
    checkBackup: async (path) => checkBackup(path, {
      projectRef: config.target.projectRef, ledger: await readLedger(hosted), tables: await currentTables(hosted),
      now: clock.now(), pgRestore: process.env.PG_RESTORE,
    }),
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
