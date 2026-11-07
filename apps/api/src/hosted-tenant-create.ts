// The hosted run of tenant:create (industry-templates.md IT-9), owner-run only: the same
// createTenant and runTenantCreate as the local step, with the Supabase Auth admin API in place of
// the auth stub and the guards of db:hosted-provision-owner (project-bound service URL and key,
// exactly one mode, a receipt reserved first, a recent project-bound backup before the apply).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { assertHostedDatabaseUrl, describeHosted, type HostedDatabaseTarget } from "./hosted.js";
import { assertServiceKey, type SupabaseAuthAdmin } from "./supabase-auth-admin.js";
import { createTenant, readTenantState, runTenantCreate, type TenantCreateSummary } from "./tenant-create.js";

export interface HostedTenantCreateConfig {
  readonly key: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly timeZone?: string;
  readonly mode: { mode: "dry-run" } | { mode: "apply"; receiptPath: string; backupPath: string };
  /** SERVICE_DATABASE_URL, checked: postgres.<ref> on a Supabase pooler. */
  readonly target: HostedDatabaseTarget;
  readonly serviceKey: string;
}

/**
 * Arguments and environment, validated before anything connects:
 *   --key <slug> --name <name> --owner-email <addr> [--time-zone <zone>] --dry-run
 *   ... --apply --backup <file> --receipt <file>
 * with ZS_TARGET_REF, SERVICE_DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
export function parseHostedTenantCreateArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): HostedTenantCreateConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      key: { type: "string" },
      name: { type: "string" },
      "owner-email": { type: "string" },
      "time-zone": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      backup: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (!values.key || !values.name || !values["owner-email"]) throw new Error("Pass --key <slug>, --name <name> and --owner-email <addr>");
  if (values["dry-run"] === values.apply) throw new Error("Pass exactly one of --dry-run or --apply");
  if (values.apply && (!values.backup || !values.receipt)) throw new Error("--apply needs --backup <file> and --receipt <file>");
  if (values["dry-run"] && (values.backup || values.receipt)) throw new Error("--backup and --receipt go with --apply only");
  const projectRef = env.ZS_TARGET_REF ?? "";
  const target = assertHostedDatabaseUrl(env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
  const serviceKey = assertServiceKey(env.SUPABASE_SERVICE_ROLE_KEY, projectRef);
  return {
    key: values.key,
    name: values.name,
    ownerEmail: values["owner-email"],
    // An explicit empty zone is passed on, so the zone check refuses it instead of reading it as omitted.
    ...(values["time-zone"] !== undefined ? { timeZone: values["time-zone"] } : {}),
    mode: values.apply ? { mode: "apply", receiptPath: resolve(values.receipt!), backupPath: resolve(values.backup!) } : { mode: "dry-run" },
    target,
    serviceKey,
  };
}

export interface HostedTenantCreateDeps {
  readonly service: Pool;
  readonly auth: SupabaseAuthAdmin;
  readonly checkBackup: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export function runHostedTenantCreate(config: HostedTenantCreateConfig, deps: HostedTenantCreateDeps): Promise<TenantCreateSummary> {
  const createDeps = { service: deps.service, clock: deps.clock, generateId: deps.generateId, auth: deps.auth };
  return runTenantCreate(config.mode, {
    input: { key: config.key, name: config.name, ownerEmail: config.ownerEmail, timeZone: config.timeZone },
    target: { ...describeHosted(config.target), authAdmin: `https://${config.target.projectRef}.supabase.co/auth/v1/admin` },
    create: (input) => createTenant(createDeps, input),
    readState: (tenantId, email) => readTenantState(deps.service, tenantId, email),
    readTenantClaim: (userId) => deps.auth.readTenantClaim(userId),
    checkBackup: deps.checkBackup,
    clock: deps.clock,
    log: deps.log,
    logError: deps.logError,
  });
}
