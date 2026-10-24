// Document intake edge (docs/requirements/document-intake.md DL-3..DL-16). Two doors:
//  - the member's: upload a PDF, list and read jobs, propose the apply (an approval), discard.
//    Owners only (`publish`). Staff are refused before any byte is stored.
//  - the worker's: claim, fetch the file, post the result, post a failure. The route has already
//    checked the worker token. Every call after the claim names a job and a lease token; the
//    token alone says which tenant the job belongs to, so a worker never names a tenant (DL-5).
// The worker's writes dispatch as a server-built principal that may run only result and fail.
import { createHash } from "node:crypto";
import {
  CATALOG_INTAKE_APPLY_ACTION,
  CATALOG_INTAKE_DISCARD_ACTION,
  CATALOG_INTAKE_FAIL_ACTION,
  CATALOG_INTAKE_RESULT_ACTION,
  CATALOG_INTAKE_UPLOAD_ACTION,
  Conflict,
  DOCUMENT_INTAKE_JOB_TARGET,
  DOCUMENT_INTAKE_WORKER_PREFIX,
  INTAKE_FILE_RETENTION_MS,
  INTAKE_LEASE_MS,
  INTAKE_MAX_ATTEMPTS,
  INTAKE_MAX_BYTES,
  INTAKE_MAX_PAGES,
  NotFound,
  Refused,
  TenantDenied,
  claimedIntakeJobSchema,
  doclingResultSchema,
  filenameSchema,
  idempotencyKeySchema,
  intakeApplyPayloadSchema,
  intakeApplyRequestSchema,
  intakeFailRequestSchema,
  intakeJobDetailSchema,
  intakeJobListSchema,
  intakeResultPayloadSchema,
  intakeFailPayloadSchema,
  intakeUploadPayloadSchema,
  uuidSchema,
  type ActionResult,
  type Bbox,
  type CatalogFields,
  type ClaimedIntakeJob,
  type IntakeDiscardResult,
  type IntakeJob,
  type IntakeJobDetail,
  type IntakeJobList,
  type IntakeRow,
  type IntakeUploadResult,
  type IntakeWorkerOutcome,
  type JsonValue,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { Authorize, EdgeDependencies, Principal } from "../edge/session.js";
import { createSession, directDispatch, memberDispatch, parseInput } from "../edge/session.js";
import { validationError } from "../edge/errors.js";
import { derivedId } from "../edge/ids.js";
import { iso } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import { intakeJobId, intakeWorkerActorId, type IntakeDispatchConfig } from "./handlers.js";
import { resultDigest } from "./mapping.js";
import { intakeFilePath, type IntakeFileStore } from "./port.js";

export interface DocumentIntakeConfig {
  readonly store: IntakeFileStore;
}

/** The lease a worker presents, resolved to the tenant it belongs to. */
interface Lease {
  readonly tenantId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: string;
  readonly fileSha256: string;
  /** True once the injected clock has reached the lease's expiry. */
  readonly expired: boolean;
}

const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const approvalFor = (tenantId: string, key: string) => ({ tenantId, id: derivedId(tenantId, key, "approval") });

export interface UploadInput {
  readonly bytes: Uint8Array;
  readonly filename: unknown;
  readonly contentType: string | null | undefined;
}

interface JobRow {
  id: string;
  target_kind: IntakeJob["targetKind"];
  source: string;
  filename: string;
  byte_length: number;
  page_count: number | null;
  status: IntakeJob["status"];
  failure_reason: IntakeJob["failureReason"];
  parser_version: string | null;
  diff_digest: string | null;
  created_at: Date;
  finished_at: Date | null;
  n_insert: number;
  n_update: number;
  n_unchanged: number;
  n_invalid: number;
}
const jobColumns = `j.id, j.target_kind::text AS target_kind, j.source, j.filename, j.byte_length, j.page_count, j.status::text AS status,
  j.failure_reason, j.parser_version, j.diff_digest, j.created_at, j.finished_at,
  count(r.id) FILTER (WHERE r.diff_op='insert')::int AS n_insert, count(r.id) FILTER (WHERE r.diff_op='update')::int AS n_update,
  count(r.id) FILTER (WHERE r.diff_op='unchanged')::int AS n_unchanged, count(r.id) FILTER (WHERE r.diff_op='invalid')::int AS n_invalid`;
const jobFrom = "FROM document_intake_jobs j LEFT JOIN document_intake_rows r ON r.tenant_id=j.tenant_id AND r.job_id=j.id";

const jobOf = (row: JobRow): IntakeJob => ({
  id: row.id, targetKind: row.target_kind, source: row.source, filename: row.filename, byteLength: row.byte_length,
  pageCount: row.page_count, status: row.status, failureReason: row.failure_reason, parserVersion: row.parser_version,
  diffDigest: row.diff_digest,
  counts: { insert: row.n_insert, update: row.n_update, unchanged: row.n_unchanged, invalid: row.n_invalid },
  createdAt: iso(row.created_at), finishedAt: row.finished_at ? iso(row.finished_at) : null,
});

interface StoredRowView {
  id: string; row_index: number; diff_op: IntakeRow["diffOp"]; invalid_reason: IntakeRow["invalidReason"];
  existing_target_id: string | null; existing_revision: number | null;
  proposed_payload: { proposed: CatalogFields | null; current: CatalogFields | null; changedFields: string[]; cells: string[] };
  page_no: number; bbox: Bbox; source_snippet: string; included: boolean;
}

export function createDocumentIntakeSession(deps: EdgeDependencies, config: DocumentIntakeConfig) {
  const now = () => new Date(deps.clock.now());

  /** The lease for this job and token, if the token is the one the job holds (live or lapsed: see `expired`). */
  async function lease(jobId: string, token: string): Promise<Lease | null> {
    const ids = uuidSchema.safeParse(jobId);
    const secret = uuidSchema.safeParse(token);
    if (!ids.success || !secret.success) return null;
    if (!deps.db.platform) throw new Error("The document intake worker needs the platform transaction");
    const row = await deps.db.platform(async (tx) => (await tx.query<{ tenant_id: string; attempts: number; status: string; file_sha256: string; lease_expires_at: Date | null }>(
      "SELECT tenant_id, attempts, status::text AS status, file_sha256, lease_expires_at FROM document_intake_jobs WHERE id=$1 AND lease_token=$2",
      [ids.data, secret.data])).rows[0]);
    if (!row) return null;
    const expired = row.lease_expires_at === null || row.lease_expires_at.getTime() <= now().getTime();
    return { tenantId: row.tenant_id, jobId: ids.data, attempt: row.attempts, status: row.status, fileSha256: row.file_sha256, expired };
  }
  const leaseLost = () => new Conflict("The lease is no longer held", { reason: "lease_lost" });
  /** DL-5: file, fail and a first result need a claim that is still live. */
  const liveLease = async (jobId: string, token: string): Promise<Lease> => {
    const held = await lease(jobId, token);
    if (!held || held.status !== "claimed" || held.expired) throw leaseLost();
    return held;
  };

  async function workerDispatch(
    held: Lease, actionType: string, key: string, payload: unknown, dispatchConfig: IntakeDispatchConfig = {},
  ): Promise<ActionResult> {
    const run = directDispatch(deps, held.tenantId, intakeWorkerActorId(held.tenantId), only(CATALOG_INTAKE_RESULT_ACTION, CATALOG_INTAKE_FAIL_ACTION), dispatchConfig);
    return run({
      actionType,
      target: { tenantId: held.tenantId, type: DOCUMENT_INTAKE_JOB_TARGET, id: held.jobId },
      approvalReference: approvalFor(held.tenantId, key),
      idempotencyKey: key,
      payload: toJson(payload),
    });
  }

  async function failJob(held: Lease, token: string, reason: IntakeWorkerOutcome["failureReason"]): Promise<IntakeWorkerOutcome> {
    const payload = intakeFailPayloadSchema.parse({ jobId: held.jobId, attempt: held.attempt, leaseToken: token, reason });
    const done = await workerDispatch(held, CATALOG_INTAKE_FAIL_ACTION, `document-intake:${held.jobId}:${held.attempt}:fail`, payload);
    return done.result as unknown as IntakeWorkerOutcome;
  }

  return {
    /** The member door. */
    forMember(principal: Principal) {
      const tenantId = uuidSchema.parse(principal.tenantId);
      const actorId = uuidSchema.parse(principal.actorId);
      const asOwner = <T>(work: (tx: Transaction) => Promise<T>) =>
        deps.db.tenant(tenantId, async (tx) => { await requireMember(tx, tenantId, actorId, "publish"); return work(tx); });
      const run = memberDispatch(deps, { tenantId, actorId });
      const command = (actionType: string, jobId: string, key: string, payload: unknown) => ({
        actionType,
        target: { tenantId, type: DOCUMENT_INTAKE_JOB_TARGET, id: jobId },
        approvalReference: approvalFor(tenantId, key),
        idempotencyKey: key,
        payload: toJson(payload),
      });

      async function readJob(jobId: string): Promise<IntakeJobDetail> {
        const id = uuidSchema.safeParse(jobId);
        if (!id.success) throw new NotFound();
        const found = await asOwner(async (tx) => {
          const job = (await tx.query<JobRow>(`SELECT ${jobColumns} ${jobFrom} WHERE j.tenant_id=$1 AND j.id=$2 GROUP BY j.tenant_id, j.id`, [tenantId, id.data])).rows[0];
          if (!job) return null;
          const rows = (await tx.query<StoredRowView>(
            `SELECT id, row_index, diff_op::text AS diff_op, invalid_reason, existing_target_id, existing_revision, proposed_payload,
                    page_no, bbox, source_snippet, included
               FROM document_intake_rows WHERE tenant_id=$1 AND job_id=$2 ORDER BY row_index`, [tenantId, id.data])).rows;
          return { job, rows };
        });
        if (!found) throw new NotFound();
        return intakeJobDetailSchema.parse({
          ...jobOf(found.job),
          rows: found.rows.map((row): IntakeRow => ({
            id: row.id, rowIndex: row.row_index, diffOp: row.diff_op, invalidReason: row.invalid_reason,
            existingTargetId: row.existing_target_id, existingRevision: row.existing_revision,
            proposed: row.proposed_payload.proposed, current: row.proposed_payload.current,
            changedFields: row.proposed_payload.changedFields, cells: row.proposed_payload.cells,
            pageNo: row.page_no, bbox: row.bbox, sourceSnippet: row.source_snippet, included: row.included,
          })),
        });
      }

      return {
        /**
         * DL-3: store the PDF at the server-built path, then queue the job. Owner only, checked first;
         * the type, the signature and the size are checked before a byte is stored. A failed insert
         * deletes the object at once (DL-16).
         */
        async upload(input: UploadInput, rawKey: unknown): Promise<IntakeUploadResult> {
          await asOwner(async () => undefined);
          const key = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
          const filename = parseInput(filenameSchema, input.filename, "filename");
          const type = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
          if (type !== "application/pdf")
            throw validationError("Invalid request", [{ path: ["contentType"], message: "Upload a PDF" }]);
          if (input.bytes.byteLength > INTAKE_MAX_BYTES) throw new Refused(413, "file_too_large", "The file is over 20 MiB");
          const magic = Buffer.from(input.bytes.subarray(0, 5)).toString("latin1");
          if (input.bytes.byteLength < 5 || magic !== "%PDF-")
            throw validationError("Invalid request", [{ path: ["file"], message: "That file is not a PDF" }]);
          const fileSha256 = createHash("sha256").update(input.bytes).digest("hex");
          const jobId = intakeJobId(tenantId, key);
          const path = intakeFilePath(tenantId, jobId, fileSha256);
          const payload = intakeUploadPayloadSchema.parse({
            jobId, targetKind: "catalog", source: "upload", filename, fileSha256, byteLength: input.bytes.byteLength,
          });
          await config.store.put(path, input.bytes);
          try {
            const done = await run(command(CATALOG_INTAKE_UPLOAD_ACTION, jobId, key, payload));
            return done.result as unknown as IntakeUploadResult;
          } catch (error) {
            // A retry of an accepted upload finds its job and keeps the object.
            const kept = await deps.db.tenant(tenantId, async (tx) => (await tx.query(
              "SELECT 1 FROM document_intake_jobs WHERE tenant_id=$1 AND id=$2 AND file_sha256=$3", [tenantId, jobId, fileSha256])).rowCount === 1);
            if (!kept) { try { await config.store.delete(path); } catch { /* the object is unreferenced; the job never existed */ } }
            throw error;
          }
        },

        async list(limit = 50): Promise<IntakeJobList> {
          const rows = await asOwner(async (tx) => (await tx.query<JobRow>(
            `SELECT ${jobColumns} ${jobFrom} WHERE j.tenant_id=$1 GROUP BY j.tenant_id, j.id ORDER BY j.created_at DESC, j.id DESC LIMIT $2`,
            [tenantId, limit])).rows);
          return intakeJobListSchema.parse({ items: rows.map(jobOf) });
        },

        get: readJob,

        /**
         * DL-13, DL-14: propose the apply as an approval. The payload lists the included rows, sorted,
         * with the diff digest the owner saw; the approver reads the same rows (DL-12).
         */
        async proposeApply(jobId: string, body: unknown, key: unknown) {
          const request = parseInput(intakeApplyRequestSchema, body);
          const detail = await readJob(jobId);
          if (detail.status !== "review") throw new Conflict("The job is not waiting for review", { reason: "intake_not_in_review" });
          if (detail.diffDigest !== request.diffDigest) throw new Conflict("The proposed changes changed", { reason: "intake_changed" });
          const included = [...new Set(request.includedRowIds)].sort();
          const byId = new Map(detail.rows.map((row) => [row.id, row]));
          let inserts = 0;
          let updates = 0;
          for (const id of included) {
            const row = byId.get(id);
            if (!row) throw validationError("Invalid request", [{ path: ["includedRowIds"], message: "A listed row is not part of this job" }]);
            if (row.diffOp === "insert") inserts += 1;
            else if (row.diffOp === "update") updates += 1;
            else throw validationError("Invalid request", [{ path: ["includedRowIds"], message: "Only new and changed rows can be applied" }]);
          }
          const payload = intakeApplyPayloadSchema.parse({ jobId: detail.id, includedRowIds: included, diffDigest: detail.diffDigest });
          const summary = `Add ${inserts} and change ${updates} catalog items from ${detail.filename}`.slice(0, 500);
          const session = createSession(deps, { tenantId, actorId });
          return session.requestApproval({
            action: { actionType: CATALOG_INTAKE_APPLY_ACTION, target: { type: DOCUMENT_INTAKE_JOB_TARGET, id: detail.id }, payload },
            summary,
            expiresInMinutes: 24 * 60,
          }, key);
        },

        /** DL-4: drop a job in review without applying it. */
        async discard(jobId: string, rawKey: unknown): Promise<IntakeDiscardResult> {
          const id = uuidSchema.safeParse(jobId);
          if (!id.success) throw new NotFound();
          const key = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
          const done = await run(command(CATALOG_INTAKE_DISCARD_ACTION, id.data, key, { jobId: id.data }));
          return done.result as unknown as IntakeDiscardResult;
        },
      };
    },

    /** The worker door. */
    worker: {
      /**
       * DL-4, DL-5: lease the oldest due job across all tenants, or nothing. A claimed job whose lease
       * lapsed is taken again; one that has used its third attempt fails `worker_error`.
       */
      async claim(): Promise<ClaimedIntakeJob | null> {
        if (!deps.db.platform) throw new Error("The document intake worker needs the platform transaction");
        const at = now();
        const stamp = iso(at);
        return deps.db.platform(async (tx) => {
          await tx.query(
            `UPDATE document_intake_jobs SET status='failed', failure_reason='worker_error', finished_at=$1
              WHERE id IN (SELECT id FROM document_intake_jobs WHERE status='claimed' AND lease_expires_at <= $1 AND attempts >= $2
                           ORDER BY lease_expires_at, id LIMIT 20 FOR UPDATE SKIP LOCKED)`,
            [stamp, INTAKE_MAX_ATTEMPTS]);
          const due = (await tx.query<{ tenant_id: string; id: string }>(
            `SELECT tenant_id, id FROM document_intake_jobs
              WHERE status='queued' OR (status='claimed' AND lease_expires_at <= $1 AND attempts < $2)
              ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [stamp, INTAKE_MAX_ATTEMPTS])).rows[0];
          if (!due) return null;
          const leaseToken = deps.generateId();
          const expires = iso(new Date(at.getTime() + INTAKE_LEASE_MS));
          const row = (await tx.query<{ tenant_id: string; id: string; attempts: number; file_sha256: string; byte_length: number }>(
            `UPDATE document_intake_jobs SET status='claimed', attempts=attempts+1, lease_token=$3, lease_expires_at=$4
              WHERE tenant_id=$1 AND id=$2 RETURNING tenant_id, id, attempts, file_sha256, byte_length`,
            [due.tenant_id, due.id, leaseToken, expires])).rows[0]!;
          return claimedIntakeJobSchema.parse({
            id: row.id, tenantId: row.tenant_id, attempt: row.attempts, fileSha256: row.file_sha256, byteLength: row.byte_length,
            maxPages: INTAKE_MAX_PAGES, leaseToken, leaseExpiresAt: expires,
            filePath: `${DOCUMENT_INTAKE_WORKER_PREFIX}/jobs/${row.id}/file`,
          });
        });
      },

      /** DL-5: the job's PDF, for the holder of a live claim on that exact job. */
      async file(jobId: string, token: string): Promise<Uint8Array> {
        const held = await liveLease(jobId, token);
        const found = await config.store.read(intakeFilePath(held.tenantId, held.jobId, held.fileSha256));
        if (!found || createHash("sha256").update(found).digest("hex") !== held.fileSha256) throw new NotFound();
        return found;
      },

      /**
       * DL-5, DL-8, DL-10, DL-15: validate the tables, then record them as one diff. A bad result fails
       * the job `invalid_result`; a long one fails it `too_many_pages`. A replay returns the first outcome,
       * even after the lease lapsed. A body of the form `{ reason }` is the worker reporting a limit it hit or
       * a crash: DL-5 gives the worker three routes, so a failure travels on this one.
       */
      async result(jobId: string, token: string, body: unknown): Promise<IntakeWorkerOutcome> {
        const held = await lease(jobId, token);
        if (!held) throw leaseLost();
        // A claimed job needs a live lease; any other state is a replay of an outcome already stored.
        if (held.status === "claimed" && held.expired) throw leaseLost();
        const failure = intakeFailRequestSchema.safeParse(body);
        if (failure.success) return failJob(held, token, failure.data.reason);
        const parsed = doclingResultSchema.safeParse(body);
        if (!parsed.success) {
          if (held.status === "claimed") await failJob(held, token, "invalid_result");
          throw validationError("Invalid result", parsed.error.issues);
        }
        const result = parsed.data;
        if (result.pageCount > INTAKE_MAX_PAGES) return failJob(held, token, "too_many_pages");
        const payload = intakeResultPayloadSchema.parse({
          jobId: held.jobId, attempt: held.attempt, leaseToken: token,
          resultDigest: resultDigest(result), pageCount: result.pageCount, parserVersion: result.parserVersion,
        });
        const done = await workerDispatch(held, CATALOG_INTAKE_RESULT_ACTION, `document-intake:${held.jobId}:${held.attempt}`, payload, { intakeResult: result });
        return done.result as unknown as IntakeWorkerOutcome;
      },

      /** DL-5: the worker reports a limit it hit or a crash. */
      async fail(jobId: string, token: string, body: unknown): Promise<IntakeWorkerOutcome> {
        const { reason } = parseInput(intakeFailRequestSchema, body);
        const held = await lease(jobId, token);
        if (!held) throw leaseLost();
        if (held.status === "claimed" && held.expired) throw leaseLost();
        return failJob(held, token, reason);
      },
    },

    /** DL-16: delete the stored PDF of a job that ended 30 days ago. Returns how many it removed. */
    async sweepFiles(limit = 100): Promise<number> {
      if (!deps.db.platform) throw new Error("The document intake sweep needs the platform transaction");
      const cutoff = iso(new Date(now().getTime() - INTAKE_FILE_RETENTION_MS));
      const due = await deps.db.platform(async (tx) => (await tx.query<{ tenant_id: string; id: string; file_sha256: string }>(
        `SELECT tenant_id, id, file_sha256 FROM document_intake_jobs
          WHERE finished_at <= $1 AND file_deleted_at IS NULL ORDER BY finished_at, id LIMIT $2`, [cutoff, limit])).rows);
      let removed = 0;
      for (const job of due) {
        await config.store.delete(intakeFilePath(job.tenant_id, job.id, job.file_sha256));
        await deps.db.platform!(async (tx) => tx.query(
          "UPDATE document_intake_jobs SET file_deleted_at=$3 WHERE tenant_id=$1 AND id=$2", [job.tenant_id, job.id, iso(now())]));
        removed += 1;
      }
      return removed;
    },
  };
}
export type DocumentIntakeSession = ReturnType<typeof createDocumentIntakeSession>;
