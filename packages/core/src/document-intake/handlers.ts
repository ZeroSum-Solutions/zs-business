// Document intake actions (docs/requirements/document-intake.md DL-3..DL-15) through the shared
// dispatcher: queue an upload, record the worker's rows as one diff, fail a job, apply the approved
// rows, discard a job. Every write is one transaction. A stale lease, a changed diff or a changed
// target throws Conflict, which rolls back: nothing is half written.
import {
  CATALOG_INTAKE_APPLY_ACTION,
  CATALOG_INTAKE_DISCARD_ACTION,
  CATALOG_INTAKE_FAIL_ACTION,
  CATALOG_INTAKE_RESULT_ACTION,
  CATALOG_INTAKE_UPLOAD_ACTION,
  Conflict,
  DOCUMENT_INTAKE_JOB_TARGET,
  INTAKE_MAX_PAGES,
  NotFound,
  TenantDenied,
  ValidationFailed,
  doclingResultSchema,
  intakeApplyCommandSchema,
  intakeDiscardCommandSchema,
  intakeFailCommandSchema,
  intakeResultCommandSchema,
  intakeUploadCommandSchema,
  type CatalogFields,
  type DoclingResult,
  type IntakeWorkerOutcome,
  type JsonValue,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { getBusinessProfile } from "../business/handlers.js";
import { clockInstant, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { buildDiff, countOps, diffDigest, mapResult, resultDigest, type LiveItem } from "./mapping.js";

/** The principal that runs the worker's result and fail actions (agents.md G-1 pattern). */
export const intakeWorkerActorId = (tenantId: string): string => derivedId(tenantId, "document-intake-worker", "actor");
/** The job an upload gets: derived from its key, so a retried upload is the same job. */
export const intakeJobId = (tenantId: string, key: string): string => derivedId(tenantId, key, "document_intake_job");

/** What the worker's result action carries beside its payload (the rows are too large for it). */
export type IntakeDispatchConfig = {
  readonly intakeResult?: unknown;
};

export const INTAKE_SOURCE = "document_intake";
const CHUNK = 100;

async function resolveJob(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== DOCUMENT_INTAKE_JOB_TARGET) throw new ValidationFailed("Document intake actions require a document_intake_job target");
  if (!(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: DOCUMENT_INTAKE_JOB_TARGET, id: target.id };
}

interface JobState {
  status: string;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  diff_digest: string | null;
}
async function lockJob(tx: Transaction, tenantId: string, jobId: string): Promise<JobState> {
  const job = (await tx.query<JobState>(
    "SELECT status::text AS status, attempts, lease_token, lease_expires_at, diff_digest FROM document_intake_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenantId, jobId],
  )).rows[0];
  if (!job) throw new NotFound();
  return job;
}
const leaseLost = () => new Conflict("The lease is no longer held", { reason: "lease_lost" });
/** DL-5: the lease is live while the job is claimed under this token and attempt and `at` is before its expiry. */
function requireLease(job: JobState, token: string, attempt: number, at: string): void {
  if (job.status !== "claimed" || job.lease_token !== token || job.attempts !== attempt) throw leaseLost();
  if (job.lease_expires_at === null || job.lease_expires_at.getTime() <= new Date(at).getTime()) throw leaseLost();
}
const notInReview = () => new Conflict("The job is not waiting for review", { reason: "intake_not_in_review" });

export const uploadIntakeHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(intakeUploadCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const at = clockInstant(now);
    try {
      await tx.query(
        `INSERT INTO document_intake_jobs (tenant_id,id,target_kind,source,filename,file_sha256,byte_length,status,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)`,
        [binding.tenantId, payload.jobId, payload.targetKind, payload.source, payload.filename, payload.fileSha256, payload.byteLength, binding.actorId, at],
      );
    } catch (error) {
      if (pgCode(error) === "23505") throw new Conflict("The job ID is already in use", { reason: "id_in_use" });
      throw error;
    }
    return { result: { jobId: payload.jobId, status: "queued" } as JsonValue, event: { type: "catalog.intake.queued", payload: { jobId: payload.jobId } } };
  },
};

interface FailArgs {
  readonly tx: Transaction;
  readonly tenantId: string;
  readonly jobId: string;
  readonly reason: string;
  readonly at: string;
}
async function markFailed({ tx, tenantId, jobId, reason, at }: FailArgs): Promise<IntakeWorkerOutcome> {
  await tx.query(
    "UPDATE document_intake_jobs SET status='failed', failure_reason=$3, finished_at=$4 WHERE tenant_id=$1 AND id=$2",
    [tenantId, jobId, reason, at],
  );
  return { jobId, status: "failed", failureReason: reason as IntakeWorkerOutcome["failureReason"], diffDigest: null, counts: null };
}

export const failIntakeHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now }) {
    if (binding.actorId !== intakeWorkerActorId(binding.tenantId)) throw new TenantDenied();
    const { payload } = parseOrFail(intakeFailCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const at = clockInstant(now);
    const job = await lockJob(tx, binding.tenantId, payload.jobId);
    requireLease(job, payload.leaseToken, payload.attempt, at);
    const outcome = await markFailed({ tx, tenantId: binding.tenantId, jobId: payload.jobId, reason: payload.reason, at });
    return { result: outcome as unknown as JsonValue, event: { type: "catalog.intake.failed", payload: { jobId: payload.jobId, reason: payload.reason } } };
  },
};

interface LiveRow {
  id: string; sku: string; title: string; description: string; price_minor: string; currency: string;
  attributes: Record<string, string>; active: boolean; revision: number;
}
const liveFields = (row: LiveRow): CatalogFields => ({
  sku: row.sku, title: row.title, description: row.description, priceMinor: Number(row.price_minor), currency: row.currency,
  attributes: row.attributes, active: row.active,
});

export const resultIntakeHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now, generateId, config }) {
    if (binding.actorId !== intakeWorkerActorId(binding.tenantId)) throw new TenantDenied();
    const { payload } = parseOrFail(intakeResultCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const result: DoclingResult = parseOrFail(doclingResultSchema, (config as IntakeDispatchConfig).intakeResult);
    if (resultDigest(result) !== payload.resultDigest || result.pageCount !== payload.pageCount || result.parserVersion !== payload.parserVersion)
      throw new ValidationFailed("The result does not match its digest");
    if (result.pageCount > INTAKE_MAX_PAGES) throw new ValidationFailed("The document has too many pages");
    const at = clockInstant(now);
    const job = await lockJob(tx, binding.tenantId, payload.jobId);
    requireLease(job, payload.leaseToken, payload.attempt, at);

    const profile = await getBusinessProfile(tx, binding.tenantId);
    const mapped = mapResult(result, profile.currency);
    const skus = [...new Set(mapped.flatMap((row) => (row.fields ? [row.fields.sku] : [])))];
    const live = new Map<string, LiveItem>();
    if (skus.length > 0) {
      const found = (await tx.query<LiveRow>(
        `SELECT id, sku, title, description, price_minor::text AS price_minor, currency, attributes, active, revision
           FROM catalog_items WHERE tenant_id=$1 AND sku = ANY($2::text[])`, [binding.tenantId, skus])).rows;
      for (const row of found) live.set(row.sku, { id: row.id, revision: row.revision, fields: liveFields(row) });
    }
    const rows = buildDiff(mapped, live);
    const digest = diffDigest(rows);
    await tx.query(
      "UPDATE document_intake_jobs SET status='review', page_count=$3, parser_version=$4, diff_digest=$5 WHERE tenant_id=$1 AND id=$2",
      [binding.tenantId, payload.jobId, result.pageCount, result.parserVersion, digest],
    );
    for (let from = 0; from < rows.length; from += CHUNK) {
      const chunk = rows.slice(from, from + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((row, i) => {
        const b = i * 13;
        values.push(
          binding.tenantId, generateId(), payload.jobId, row.rowIndex, row.diffOp, row.invalidReason, row.existingTargetId, row.existingRevision,
          JSON.stringify({ proposed: row.proposed, current: row.current, changedFields: row.changedFields, cells: row.cells }),
          row.pageNo, JSON.stringify(row.bbox), row.snippet, row.included,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::intake_diff_op,$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb,$${b + 10},$${b + 11}::jsonb,$${b + 12},$${b + 13})`;
      });
      await tx.query(
        `INSERT INTO document_intake_rows (tenant_id,id,job_id,row_index,diff_op,invalid_reason,existing_target_id,existing_revision,
           proposed_payload,page_no,bbox,source_snippet,included) VALUES ${tuples.join(",")}`, values);
    }
    const counts = countOps(rows);
    const outcome: IntakeWorkerOutcome = { jobId: payload.jobId, status: "review", failureReason: null, diffDigest: digest, counts };
    return { result: outcome as unknown as JsonValue, event: { type: "catalog.intake.review", payload: { jobId: payload.jobId, ...counts } } };
  },
};

interface StoredRow {
  id: string; row_index: number; diff_op: string; existing_target_id: string | null; existing_revision: number | null;
  proposed_payload: { proposed: CatalogFields | null }; page_no: number;
}

export const applyIntakeHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now, generateId }) {
    const { payload } = parseOrFail(intakeApplyCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const at = clockInstant(now);
    const job = await lockJob(tx, binding.tenantId, payload.jobId);
    if (job.status !== "review") throw notInReview();
    if (job.diff_digest !== payload.diffDigest) throw new Conflict("The proposed changes changed", { reason: "intake_changed" });
    const rows = (await tx.query<StoredRow>(
      `SELECT id, row_index, diff_op::text AS diff_op, existing_target_id, existing_revision, proposed_payload, page_no
         FROM document_intake_rows WHERE tenant_id=$1 AND job_id=$2 AND id = ANY($3::uuid[]) ORDER BY row_index`,
      [binding.tenantId, payload.jobId, payload.includedRowIds])).rows;
    if (rows.length !== payload.includedRowIds.length) throw new ValidationFailed("A listed row is not part of this job");
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const fields = row.proposed_payload.proposed;
      if ((row.diff_op !== "insert" && row.diff_op !== "update") || !fields) throw new ValidationFailed("Only new and changed rows can be applied");
      let itemId: string;
      if (row.diff_op === "insert") {
        itemId = generateId();
        await tx.query(
          `INSERT INTO catalog_items (tenant_id,id,sku,title,description,price_minor,currency,attributes,active,revision,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,1,$10,$10)`,
          [binding.tenantId, itemId, fields.sku, fields.title, fields.description, fields.priceMinor, fields.currency,
            JSON.stringify(fields.attributes), fields.active, at],
        );
        inserted += 1;
      } else {
        itemId = row.existing_target_id!;
        const done = await tx.query(
          `UPDATE catalog_items SET title=$4, description=$5, price_minor=$6, currency=$7, attributes=$8::jsonb, active=$9,
             revision=revision+1, updated_at=$10 WHERE tenant_id=$1 AND id=$2 AND revision=$3`,
          [binding.tenantId, itemId, row.existing_revision, fields.title, fields.description, fields.priceMinor, fields.currency,
            JSON.stringify(fields.attributes), fields.active, at],
        );
        if (done.rowCount !== 1) throw new Conflict("The catalog item changed since the review", { reason: "intake_target_changed" });
        updated += 1;
      }
      // DL-12: the source record names the job, the page and the row.
      await tx.query(
        `INSERT INTO source_records (tenant_id,id,subject_type,subject_id,source,source_ref,observed_at,fresh_until,revision,recorded_by,recorded_at,updated_at)
         VALUES ($1,$2,'catalog_item',$3,$4,$5,$6,NULL,1,$7,$6,$6)
         ON CONFLICT (tenant_id,subject_type,subject_id,source) DO UPDATE
           SET source_ref=EXCLUDED.source_ref, observed_at=EXCLUDED.observed_at, fresh_until=NULL,
               revision=source_records.revision+1, updated_at=EXCLUDED.updated_at`,
        [binding.tenantId, derivedId(binding.tenantId, "catalog_item", itemId, INTAKE_SOURCE, "source-record"), itemId, INTAKE_SOURCE, `${payload.jobId}:p${row.page_no}#r${row.row_index}`, at, binding.actorId],
      );
    }
    await tx.query("UPDATE document_intake_rows SET included=false WHERE tenant_id=$1 AND job_id=$2 AND included", [binding.tenantId, payload.jobId]);
    await tx.query("UPDATE document_intake_rows SET included=true WHERE tenant_id=$1 AND job_id=$2 AND id = ANY($3::uuid[])", [binding.tenantId, payload.jobId, payload.includedRowIds]);
    await tx.query("UPDATE document_intake_jobs SET status='applied', finished_at=$3 WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.jobId, at]);
    return {
      result: { jobId: payload.jobId, status: "applied", inserted, updated } as JsonValue,
      event: { type: "catalog.intake.applied", payload: { jobId: payload.jobId, inserted, updated } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "catalog_items_sku_unique")
      return new Conflict("A catalog item with that SKU now exists", { reason: "intake_target_changed" });
    return undefined;
  },
};

export const discardIntakeHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(intakeDiscardCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const job = await lockJob(tx, binding.tenantId, payload.jobId);
    if (job.status !== "review") throw notInReview();
    await tx.query("UPDATE document_intake_jobs SET status='discarded', finished_at=$3 WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.jobId, clockInstant(now)]);
    return { result: { jobId: payload.jobId, status: "discarded" } as JsonValue, event: { type: "catalog.intake.discarded", payload: { jobId: payload.jobId } } };
  },
};

export const documentIntakeHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CATALOG_INTAKE_UPLOAD_ACTION]: uploadIntakeHandler,
  [CATALOG_INTAKE_RESULT_ACTION]: resultIntakeHandler,
  [CATALOG_INTAKE_FAIL_ACTION]: failIntakeHandler,
  [CATALOG_INTAKE_APPLY_ACTION]: applyIntakeHandler,
  [CATALOG_INTAKE_DISCARD_ACTION]: discardIntakeHandler,
});
