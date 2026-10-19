// Entry point, owner-run: seed the invented Halden & Rowe tenant into one hosted Supabase
// project. Fake data only. Does not migrate (hosted-migrate.ts does, as zs_migrator).
//   ZS_TARGET_REF              the project ref; both URLs must name it
//   SERVICE_DATABASE_URL       postgres.<ref> on the session pooler (may SET ROLE service_role)
//   RUNTIME_DATABASE_URL       zs_runtime.<ref> on the pooler
// Takes no arguments. The tenant is left with no member; the summary's nextSteps are the
// db:hosted-provision-owner commands (dry run, backup, apply with a receipt) that give it an owner.
// Prints the summary (ids and counts, no credentials) and no token.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { assertHostedDatabaseUrl, describeHosted } from "../hosted.js";
import { assertNoHostedSeedArgs, seedHostedDemo } from "../seed/demo.js";

assertNoHostedSeedArgs(process.argv.slice(2));
const projectRef = process.env.ZS_TARGET_REF ?? "";
const service = assertHostedDatabaseUrl(process.env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
const runtime = assertHostedDatabaseUrl(process.env.RUNTIME_DATABASE_URL ?? "", { projectRef, role: "zs_runtime" });

const summary = await seedHostedDemo({ service, runtime, clock: { now: () => new Date() }, generateId: randomUUID });
console.log(JSON.stringify({ ...summary, target: describeHosted(runtime) }, null, 2));
