import { describe, expect, it } from "vitest";
import {
  CATALOG_INTAKE_DISCARD_ACTION,
  DOCUMENT_INTAKE_JOB_TARGET,
  SERVER_IDEMPOTENCY_PREFIXES,
  intakeApplyRequestSchema,
  intakeDiscardCommandSchema,
  intakeDiscardPayloadSchema,
  intakeDiscardResultSchema,
  intakeFailRequestSchema,
  sourceSubjectTypeSchema,
} from "../src/index.js";

const ID = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";

describe("document intake contract", () => {
  it("reserves the worker's idempotency prefix", () => {
    expect(SERVER_IDEMPOTENCY_PREFIXES).toContain("document-intake:");
  });

  it("takes catalog items and knowledge entries as source subjects", () => {
    expect(sourceSubjectTypeSchema.safeParse("catalog_item").success).toBe(true);
    expect(sourceSubjectTypeSchema.safeParse("knowledge_entry").success).toBe(true);
  });

  it("refuses an apply request with no rows, a bad digest or an extra key", () => {
    const digest = "a".repeat(64);
    expect(intakeApplyRequestSchema.safeParse({ includedRowIds: [ID], diffDigest: digest }).success).toBe(true);
    expect(intakeApplyRequestSchema.safeParse({ includedRowIds: [], diffDigest: digest }).success).toBe(false);
    expect(intakeApplyRequestSchema.safeParse({ includedRowIds: [ID], diffDigest: "nope" }).success).toBe(false);
    expect(intakeApplyRequestSchema.safeParse({ includedRowIds: [ID], diffDigest: digest, extra: 1 }).success).toBe(false);
  });

  it("knows only the four failure reasons", () => {
    for (const reason of ["too_many_pages", "timeout", "invalid_result", "worker_error"])
      expect(intakeFailRequestSchema.safeParse({ reason }).success, reason).toBe(true);
    expect(intakeFailRequestSchema.safeParse({ reason: "lease_lost" }).success).toBe(false);
  });

  it("describes the discard action, its payload and its result strictly", () => {
    expect(intakeDiscardPayloadSchema.safeParse({ jobId: ID }).success).toBe(true);
    expect(intakeDiscardPayloadSchema.safeParse({ jobId: ID, extra: true }).success).toBe(false);
    expect(intakeDiscardResultSchema.safeParse({ jobId: ID, status: "discarded" }).success).toBe(true);
    expect(intakeDiscardResultSchema.safeParse({ jobId: ID, status: "applied" }).success).toBe(false);
    const command = {
      actionType: CATALOG_INTAKE_DISCARD_ACTION, target: { tenantId: ID, type: DOCUMENT_INTAKE_JOB_TARGET, id: ID }, payload: { jobId: ID }, approvalReference: { tenantId: ID, id: ID },
    };
    expect(intakeDiscardCommandSchema.safeParse({ ...command, idempotencyKey: "k-1" }).success).toBe(true);
    expect(intakeDiscardCommandSchema.safeParse({ ...command, target: { tenantId: ID, type: "booking", id: ID }, idempotencyKey: "k-1" }).success).toBe(false);
  });
});
