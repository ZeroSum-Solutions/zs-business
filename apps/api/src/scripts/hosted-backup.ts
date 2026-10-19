// Entry point, owner-run: back up one hosted Supabase project before db:hosted-migrate --apply.
//   ZS_TARGET_REF            the project ref; the URL must name it
//   SERVICE_DATABASE_URL     postgres.<ref> on the session pooler (port 5432), no query string
//   --out <file>             the archive (pg_dump -Fc of public, zs_internal and extensions);
//                            <file>.manifest.json is written next to it. Neither may exist.
// pg_dump comes from PG_DUMP or PATH and verifies TLS against the pinned CA (verify-full).
// Prints the manifest: ref, archive name, size, sha256, start time, ledger. No credentials.
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "pg-connection-string";
import { takeBackup } from "../hosted-backup.js";
import { assertHostedDatabaseUrl, hostedPool, redactSecrets } from "../hosted.js";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Pass --out <file>");
const target = assertHostedDatabaseUrl(process.env.SERVICE_DATABASE_URL ?? "", {
  projectRef: process.env.ZS_TARGET_REF ?? "", role: "postgres",
});
// pg_dump needs one server session for the whole dump: the transaction pooler cannot do that.
if (target.port !== "5432") throw new Error("Refusing to run: back up through the session pooler, port 5432");
const url = parse(target.connectionString);
const pool = hostedPool(target, 1);

try {
  const manifest = await takeBackup({
    pool,
    connection: { host: target.host, port: target.port, user: url.user ?? "", password: url.password ?? "", database: url.database ?? "" },
    rootCertFile: fileURLToPath(new URL("../../../../supabase/hosted/supabase-root-2021-ca.crt", import.meta.url)),
    projectRef: target.projectRef,
    out: resolve(values.out),
    clock: { now: () => new Date() },
    pgDump: process.env.PG_DUMP,
    searchPath: process.env.PATH,
  });
  console.log(JSON.stringify({ ...manifest, archive: resolve(values.out), ledger: manifest.ledger.map((row) => row.name) }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await pool.end();
}
