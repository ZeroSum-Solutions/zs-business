/**
 * The demo adapter's document intake (document-intake.md DL-11..DL-14). Three jobs: a price list
 * waiting for review (a new item, a changed price, an unchanged item and a row with no key), a
 * list that was applied, and one that had too many pages. It keeps the API's rules: only a job in
 * review can be applied or discarded, the apply names the digest the owner saw, only new and
 * changed rows can be included, and nothing is "written" until the approval is decided. The data is
 * in memory and starts again on every page load.
 */
import { intakeJobDetailSchema, type CatalogFields, type IntakeJobDetail, type IntakeRow } from "@zs/contracts";
import { demoError } from "../errors";
import type { DocumentIntakeApi } from "../types";
import type { DemoClock } from "./adapter";

export const DEMO_REVIEW_JOB_ID = "5a0e7c11-3b2d-4c68-8e1f-6d9a2b4c7e01";
export const DEMO_APPLIED_JOB_ID = "5a0e7c11-3b2d-4c68-8e1f-6d9a2b4c7e02";
export const DEMO_FAILED_JOB_ID = "5a0e7c11-3b2d-4c68-8e1f-6d9a2b4c7e03";
const DIGEST = "d".repeat(64);
const HOUR = 3_600_000;

const fields = (sku: string, title: string, description: string, priceMinor: number, attributes: Record<string, string> = {}): CatalogFields => ({
  sku, title, description, priceMinor, currency: "USD", attributes, active: true,
});

export function createDemoDocumentIntake(options: { clock?: DemoClock; latencyMs?: number } = {}): DocumentIntakeApi {
  const clock = options.clock ?? { now: () => new Date() };
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const ago = (ms: number) => new Date(clock.now().getTime() - ms).toISOString();
  const row = (id: string, rowIndex: number, partial: Partial<IntakeRow> & Pick<IntakeRow, "diffOp" | "cells" | "pageNo" | "sourceSnippet">): IntakeRow => ({
    id, rowIndex, invalidReason: null, existingTargetId: null, existingRevision: null, proposed: null, current: null,
    changedFields: [], bbox: [0.09, 0.2 + rowIndex * 0.03, 0.9, 0.23 + rowIndex * 0.03], included: partial.diffOp === "insert" || partial.diffOp === "update",
    ...partial,
  });

  const jobs = new Map<string, IntakeJobDetail>();
  const counts = (rows: IntakeRow[]) => ({
    insert: rows.filter((r) => r.diffOp === "insert").length, update: rows.filter((r) => r.diffOp === "update").length,
    unchanged: rows.filter((r) => r.diffOp === "unchanged").length, invalid: rows.filter((r) => r.diffOp === "invalid").length,
  });
  const put = (job: Omit<IntakeJobDetail, "counts">) => jobs.set(job.id, intakeJobDetailSchema.parse({ ...job, counts: counts(job.rows) }));

  const reviewRows = [
    row("6b1f8d22-4c3e-4d79-9f20-7e0b3c5d8f01", 1, {
      diffOp: "insert", cells: ["HR-1001", "Linen shirt", "Relaxed fit", "$45.00", "Sand"], pageNo: 1,
      sourceSnippet: "HR-1001 | Linen shirt | Relaxed fit | $45.00 | Sand",
      proposed: fields("HR-1001", "Linen shirt", "Relaxed fit", 4500, { Color: "Sand" }), changedFields: [],
    }),
    row("6b1f8d22-4c3e-4d79-9f20-7e0b3c5d8f02", 2, {
      diffOp: "update", cells: ["HR-2002", "Wool scarf", "Hand finished", "$42.00", "Grey"], pageNo: 1,
      sourceSnippet: "HR-2002 | Wool scarf | Hand finished | $42.00 | Grey",
      existingTargetId: "7c2a9e33-5d4f-4e8a-8031-8f1c4d6e9a02", existingRevision: 3,
      proposed: fields("HR-2002", "Wool scarf", "Hand finished", 4200, { Color: "Grey" }),
      current: fields("HR-2002", "Wool scarf", "Hand finished", 3850, { Color: "Grey" }), changedFields: ["priceMinor"],
    }),
    row("6b1f8d22-4c3e-4d79-9f20-7e0b3c5d8f03", 3, {
      diffOp: "unchanged", cells: ["HR-3003", "Canvas tote", "Everyday bag", "$28.00", "Natural"], pageNo: 2,
      sourceSnippet: "HR-3003 | Canvas tote | Everyday bag | $28.00 | Natural",
      existingTargetId: "7c2a9e33-5d4f-4e8a-8031-8f1c4d6e9a03", existingRevision: 1,
      proposed: fields("HR-3003", "Canvas tote", "Everyday bag", 2800, { Color: "Natural" }),
      current: fields("HR-3003", "Canvas tote", "Everyday bag", 2800, { Color: "Natural" }),
    }),
    row("6b1f8d22-4c3e-4d79-9f20-7e0b3c5d8f04", 4, {
      diffOp: "invalid", invalidReason: "missing_key", cells: ["", "Gift card", "Any amount", "$25.00", ""], pageNo: 2,
      sourceSnippet: " | Gift card | Any amount | $25.00 | ",
    }),
  ];
  const base = { targetKind: "catalog" as const, source: "upload", parserVersion: "demo-docling-1", failureReason: null, diffDigest: DIGEST };
  put({ ...base, id: DEMO_REVIEW_JOB_ID, filename: "halden-rowe-price-list.pdf", byteLength: 184_320, pageCount: 2, status: "review", createdAt: ago(HOUR), finishedAt: null, rows: reviewRows });
  put({
    ...base, id: DEMO_APPLIED_JOB_ID, filename: "spring-additions.pdf", byteLength: 96_000, pageCount: 1, status: "applied", createdAt: ago(48 * HOUR), finishedAt: ago(47 * HOUR),
    rows: [row("6b1f8d22-4c3e-4d79-9f20-7e0b3c5d8f11", 1, {
      diffOp: "insert", cells: ["HR-4004", "Silk scarf", "Printed", "$60.00", ""], pageNo: 1, sourceSnippet: "HR-4004 | Silk scarf | Printed | $60.00",
      proposed: fields("HR-4004", "Silk scarf", "Printed", 6000),
    })],
  });
  put({
    ...base, id: DEMO_FAILED_JOB_ID, filename: "full-catalogue-2026.pdf", byteLength: 6_400_000, pageCount: null, status: "failed", failureReason: "too_many_pages",
    parserVersion: null, diffDigest: null, createdAt: ago(72 * HOUR), finishedAt: ago(71 * HOUR), rows: [],
  });

  const find = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw demoError("NotFound");
    return job;
  };
  const summary = ({ rows: _rows, ...job }: IntakeJobDetail) => job;
  /** The approvals the demo holds: an approval ID maps to the job and the rows it binds. */
  const approvals = new Map<string, { jobId: string; rowIds: string[]; digest: string }>();
  let approvalSeq = 0;

  return {
    async listIntakeJobs() {
      await wait();
      return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary);
    },

    async getIntakeJob(id) {
      await wait();
      return structuredClone(find(id));
    },

    async proposeIntakeApply(id, input) {
      await wait();
      const job = find(id);
      if (job.status !== "review") throw demoError("Conflict", { reason: "intake_not_in_review" });
      if (job.diffDigest !== input.diffDigest) throw demoError("Conflict", { reason: "intake_changed" });
      const ids = [...new Set(input.includedRowIds)].sort();
      for (const rowId of ids) {
        const found = job.rows.find((r) => r.id === rowId);
        if (!found || (found.diffOp !== "insert" && found.diffOp !== "update")) throw demoError("ValidationFailed");
      }
      approvalSeq += 1;
      const approvalId = `8d3b0f44-6e5a-4f9b-9142-9a2d5e7f0b${String(approvalSeq).padStart(2, "0")}`;
      approvals.set(approvalId, { jobId: id, rowIds: ids, digest: input.diffDigest });
      return { approvalId };
    },

    async approveIntakeApply(approvalId) {
      await wait();
      const approval = approvals.get(approvalId);
      if (!approval) throw demoError("NotFound");
      const job = find(approval.jobId);
      if (job.status !== "review") throw demoError("Conflict", { reason: "intake_not_in_review" });
      approvals.delete(approvalId);
      jobs.set(job.id, {
        ...job, status: "applied", finishedAt: clock.now().toISOString(),
        rows: job.rows.map((r) => ({ ...r, included: approval.rowIds.includes(r.id) })),
      });
    },

    async discardIntakeJob(id) {
      await wait();
      const job = find(id);
      if (job.status !== "review") throw demoError("Conflict", { reason: "intake_not_in_review" });
      jobs.set(id, { ...job, status: "discarded", finishedAt: clock.now().toISOString() });
    },
  };
}
