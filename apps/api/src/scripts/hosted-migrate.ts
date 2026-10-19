// Entry point, owner-run: apply supabase/migrations to one hosted Supabase project as the
// restricted zs_migrator login (supabase/hosted/bootstrap-roles.sql creates it).
//   ZS_TARGET_REF            the project ref; the URL must name it
//   MIGRATOR_DATABASE_URL    zs_migrator.<ref> on the session pooler (port 5432), no query string
// Modes:
//   --dry-run                                   run every pending migration, then roll back
//   --apply --backup <file> --receipt <file>    dry run, then apply; --backup is an archive
//                                               from db:hosted-backup of this project, taken
//                                               within the last two hours, with its
//                                               <file>.manifest.json (ref, sha256, ledger);
//                                               --receipt must not exist yet, is reserved
//                                               first and afterwards always records the outcome
//   --migrations <dir>                          another directory (staged upgrade rehearsal)
// Output and the receipt hold names, checksums and role facts only, never credentials.
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { migrate } from "@zs/db";
import { checkBackup } from "../hosted-backup.js";
import { runHostedMigrate } from "../hosted-migrate-run.js";
import { assertHostedDatabaseUrl, describeHosted, hostedPool, redactSecrets } from "../hosted.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    backup: { type: "string" },
    receipt: { type: "string" },
    migrations: { type: "string" },
  },
});
if (values["dry-run"] === values.apply) throw new Error("Pass exactly one of --dry-run or --apply");
if (values.apply && (!values.backup || !values.receipt)) throw new Error("--apply needs --backup <file> and --receipt <file>");

const target = assertHostedDatabaseUrl(process.env.MIGRATOR_DATABASE_URL ?? "", {
  projectRef: process.env.ZS_TARGET_REF ?? "", role: "zs_migrator",
});
const directory = values.migrations
  ? pathToFileURL(resolve(values.migrations) + "/")
  : new URL("../../../../supabase/migrations/", import.meta.url);
const pool = hostedPool(target, 1);
const clock = { now: () => new Date() };

try {
  await runHostedMigrate(
    values.apply ? { mode: "apply", backupPath: resolve(values.backup!), receiptPath: resolve(values.receipt!) } : { mode: "dry-run" },
    {
      pool,
      target: describeHosted(target),
      migrate: (options) => migrate(pool, directory, options),
      checkBackup: (path, ledger, tables) =>
        checkBackup(path, { projectRef: target.projectRef, ledger, tables, now: clock.now(), pgRestore: process.env.PG_RESTORE }),
      clock,
      log: (line) => console.log(line),
      logError: (line) => console.error(line),
    },
  );
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await pool.end();
}
