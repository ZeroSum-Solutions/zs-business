// Entry point, owner-run: the recovery proof. Restores one db:hosted-backup archive into a new,
// throwaway zs_restore_proof_* database on a loopback cluster, checks it and drops it.
//   RESTORE_ADMIN_URL   superuser URL of the throwaway cluster's postgres database, loopback only,
//                       for example postgres://postgres@127.0.0.1:55433/postgres (trust auth, so
//                       the zs_runtime login needs no password). Never a hosted database.
//   --backup <file>     the archive; <file>.manifest.json must sit next to it and match it
//   --keep              leave the restored database in place (drop it by hand afterwards)
// pg_restore comes from PG_RESTORE, else the newest installed versioned copy (pg-tools.ts).
// Prints one JSON report (no credentials) and exits 1 if any check fails.
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { restoreProof } from "../restore-proof.js";

const { values } = parseArgs({ options: { backup: { type: "string" }, keep: { type: "boolean", default: false } } });
if (!values.backup) throw new Error("Pass --backup <file>");

try {
  const report = await restoreProof({
    archivePath: resolve(values.backup),
    adminUrl: process.env.RESTORE_ADMIN_URL ?? "",
    clock: { now: () => new Date() },
    pgRestore: process.env.PG_RESTORE,
    searchPath: process.env.PATH,
    keep: values.keep,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
