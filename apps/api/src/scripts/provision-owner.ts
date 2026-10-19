// Entry point, owner-run, local only: make <email> an owner of <tenant> (src/provision-owner.ts).
// Hosted projects use src/scripts/hosted-provision-owner.ts (db:hosted-provision-owner).
//   DATABASE_URL   the local admin URL (loopback only); writes run as service_role
// Modes:
//   --tenant <uuid> --email <addr> --dry-run                     report what would change, roll back
//   --tenant <uuid> --email <addr> --apply --receipt <file>      --receipt must not exist yet; it is
//                                                                reserved first and always records
//                                                                the outcome
// The Supabase user is looked up, and given the tenant claim, in the local auth stub's
// auth.users (seed:demo installs it).
// Output and the receipt hold ids, names and role facts only, never credentials.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { findAuthUserByEmail, readAuthUserTenant, setAuthUserTenant } from "@zs/db/local-auth";
import { assertLocalDatabaseUrl, describeDatabase } from "../config.js";
import { redactSecrets } from "../hosted.js";
import { provisionOwner, readMemberByEmail, runProvisionOwner } from "../provision-owner.js";

const { values } = parseArgs({
  options: {
    tenant: { type: "string" },
    email: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    receipt: { type: "string" },
  },
});
if (!values.tenant || !values.email) throw new Error("Pass --tenant <uuid> and --email <addr>");
if (values["dry-run"] === values.apply) throw new Error("Pass exactly one of --dry-run or --apply");
if (values.apply && !values.receipt) throw new Error("--apply needs --receipt <file>");
if (values["dry-run"] && values.receipt) throw new Error("--receipt goes with --apply only");

const target = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
const pool = new Pool({ connectionString: target.connectionString, max: 2 });
const clock = { now: () => new Date() };

// The local auth stub stands in for the Supabase Auth admin API (it only exists on loopback).
const auth = {
  findUser: (email: string) => findAuthUserByEmail(pool, email),
  setTenantClaim: (userId: string, tenantId: string) => setAuthUserTenant(pool, userId, tenantId),
};

const deps = { service: pool, clock, generateId: randomUUID, auth };
try {
  await runProvisionOwner(
    values.apply ? { mode: "apply", receiptPath: resolve(values.receipt!) } : { mode: "dry-run" },
    {
      input: { tenantId: values.tenant, email: values.email },
      target: describeDatabase(target),
      provision: (input) => provisionOwner(deps, input),
      readMember: (tenantId, email) => readMemberByEmail(pool, tenantId, email),
      readTenantClaim: (userId) => readAuthUserTenant(pool, userId),
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
