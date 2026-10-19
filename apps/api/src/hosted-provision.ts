// The hosted owner-provisioning flow behind src/scripts/hosted-provision-owner.ts: the same
// provisionOwner and runProvisionOwner as the local step, with the Supabase Auth admin API in
// place of the auth stub and the guards of db:hosted-migrate (project-bound URL, exactly one
// mode, a receipt reserved first, a recent project-bound backup before the apply).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { describeHosted, assertHostedDatabaseUrl, type HostedDatabaseTarget } from "./hosted.js";
import {
  provisionOwner,
  readMemberByEmail,
  runProvisionOwner,
  type ProvisionOwnerMode,
  type ProvisionOwnerSummary,
} from "./provision-owner.js";
import { assertServiceKey, type SupabaseAuthAdmin } from "./supabase-auth-admin.js";

export interface HostedProvisionConfig {
  readonly tenantId: string;
  readonly email: string;
  readonly mode: { mode: "dry-run" } | { mode: "apply"; receiptPath: string; backupPath: string };
  /** SERVICE_DATABASE_URL, checked: postgres.<ref> on a Supabase pooler. */
  readonly target: HostedDatabaseTarget;
  /** The project's service_role key, checked against ZS_TARGET_REF where it names a project. */
  readonly serviceKey: string;
}

/**
 * Arguments and environment, validated before anything connects:
 *   --tenant <uuid> --email <addr> --dry-run
 *   --tenant <uuid> --email <addr> --apply --backup <file> --receipt <file>
 * with ZS_TARGET_REF, SERVICE_DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
export function parseHostedProvisionArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): HostedProvisionConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      tenant: { type: "string" },
      email: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      backup: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (!values.tenant || !values.email) throw new Error("Pass --tenant <uuid> and --email <addr>");
  if (values["dry-run"] === values.apply) throw new Error("Pass exactly one of --dry-run or --apply");
  if (values.apply && (!values.backup || !values.receipt)) throw new Error("--apply needs --backup <file> and --receipt <file>");
  if (values["dry-run"] && (values.backup || values.receipt)) throw new Error("--backup and --receipt go with --apply only");
  const projectRef = env.ZS_TARGET_REF ?? "";
  const target = assertHostedDatabaseUrl(env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
  const serviceKey = assertServiceKey(env.SUPABASE_SERVICE_ROLE_KEY, projectRef);
  return {
    tenantId: values.tenant,
    email: values.email,
    mode: values.apply ? { mode: "apply", receiptPath: resolve(values.receipt!), backupPath: resolve(values.backup!) } : { mode: "dry-run" },
    target,
    serviceKey,
  };
}

export interface HostedProvisionDeps {
  /** A pool for config.target (hostedPool); asService runs the writes as service_role. */
  readonly service: Pool;
  readonly auth: SupabaseAuthAdmin;
  /** checkBackup from hosted-backup.ts, bound to the project, the live ledger and tables. */
  readonly checkBackup: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export function runHostedProvisionOwner(config: HostedProvisionConfig, deps: HostedProvisionDeps): Promise<ProvisionOwnerSummary> {
  const provisionDeps = { service: deps.service, clock: deps.clock, generateId: deps.generateId, auth: deps.auth };
  const mode: ProvisionOwnerMode = config.mode;
  return runProvisionOwner(mode, {
    input: { tenantId: config.tenantId, email: config.email },
    target: { ...describeHosted(config.target), authAdmin: `https://${config.target.projectRef}.supabase.co/auth/v1/admin` },
    provision: (input) => provisionOwner(provisionDeps, input),
    readMember: (tenantId, email) => readMemberByEmail(deps.service, tenantId, email),
    readTenantClaim: (userId) => deps.auth.readTenantClaim(userId),
    checkBackup: deps.checkBackup,
    clock: deps.clock,
    log: deps.log,
    logError: deps.logError,
  });
}
