// Entry point, owner-run, local only (industry-templates.md IT-9): create a tenant with an id
// derived from --key, set its time zone when given, and provision its owner (pending until the
// owner's user exists; rerun to bind it). Hosted projects use src/scripts/hosted-tenant-create.ts.
//   DATABASE_URL   the local admin URL (loopback only); writes run as service_role
//   --key <slug> --name <name> --owner-email <addr> [--time-zone <zone>] [--dry-run]
// The owner's user is looked up, and given the tenant claim, in the local auth stub's auth.users.
// Output holds ids, names and role facts only, never credentials.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { findAuthUserByEmail, readAuthUserTenant, setAuthUserTenant } from "@zs/db/local-auth";
import { assertLocalDatabaseUrl, describeDatabase } from "../config.js";
import { redactSecrets } from "../hosted.js";
import { createTenant, readTenantState, runTenantCreate } from "../tenant-create.js";

let pool: Pool | undefined;
try {
  const { values } = parseArgs({
    options: {
      key: { type: "string" },
      name: { type: "string" },
      "owner-email": { type: "string" },
      "time-zone": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.key || !values.name || !values["owner-email"]) throw new Error("Pass --key <slug>, --name <name> and --owner-email <addr>");
  const target = assertLocalDatabaseUrl(process.env.DATABASE_URL ?? "");
  // Three connections at once: the lock holder, the open service transaction, and the auth stub's own query.
  const service = new Pool({ connectionString: target.connectionString, max: 4 });
  pool = service;
  const clock = { now: () => new Date() };
  // The local auth stub stands in for the Supabase Auth admin API (it only exists on loopback).
  const auth = {
    findUser: (email: string) => findAuthUserByEmail(service, email),
    setTenantClaim: (userId: string, tenantId: string) => setAuthUserTenant(service, userId, tenantId),
  };
  const deps = { service, clock, generateId: randomUUID, auth };
  await runTenantCreate(values["dry-run"] ? { mode: "dry-run" } : { mode: "apply" }, {
    input: { key: values.key, name: values.name, ownerEmail: values["owner-email"], timeZone: values["time-zone"] },
    target: describeDatabase(target),
    create: (input) => createTenant(deps, input),
    readState: (tenantId, email) => readTenantState(service, tenantId, email),
    readTenantClaim: (userId) => readAuthUserTenant(service, userId),
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
