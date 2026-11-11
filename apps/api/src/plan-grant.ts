// Owner-run grant of a Hub plan to one tenant (docs/requirements/plans.md PL-21..PL-24). The grant
// wins over the tenant's provider subscription while it lasts; this script is the only writer
// (service_role, never the runtime role). Entry points: src/scripts/plan-grant.ts (local) and
// src/scripts/hosted-plan-grant.ts (hosted, project-bound URL and a recent backup).
import { open, type FileHandle } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { hubPlanSchema, uuidSchema, type HubPlan } from "@zs/contracts";
import { clearPlanGrant, PLAN_GRANT_BY_MAX, PLAN_GRANT_NOTE_MAX, readPlanGrant, setPlanGrant, type PlanGrantState } from "@zs/core";
import { asService } from "@zs/db";
import { redactSecrets } from "./hosted.js";

/** What the operator asked for. */
export type PlanGrantRequest =
  | { readonly kind: "set"; readonly plan: HubPlan; readonly until: Date | null; readonly note: string; readonly by: string }
  | { readonly kind: "clear"; readonly by: string };

/** The grant as the receipt and the output show it: plain JSON, no credentials. */
export interface PlanGrantFacts {
  readonly plan: HubPlan;
  readonly until: string | null;
  readonly note: string;
  readonly grantedAt: string;
  readonly grantedBy: string;
}

const facts = (state: PlanGrantState | null): PlanGrantFacts | null =>
  state === null ? null : {
    plan: state.plan, until: state.until?.toISOString() ?? null, note: state.note,
    grantedAt: state.grantedAt.toISOString(), grantedBy: state.grantedBy,
  };

/** Same grant, ignoring when it was written (a dry run and its apply differ only in that). */
const sameGrant = (a: PlanGrantFacts | null, b: PlanGrantFacts | null) =>
  a === null || b === null ? a === b : a.plan === b.plan && a.until === b.until && a.note === b.note && a.grantedBy === b.grantedBy;

export type PlanGrantAction = "granted" | "replaced" | "cleared" | "unchanged";

export interface PlanGrantSummary {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly action: PlanGrantAction;
  /** Who ran it. */
  readonly by: string;
  readonly before: PlanGrantFacts | null;
  readonly after: PlanGrantFacts | null;
  readonly dryRun: boolean;
  readonly notes: readonly string[];
}

const BODY_FLAGS = {
  tenant: { type: "string" },
  plan: { type: "string" },
  until: { type: "string" },
  note: { type: "string" },
  by: { type: "string" },
  clear: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  apply: { type: "boolean", default: false },
  backup: { type: "string" },
  receipt: { type: "string" },
} as const;

function refuse(reason: string): never {
  throw new Error(`Refusing to change a plan grant: ${reason}`);
}

/** PL-24: a date without a time ends at the end of that day, UTC; a full instant carries its offset. */
export function parseGrantUntil(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!dateOnly && !instant) refuse("--until must be a date (2027-01-31) or an instant with its offset (2027-01-31T17:00:00Z)");
  // A Date rolls an impossible day over (30 February becomes 2 March), with or without a time. Check the
  // calendar day on its own first, so a typo cannot move the end of a grant.
  const day = value.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) refuse("--until is not a real date");
  const date = new Date(dateOnly ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(date.getTime())) refuse("--until is not a real date");
  return date;
}

export interface PlanGrantFlags {
  readonly tenantId: string;
  readonly request: PlanGrantRequest;
  readonly mode: { readonly mode: "dry-run" } | { readonly mode: "apply"; readonly receiptPath: string; readonly backupPath?: string };
}

/**
 * The shared argument check, before anything connects:
 *   --tenant <uuid> --plan <solo|studio|pro> [--until <date>] --note <text> --by <name> (--dry-run | --apply ...)
 *   --tenant <uuid> --clear --by <name> (--dry-run | --apply ...)
 * `hosted` makes --backup <file> required with --apply (and refused otherwise); local runs take none.
 */
export function parsePlanGrantFlags(argv: readonly string[], options: { readonly hosted: boolean; readonly resolve: (path: string) => string }): PlanGrantFlags {
  const { values } = parseArgs({ args: [...argv], options: BODY_FLAGS });
  const tenant = uuidSchema.safeParse(values.tenant);
  if (!tenant.success) refuse("pass --tenant <uuid>");
  if (!values.by?.trim()) refuse("pass --by <name>, who is granting");
  const by = values.by.trim();
  if (by.length > PLAN_GRANT_BY_MAX) refuse(`--by is at most ${PLAN_GRANT_BY_MAX} characters`);
  let request: PlanGrantRequest;
  if (values.clear) {
    if (values.plan !== undefined || values.until !== undefined || values.note !== undefined) refuse("--clear goes with --tenant and --by only");
    request = { kind: "clear", by };
  } else {
    const plan = hubPlanSchema.safeParse(values.plan);
    if (!plan.success) refuse("pass --plan solo, studio or pro");
    const note = values.note?.trim() ?? "";
    if (note.length < 1 || note.length > PLAN_GRANT_NOTE_MAX) refuse(`pass --note <text>, 1 to ${PLAN_GRANT_NOTE_MAX} characters`);
    request = { kind: "set", plan: plan.data, until: values.until === undefined ? null : parseGrantUntil(values.until), note, by };
  }
  if (values["dry-run"] === values.apply) refuse("pass exactly one of --dry-run or --apply");
  if (values["dry-run"] && (values.backup !== undefined || values.receipt !== undefined)) refuse("--backup and --receipt go with --apply only");
  if (values.apply) {
    if (!values.receipt) refuse(options.hosted ? "--apply needs --backup <file> and --receipt <file>" : "--apply needs --receipt <file>");
    if (options.hosted && !values.backup) refuse("--apply needs --backup <file> and --receipt <file>");
    if (!options.hosted && values.backup !== undefined) refuse("--backup goes with the hosted script only");
  }
  return {
    tenantId: tenant.data,
    request,
    mode: values.apply
      ? { mode: "apply", receiptPath: options.resolve(values.receipt!), ...(options.hosted ? { backupPath: options.resolve(values.backup!) } : {}) }
      : { mode: "dry-run" },
  };
}

export interface PlanGrantDeps {
  /** A pool whose login may SET ROLE service_role (asService); never the runtime pool. */
  readonly service: Pool;
  readonly clock: { now(): Date };
}

/** Thrown from inside the transaction so asService rolls it back; carries the dry-run report. */
class DryRunRollback extends Error {
  constructor(readonly summary: PlanGrantSummary) {
    super("dry run rolled back");
  }
}

/** The stored grant as service_role (the runner's verify step). */
export async function readGrantFacts(service: Pool, tenantId: string): Promise<PlanGrantFacts | null> {
  return facts(await asService(service, (tx) => readPlanGrant(tx, tenantId)));
}

/**
 * PL-24: sets, replaces or clears the tenant's grant in one service_role transaction under the
 * tenant's plan lock. Refuses an unknown tenant. A dry run does everything, then rolls back.
 * Clearing a tenant with no grant is "unchanged". No provider row is read or written.
 */
export async function planGrant(deps: PlanGrantDeps, input: { readonly tenantId: string; readonly request: PlanGrantRequest; readonly dryRun: boolean }): Promise<PlanGrantSummary> {
  const tenant = uuidSchema.safeParse(input.tenantId);
  if (!tenant.success) refuse("the tenant id must be a UUID");
  const tenantId = tenant.data;
  try {
    return await asService(deps.service, async (tx) => {
      const row = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0];
      if (!row) refuse(`tenant ${tenantId} does not exist`);
      const now = deps.clock.now();
      const notes: string[] = [];
      let change;
      let action: PlanGrantAction;
      if (input.request.kind === "clear") {
        change = await clearPlanGrant(tx, { tenantId, now });
        action = change.before === null ? "unchanged" : "cleared";
        if (action === "unchanged") notes.push("The tenant has no grant; nothing changed.");
      } else {
        const { plan, until, note, by } = input.request;
        change = await setPlanGrant(tx, { tenantId, plan, until, note, by, now });
        action = change.before === null ? "granted" : "replaced";
      }
      const summary: PlanGrantSummary = {
        tenantId, tenantName: row.name, action, by: input.request.by,
        before: facts(change.before), after: facts(change.after), dryRun: input.dryRun, notes,
      };
      if (input.dryRun) throw new DryRunRollback(summary);
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}

/** Where an --apply run stopped; the receipt names it. */
export type PlanGrantPhase = "dry-run" | "backup-check" | "apply" | "verify";

/** `backupPath`: a backup that must pass `checkBackup` before the apply (hosted always sets it). */
export type PlanGrantMode = PlanGrantFlags["mode"];

export interface PlanGrantRunDeps {
  readonly input: { readonly tenantId: string; readonly request: PlanGrantRequest };
  /** Non-secret facts about the target (describeDatabase / describeHosted), copied into the output. */
  readonly target: Record<string, string>;
  /** planGrant bound to its deps. */
  readonly grant: (input: { readonly tenantId: string; readonly request: PlanGrantRequest; readonly dryRun: boolean }) => Promise<PlanGrantSummary>;
  /** readGrantFacts bound to the service pool. */
  readonly readGrant: (tenantId: string) => Promise<PlanGrantFacts | null>;
  /** Checks the backup named by the mode's backupPath and returns its facts for the receipt. */
  readonly checkBackup?: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

const describeError = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));

/**
 * The flow behind the plan-grant entry points, in the shape of runProvisionOwner. --dry-run prints
 * what would change. --apply reserves the receipt ("wx") before it touches the database, runs a
 * dry run, checks the backup when the mode names one, applies, reads the grant back and always
 * writes the outcome: result, the phase that failed, the redacted error, and whether anything
 * committed (false before the apply phase; read back from the row after it).
 */
export async function runPlanGrant(mode: PlanGrantMode, deps: PlanGrantRunDeps): Promise<PlanGrantSummary> {
  const startedAt = deps.clock.now().toISOString();
  if (mode.mode === "dry-run") {
    const plan = await deps.grant({ ...deps.input, dryRun: true });
    deps.log(JSON.stringify({ mode: "dry-run", startedAt, target: deps.target, plan, result: "rolled back" }, null, 2));
    return plan;
  }

  const checkBackup = deps.checkBackup;
  if (mode.backupPath !== undefined && !checkBackup) throw new Error("A backup path needs a checkBackup dependency");
  // An existing file or a missing folder fails here, before any database work.
  const receiptFile: FileHandle = await open(mode.receiptPath, "wx");
  const receipt: Record<string, unknown> = { mode: "apply", startedAt, target: deps.target, tenantId: deps.input.tenantId, by: deps.input.request.by };
  let phase: PlanGrantPhase = "dry-run";
  let failure: unknown;
  let plan: PlanGrantSummary | undefined;
  let applied: PlanGrantSummary | undefined;
  try {
    plan = await deps.grant({ ...deps.input, dryRun: true });
    receipt.plan = plan;

    if (mode.backupPath !== undefined) {
      phase = "backup-check";
      receipt.backup = { file: mode.backupPath, ...(await checkBackup!(mode.backupPath)) };
    }

    phase = "apply";
    applied = await deps.grant({ ...deps.input, dryRun: false });
    receipt.applied = applied;

    phase = "verify";
    const after = await deps.readGrant(applied.tenantId);
    receipt.after = after;
    if (!sameGrant(after, applied.after)) throw new Error("The grant read back does not match what was applied");
  } catch (error) {
    failure = error;
  }

  // Nothing can commit before the apply phase. From it on the row is the evidence, also when a
  // COMMIT reply was lost: the change is one transaction, so the row is either before or after.
  let committed: boolean | "unknown" = false;
  if (phase === "apply" && plan) {
    if (plan.action === "unchanged") committed = false;
    else {
      try {
        const after = await deps.readGrant(plan.tenantId);
        receipt.after = after;
        // Unchanged to the second means the write did not land; the facts of the dry run mean it did.
        committed = JSON.stringify(after) === JSON.stringify(plan.before) ? false : sameGrant(after, plan.after) ? true : "unknown";
      } catch (error) {
        receipt.after = `unreadable: ${describeError(error)}`;
        committed = "unknown";
      }
    }
  } else if (phase === "verify" && applied) {
    // grant() returned, so its transaction committed; a failed read-back does not undo that.
    committed = applied.action !== "unchanged";
  }
  receipt.committed = committed;
  receipt.result = failure ? "failed" : applied!.action === "unchanged" ? "unchanged" : "committed";
  if (failure) {
    receipt.failedPhase = phase;
    receipt.error = describeError(failure);
  }
  receipt.finishedAt = deps.clock.now().toISOString();
  try {
    await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  } catch (error) {
    // Print the receipt so the evidence is not lost.
    deps.logError(JSON.stringify({ receiptWriteFailed: describeError(error), receipt }, null, 2));
    failure ??= error;
  } finally {
    await receiptFile.close().catch(() => undefined);
  }
  if (failure) throw failure;
  deps.log(JSON.stringify({ result: receipt.result, ...applied!, receipt: mode.receiptPath }, null, 2));
  return applied!;
}
