// Entry point, owner-run: seed the invented Halden & Rowe tenant into one hosted Supabase
// project. Fake data only. Does not migrate (hosted-migrate.ts does, as zs_migrator).
//   ZS_TARGET_REF              the project ref; both URLs (and the key) must name it
//   SERVICE_DATABASE_URL       postgres.<ref> on the session pooler (may SET ROLE service_role)
//   RUNTIME_DATABASE_URL       zs_runtime.<ref> on the pooler
//   --owner-email <addr>       optional: make this person the tenant's owner through the same
//                              provisionOwner as db:hosted-provision-owner (needs
//                              SUPABASE_SERVICE_ROLE_KEY for the Auth admin API). Without it the
//                              tenant has no member until that step runs.
// Prints the summary (ids and counts, no credentials) and no token.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import { assertHostedDatabaseUrl, describeHosted } from "../hosted.js";
import { seedHostedDemo } from "../seed/demo.js";
import { assertServiceKey, createSupabaseAuthAdmin } from "../supabase-auth-admin.js";

const { values } = parseArgs({ options: { "owner-email": { type: "string" } } });
const projectRef = process.env.ZS_TARGET_REF ?? "";
const service = assertHostedDatabaseUrl(process.env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
const runtime = assertHostedDatabaseUrl(process.env.RUNTIME_DATABASE_URL ?? "", { projectRef, role: "zs_runtime" });
const owner = values["owner-email"] === undefined ? undefined : {
  email: values["owner-email"],
  auth: createSupabaseAuthAdmin({ projectRef, serviceKey: assertServiceKey(process.env.SUPABASE_SERVICE_ROLE_KEY, projectRef) }),
};

const summary = await seedHostedDemo({ service, runtime, clock: { now: () => new Date() }, generateId: randomUUID, ...(owner ? { owner } : {}) });
console.log(JSON.stringify({ ...summary, target: describeHosted(runtime) }, null, 2));
