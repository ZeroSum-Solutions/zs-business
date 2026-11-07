// Entry point, owner-run: create a tenant and its pending owner on one hosted Supabase project
// (src/hosted-tenant-create.ts, the same createTenant as the local tenant:create).
//   ZS_TARGET_REF              the project ref; the URL and the key must name it
//   SERVICE_DATABASE_URL       postgres.<ref> on the session pooler (port 5432), no query string;
//                              the writes run as service_role
//   SUPABASE_SERVICE_ROLE_KEY  the project's service_role key, for the Auth admin API
// Modes:
//   --key <slug> --name <name> --owner-email <addr> [--time-zone <zone>] --dry-run
//   ... --apply --backup <file> --receipt <file>
//       --backup is an archive from db:hosted-backup of this project, taken within the last two
//       hours; --receipt must not exist yet, is reserved first and always records the outcome
// Output and the receipt hold ids, names and role facts only, never credentials.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { checkBackup, currentTables, readLedger } from "../hosted-backup.js";
import { hostedPool, redactSecrets } from "../hosted.js";
import { parseHostedTenantCreateArgs, runHostedTenantCreate } from "../hosted-tenant-create.js";
import { createSupabaseAuthAdmin } from "../supabase-auth-admin.js";

// Hosted notes: the run holds two session advisory locks on one connection, so SERVICE_DATABASE_URL
// must be the session pooler (port 5432), as above. Like db:hosted-provision-owner, this script has
// no runtime-role connection check of its own; it writes only as service_role.
let pool: ReturnType<typeof hostedPool> | undefined;
try {
  // Parsed inside the try, so an argument or URL error is redacted like every other error.
  const config = parseHostedTenantCreateArgs(process.argv.slice(2), process.env);
  const hosted = hostedPool(config.target, 3);
  pool = hosted;
  const clock = { now: () => new Date() };
  await runHostedTenantCreate(config, {
    service: hosted,
    auth: createSupabaseAuthAdmin({ projectRef: config.target.projectRef, serviceKey: config.serviceKey }),
    checkBackup: async (path) => checkBackup(path, {
      projectRef: config.target.projectRef, ledger: await readLedger(hosted), tables: await currentTables(hosted),
      now: clock.now(), pgRestore: process.env.PG_RESTORE,
    }),
    clock,
    generateId: randomUUID,
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  });
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
