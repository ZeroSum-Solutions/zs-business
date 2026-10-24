import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { storedInstantSchema } from "./instant.js";
import { isPostgresText } from "./json.js";

// Root re-exports this module, so the shared root schemas are reached lazily, as in transcription.ts.
const idSchema = z.lazy(() => uuidSchema);

// Document intake (docs/requirements/document-intake.md DL-1..DL-16): the shapes of the jobs a
// Docling worker pulls, the tables it returns, the diff the server builds, and the one approval
// that makes any row live. First slice: catalog target, PDF only.

export const CATALOG_INTAKE_UPLOAD_ACTION = "catalog.intake.upload";
export const CATALOG_INTAKE_APPLY_ACTION = "catalog.intake.apply";
/** Server-only steps of the worker (DL-5, DL-15): no member permission runs them. */
/** DL-4 (`review -> discarded`): the owner drops a job without applying it. Not in the contract's numbered rules; it is the only way into that state. */
export const CATALOG_INTAKE_DISCARD_ACTION = "catalog.intake.discard";
export const CATALOG_INTAKE_RESULT_ACTION = "catalog.intake.result";
export const CATALOG_INTAKE_FAIL_ACTION = "catalog.intake.fail";
export const DOCUMENT_INTAKE_JOB_TARGET = "document_intake_job";
/** DL-15: reserved idempotency key prefix, also listed in SERVER_IDEMPOTENCY_PREFIXES. */
export const DOCUMENT_INTAKE_KEY_PREFIX = "document-intake:";

/** DL-3: one PDF, at most 20 MiB. */
export const INTAKE_MAX_BYTES = 20 * 1024 * 1024;
/** DL-8: more pages than this fails the job. */
export const INTAKE_MAX_PAGES = 50;
/** DL-8: a result holds at most this many rows. */
export const INTAKE_MAX_ROWS = 5000;
/** DL-10 bounds. */
export const INTAKE_MAX_CELL = 2000;
export const INTAKE_MAX_SNIPPET = 500;
export const INTAKE_MAX_COLUMNS = 50;
export const INTAKE_MAX_TABLES = 200;
/** DL-4: a job whose lease lapses this many times fails `worker_error`. */
export const INTAKE_MAX_ATTEMPTS = 3;
/** DL-5: how long a claim holds the job; the worker's own limit per document is 90 s (DL-8). */
export const INTAKE_LEASE_MS = 10 * 60 * 1000;
/** DL-16: a stored PDF is kept this long after its job ends. */
export const INTAKE_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** DL-1: a catalog item's attributes. */
export const CATALOG_MAX_ATTRIBUTES = 30;
export const CATALOG_MAX_PRICE_MINOR = 1_000_000_000_000;
/** The worker's routes (DL-5) and the header that carries its lease on every call after the claim. */
export const DOCUMENT_INTAKE_WORKER_PREFIX = "/v1/workers/document-intake";
export const INTAKE_LEASE_HEADER = "X-Lease-Token";
/** The upload route takes the raw PDF body, so it sits outside the 64 KiB JSON limit. */
export const DOCUMENT_INTAKE_UPLOAD_PATH = "/v1/document-intake/uploads";
export const INTAKE_FILENAME_HEADER = "X-Filename";
/**
 * The apply request lists up to 5,000 row IDs (about 195 KB of JSON), so it gets a larger JSON limit than the
 * 64 KiB every other request has. Both HTTP layers, the API and the dashboard proxy, use this one rule.
 */
export const DOCUMENT_INTAKE_APPLY_PATH = /^\/v1\/document-intake\/jobs\/[A-Za-z0-9_-]+\/apply$/;
export const INTAKE_APPLY_BODY_LIMIT = 256 * 1024;

export const intakeTargetKindSchema = z.enum(["catalog", "knowledge"]);
export type IntakeTargetKind = z.infer<typeof intakeTargetKindSchema>;
export const documentIntakeStatusSchema = z.enum(["queued", "claimed", "review", "applied", "discarded", "failed"]);
export type DocumentIntakeStatus = z.infer<typeof documentIntakeStatusSchema>;
export const intakeDiffOpSchema = z.enum(["insert", "update", "unchanged", "invalid"]);
export type IntakeDiffOp = z.infer<typeof intakeDiffOpSchema>;
/** DL-4, DL-8, DL-10: why a job failed. */
export const intakeFailureReasonSchema = z.enum(["too_many_pages", "timeout", "invalid_result", "worker_error"]);
export type IntakeFailureReason = z.infer<typeof intakeFailureReasonSchema>;
/** DL-11: why a row cannot be applied. */
export const intakeInvalidReasonSchema = z.enum(["missing_key", "missing_title", "bad_price", "bad_currency", "duplicate_key", "field_too_long"]);
export type IntakeInvalidReason = z.infer<typeof intakeInvalidReasonSchema>;

// ---------------------------------------------------------------------------------------------
// DL-9, DL-10: what the Docling port returns. The Python service implements the same JSON.

const stripControls = (value: string): string =>
  value.replace(/[\t\n\r\v\f]+/g, " ").replace(/\p{Cc}/gu, "");
/** DL-10: valid Postgres text (so no NUL), control characters stripped, length bounded. */
const intakeText = (max: number) => z.string().max(max).refine(isPostgresText, "Text is not valid in Postgres").transform(stripControls);

const fraction = z.number().min(0).max(1);
/** DL-12: [x0, y0, x1, y1] as fractions of the page, so the box is inside the page by construction. */
export const bboxSchema = z.tuple([fraction, fraction, fraction, fraction])
  .refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, "A box has positive width and height");
export type Bbox = z.infer<typeof bboxSchema>;

export const doclingRowSchema = z.strictObject({
  cells: z.array(intakeText(INTAKE_MAX_CELL)).max(INTAKE_MAX_COLUMNS),
  pageNo: z.number().int().min(1).max(100_000),
  bbox: bboxSchema,
  snippet: intakeText(INTAKE_MAX_SNIPPET),
});
export type DoclingRow = z.infer<typeof doclingRowSchema>;
export const doclingTableSchema = z.strictObject({
  headers: z.array(intakeText(INTAKE_MAX_CELL)).max(INTAKE_MAX_COLUMNS),
  rows: z.array(doclingRowSchema).max(INTAKE_MAX_ROWS),
});
export type DoclingTable = z.infer<typeof doclingTableSchema>;
export const doclingResultSchema = z.strictObject({
  pageCount: z.number().int().min(1).max(100_000),
  parserVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,99}$/, "Not a parser version"),
  tables: z.array(doclingTableSchema).max(INTAKE_MAX_TABLES),
}).superRefine((result, ctx) => {
  const rows = result.tables.reduce((total, table) => total + table.rows.length, 0);
  if (rows > INTAKE_MAX_ROWS) ctx.addIssue({ code: "custom", path: ["tables"], message: "A result holds at most 5000 rows" });
  result.tables.forEach((table, t) => table.rows.forEach((row, r) => {
    if (row.pageNo > result.pageCount)
      ctx.addIssue({ code: "custom", path: ["tables", t, "rows", r, "pageNo"], message: "A row's page is inside the document" });
  }));
});
export type DoclingResult = z.infer<typeof doclingResultSchema>;

// ---------------------------------------------------------------------------------------------
// DL-1, DL-11: the catalog fields a row proposes, and the stored row.

export const catalogAttributesSchema = z.record(z.string().min(1).max(60), z.string().max(500))
  .refine((attributes) => Object.keys(attributes).length <= CATALOG_MAX_ATTRIBUTES, "At most 30 attributes");
export const catalogFieldsSchema = z.strictObject({
  sku: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  description: z.string().max(INTAKE_MAX_CELL),
  priceMinor: z.number().int().min(0).max(CATALOG_MAX_PRICE_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  attributes: catalogAttributesSchema,
  active: z.boolean(),
});
export type CatalogFields = z.infer<typeof catalogFieldsSchema>;
export const CATALOG_FIELD_NAMES = ["title", "description", "priceMinor", "currency", "attributes", "active"] as const;
export type CatalogFieldName = (typeof CATALOG_FIELD_NAMES)[number];

// ---------------------------------------------------------------------------------------------
// DL-3: the upload action. The bytes are stored first; the action carries only their fingerprint.

export const filenameSchema = z.string().min(1).max(200)
  .refine(isPostgresText, "Text is not valid in Postgres")
  .refine((name) => !/\p{Cc}/u.test(name), "A filename has no control characters")
  .refine((name) => name.trim().length > 0, "A filename has visible characters");
export const fileSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Not a SHA-256 digest");
export const intakeUploadPayloadSchema = z.strictObject({
  jobId: idSchema,
  targetKind: z.literal("catalog"),
  source: z.literal("upload"),
  filename: filenameSchema,
  fileSha256: fileSha256Schema,
  byteLength: z.number().int().min(5).max(INTAKE_MAX_BYTES),
});
export type IntakeUploadPayload = z.infer<typeof intakeUploadPayloadSchema>;
export const intakeUploadCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CATALOG_INTAKE_UPLOAD_ACTION),
  target: targetSchema.extend({ type: z.literal(DOCUMENT_INTAKE_JOB_TARGET) }),
  payload: intakeUploadPayloadSchema,
}));
export const intakeUploadResultSchema = z.strictObject({ jobId: idSchema, status: z.literal("queued") });
export type IntakeUploadResult = z.infer<typeof intakeUploadResultSchema>;

// ---------------------------------------------------------------------------------------------
// DL-5: the worker's calls. The server adds the attempt and the lease; the tenant comes from the job.

export const claimedIntakeJobSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  attempt: z.number().int().min(1).max(INTAKE_MAX_ATTEMPTS),
  fileSha256: fileSha256Schema,
  byteLength: z.number().int(),
  maxPages: z.number().int(),
  leaseToken: idSchema,
  leaseExpiresAt: storedInstantSchema,
  filePath: z.string(),
});
export type ClaimedIntakeJob = z.infer<typeof claimedIntakeJobSchema>;
export const intakeClaimResponseSchema = z.strictObject({ job: claimedIntakeJobSchema.nullable() });
export type IntakeClaimResponse = z.infer<typeof intakeClaimResponseSchema>;

export const intakeFailRequestSchema = z.strictObject({ reason: intakeFailureReasonSchema });
export const intakeResultPayloadSchema = z.strictObject({
  jobId: idSchema,
  attempt: z.number().int().min(1).max(INTAKE_MAX_ATTEMPTS),
  leaseToken: idSchema,
  /** SHA-256 over the validated result: the rows travel beside the payload, not in it. */
  resultDigest: fileSha256Schema,
  pageCount: z.number().int().min(1).max(INTAKE_MAX_PAGES),
  parserVersion: doclingResultSchema.shape.parserVersion,
});
export const intakeResultCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CATALOG_INTAKE_RESULT_ACTION),
  target: targetSchema.extend({ type: z.literal(DOCUMENT_INTAKE_JOB_TARGET) }),
  payload: intakeResultPayloadSchema,
}));
export const intakeFailPayloadSchema = z.strictObject({
  jobId: idSchema,
  attempt: z.number().int().min(1).max(INTAKE_MAX_ATTEMPTS),
  leaseToken: idSchema,
  reason: intakeFailureReasonSchema,
});
export const intakeFailCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CATALOG_INTAKE_FAIL_ACTION),
  target: targetSchema.extend({ type: z.literal(DOCUMENT_INTAKE_JOB_TARGET) }),
  payload: intakeFailPayloadSchema,
}));
export const intakeCountsSchema = z.strictObject({
  insert: z.number().int(), update: z.number().int(), unchanged: z.number().int(), invalid: z.number().int(),
});
export type IntakeCounts = z.infer<typeof intakeCountsSchema>;
export const intakeWorkerOutcomeSchema = z.strictObject({
  jobId: idSchema,
  status: z.enum(["review", "failed"]),
  failureReason: intakeFailureReasonSchema.nullable(),
  diffDigest: fileSha256Schema.nullable(),
  counts: intakeCountsSchema.nullable(),
});
export type IntakeWorkerOutcome = z.infer<typeof intakeWorkerOutcomeSchema>;

// ---------------------------------------------------------------------------------------------
// DL-13, DL-14: the apply action, bound by an approval.

const sortedUniqueIds = (ids: readonly string[]): boolean => ids.every((id, i) => i === 0 || ids[i - 1]! < id);
export const intakeApplyPayloadSchema = z.strictObject({
  jobId: idSchema,
  /** Sorted and unique, so one set of rows has one payload and one approval binding. */
  includedRowIds: z.array(idSchema).min(1).max(INTAKE_MAX_ROWS)
    .refine(sortedUniqueIds, "includedRowIds are sorted and unique"),
  diffDigest: fileSha256Schema,
});
export type IntakeApplyPayload = z.infer<typeof intakeApplyPayloadSchema>;
export const intakeApplyCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CATALOG_INTAKE_APPLY_ACTION),
  target: targetSchema.extend({ type: z.literal(DOCUMENT_INTAKE_JOB_TARGET) }),
  payload: intakeApplyPayloadSchema,
}));
export const intakeApplyResultSchema = z.strictObject({
  jobId: idSchema,
  status: z.literal("applied"),
  inserted: z.number().int(),
  updated: z.number().int(),
});
export type IntakeApplyResult = z.infer<typeof intakeApplyResultSchema>;

export const intakeDiscardPayloadSchema = z.strictObject({ jobId: idSchema });
export const intakeDiscardCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CATALOG_INTAKE_DISCARD_ACTION),
  target: targetSchema.extend({ type: z.literal(DOCUMENT_INTAKE_JOB_TARGET) }),
  payload: intakeDiscardPayloadSchema,
}));
export const intakeDiscardResultSchema = z.strictObject({ jobId: idSchema, status: z.literal("discarded") });
export type IntakeDiscardResult = z.infer<typeof intakeDiscardResultSchema>;

/** The member's request to propose the apply: the server builds the sorted payload and the approval. */
export const intakeApplyRequestSchema = z.strictObject({
  diffDigest: fileSha256Schema,
  includedRowIds: z.array(idSchema).min(1).max(INTAKE_MAX_ROWS),
});
export type IntakeApplyRequest = z.infer<typeof intakeApplyRequestSchema>;

// ---------------------------------------------------------------------------------------------
// The owner's reads (DL-12): the job, and every row with its provenance.

export const intakeRowSchema = z.strictObject({
  id: idSchema,
  rowIndex: z.number().int(),
  diffOp: intakeDiffOpSchema,
  invalidReason: intakeInvalidReasonSchema.nullable(),
  existingTargetId: idSchema.nullable(),
  existingRevision: z.number().int().nullable(),
  proposed: catalogFieldsSchema.nullable(),
  current: catalogFieldsSchema.nullable(),
  changedFields: z.array(z.string()),
  cells: z.array(z.string()),
  pageNo: z.number().int(),
  bbox: bboxSchema,
  sourceSnippet: z.string(),
  included: z.boolean(),
});
export type IntakeRow = z.infer<typeof intakeRowSchema>;

export const intakeJobSchema = z.strictObject({
  id: idSchema,
  targetKind: intakeTargetKindSchema,
  source: z.string(),
  filename: z.string(),
  byteLength: z.number().int(),
  pageCount: z.number().int().nullable(),
  status: documentIntakeStatusSchema,
  failureReason: intakeFailureReasonSchema.nullable(),
  parserVersion: z.string().nullable(),
  diffDigest: fileSha256Schema.nullable(),
  counts: intakeCountsSchema,
  createdAt: storedInstantSchema,
  finishedAt: storedInstantSchema.nullable(),
});
export type IntakeJob = z.infer<typeof intakeJobSchema>;
export const intakeJobListSchema = z.strictObject({ items: z.array(intakeJobSchema) });
export type IntakeJobList = z.infer<typeof intakeJobListSchema>;
export const intakeJobDetailSchema = intakeJobSchema.extend({ rows: z.array(intakeRowSchema) });
export type IntakeJobDetail = z.infer<typeof intakeJobDetailSchema>;
export const listIntakeJobsQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
