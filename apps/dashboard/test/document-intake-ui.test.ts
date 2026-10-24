// Price-list intake on the Agents screen (document-intake.md DL-12..DL-14): the demo adapter keeps
// the API's rules, the card lists each job in plain words, and the review shows every row's page and
// snippet beside its values.
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { intakeJobDetailSchema, intakeJobListSchema } from "@zs/contracts";
import {
  createDemoDocumentIntake, DEMO_APPLIED_JOB_ID, DEMO_FAILED_JOB_ID, DEMO_REVIEW_JOB_ID,
} from "../src/lib/api/demo/document-intake";
import { countsLine, IntakeCard, ReviewBody } from "../src/components/agents/intake-review";
import { isApiError } from "../src/lib/api";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/agents",
}));

const NOW = new Date("2026-10-23T15:00:00.000Z");
const fresh = () => createDemoDocumentIntake({ clock: { now: () => NOW } });
let n = 0;
const key = () => ({ idempotencyKey: `intake-ui-${++n}` });

describe("demo document intake", () => {
  it("lists newest first in the contract's shape", async () => {
    const list = await fresh().listIntakeJobs();
    expect(intakeJobListSchema.safeParse({ items: list }).success).toBe(true);
    expect(list.map((job) => job.id)).toEqual([DEMO_REVIEW_JOB_ID, DEMO_APPLIED_JOB_ID, DEMO_FAILED_JOB_ID]);
    expect(list[0]!.counts).toEqual({ insert: 1, update: 1, unchanged: 1, invalid: 1 });
  });

  it("returns rows with provenance, and a 404 for an unknown job", async () => {
    const api = fresh();
    const detail = await api.getIntakeJob(DEMO_REVIEW_JOB_ID);
    expect(intakeJobDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.rows.every((row) => row.pageNo >= 1 && row.sourceSnippet.length > 0)).toBe(true);
    await expect(api.getIntakeJob("00000000-0000-4000-8000-000000000000")).rejects.toSatisfy((error) => isApiError(error, "not_found"));
  });

  it("applies chosen rows only after the approval is decided", async () => {
    const api = fresh();
    const detail = await api.getIntakeJob(DEMO_REVIEW_JOB_ID);
    const ids = detail.rows.filter((row) => row.included).map((row) => row.id);
    const { approvalId } = await api.proposeIntakeApply(DEMO_REVIEW_JOB_ID, { includedRowIds: ids, diffDigest: detail.diffDigest! }, key());
    expect((await api.getIntakeJob(DEMO_REVIEW_JOB_ID)).status).toBe("review");
    await api.approveIntakeApply(approvalId, key());
    expect((await api.getIntakeJob(DEMO_REVIEW_JOB_ID)).status).toBe("applied");
    await expect(api.discardIntakeJob(DEMO_REVIEW_JOB_ID, key())).rejects.toSatisfy((error) => isApiError(error, "conflict") && error.reason === "intake_not_in_review");
  });

  it("refuses a stale digest and a row that cannot be applied", async () => {
    const api = fresh();
    const detail = await api.getIntakeJob(DEMO_REVIEW_JOB_ID);
    const insert = detail.rows.find((row) => row.diffOp === "insert")!;
    await expect(api.proposeIntakeApply(DEMO_REVIEW_JOB_ID, { includedRowIds: [insert.id], diffDigest: "0".repeat(64) }, key()))
      .rejects.toSatisfy((error) => isApiError(error, "conflict") && error.reason === "intake_changed");
    const invalid = detail.rows.find((row) => row.diffOp === "invalid")!;
    await expect(api.proposeIntakeApply(DEMO_REVIEW_JOB_ID, { includedRowIds: [invalid.id], diffDigest: detail.diffDigest! }, key()))
      .rejects.toSatisfy((error) => isApiError(error, "validation"));
  });
});

describe("price lists card", () => {
  it("shows each list with a plain status and a way in to review", async () => {
    const items = await fresh().listIntakeJobs();
    const html = renderScreen(h(IntakeCard), { fill: (client) => { client.setQueryData(keys.intakeJobs, items); } }).replaceAll("<!-- -->", "");
    expect(html).toContain("Ready to review");
    expect(html).toContain("Added to the catalog");
    expect(html).toContain("The file has more than 50 pages");
    expect(html).toContain("1 new, 1 changed, 1 the same, 1 skipped");
    expect(html).toContain(`data-job="${DEMO_FAILED_JOB_ID}"`);
    expect(html).toContain("Review rows");
  });

  it("is hidden from staff, who may not read price lists", async () => {
    const items = await fresh().listIntakeJobs();
    const html = renderScreen(h(IntakeCard), { staff: true, fill: (client) => { client.setQueryData(keys.intakeJobs, items); } });
    expect(html).not.toContain("Price lists");
  });

  it("puts the page and snippet beside each row, and selects only new and changed rows", async () => {
    const detail = await fresh().getIntakeJob(DEMO_REVIEW_JOB_ID);
    const html = renderScreen(h(ReviewBody, { detail })).replaceAll("<!-- -->", "");
    expect(html).toContain("Page 1");
    expect(html).toContain("HR-2002 | Wool scarf | Hand finished | $42.00 | Grey");
    expect(html).toContain("Price: now $38.50, list says $42.00");
    expect(html).toContain("No item number");
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Ask to add 2 rows");
    expect(html).toContain("Discard this list");
  });

  it("shows every changed value, current beside proposed, the box on the page, and prices in the currency's own units", async () => {
    const detail = await fresh().getIntakeJob(DEMO_REVIEW_JOB_ID);
    const update = detail.rows.find((row) => row.diffOp === "update")!;
    const insert = detail.rows.find((row) => row.diffOp === "insert")!;
    const yen = { ...update.current!, currency: "JPY", priceMinor: 1500, description: "Old note", attributes: { Color: "Grey" } };
    const rows = detail.rows.map((row) => {
      if (row.id === update.id) {
        return { ...row, current: yen, proposed: { ...yen, priceMinor: 1800, description: "New note", attributes: { Color: "Sand", Fit: "Slim" } },
          changedFields: ["priceMinor", "description", "attributes"], bbox: [0.1, 0.25, 0.9, 0.3] as [number, number, number, number] };
      }
      if (row.id === insert.id) {
        return { ...row, proposed: { ...row.proposed!, description: "Relaxed fit", currency: "KWD", priceMinor: 12500, attributes: { Color: "Sand" } } };
      }
      return row;
    });
    const html = renderScreen(h(ReviewBody, { detail: { ...detail, rows } })).replaceAll("<!-- -->", "").replaceAll("\u00a0", " ");
    expect(html).toContain("Price: now ¥1,500, list says ¥1,800");
    expect(html).not.toContain("¥15.00");
    expect(html).toContain("Description: now Old note, list says New note");
    expect(html).toContain("Details: now Color: Grey, list says Color: Sand, Fit: Slim");
    // A new item lists everything it will add; a three-decimal currency keeps its digits.
    expect(html).toContain("Description: Relaxed fit");
    expect(html).toContain("Price: KWD 12.500");
    expect(html).toContain("Details: Color: Sand");
    // DL-12: the box sits with the page and the snippet.
    expect(html).toContain("Page 1, box 0.1, 0.25 to 0.9, 0.3");
  });

  it("describes a job's counts in words", () => {
    expect(countsLine({ counts: { insert: 0, update: 0, unchanged: 0, invalid: 0 } })).toBe("No rows");
    expect(countsLine({ counts: { insert: 2, update: 0, unchanged: 0, invalid: 1 } })).toBe("2 new, 1 skipped");
  });
});
