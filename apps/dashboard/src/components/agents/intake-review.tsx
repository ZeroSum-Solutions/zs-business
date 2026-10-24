"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CatalogFields, IntakeJob, IntakeJobDetail, IntakeRow } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useDisplayZone, useIntakeJob, useIntakeJobs, useKeys } from "@/lib/queries";
import { MANAGE_CATALOG, useCan } from "@/lib/session";
import { singleFlight } from "@/lib/single-flight";
import { formatDay, formatTime } from "@/lib/time";
import { cn, currencyDigits, formatMoney } from "@/lib/utils";

/** Job states as the owner reads them (document-intake.md DL-4). */
export const INTAKE_STATUS: Record<IntakeJob["status"], { label: string; tone: "neutral" | "info" | "success" | "danger" | "warn" }> = {
  queued: { label: "Waiting to be read", tone: "neutral" },
  claimed: { label: "Being read", tone: "info" },
  review: { label: "Ready to review", tone: "warn" },
  applied: { label: "Added to the catalog", tone: "success" },
  discarded: { label: "Discarded", tone: "neutral" },
  failed: { label: "Could not read", tone: "danger" },
};

export const FAILURE_TEXT: Record<NonNullable<IntakeJob["failureReason"]>, string> = {
  too_many_pages: "The file has more than 50 pages. Split it and upload the parts.",
  timeout: "Reading the file took too long. Try a smaller file.",
  invalid_result: "The file could not be read into rows. Try a clean export of the price list.",
  worker_error: "The reader stopped before it finished. Upload the file again.",
};

const ROW_OP: Record<IntakeRow["diffOp"], { label: string; tone: "success" | "info" | "neutral" | "danger" }> = {
  insert: { label: "New", tone: "success" },
  update: { label: "Changed", tone: "info" },
  unchanged: { label: "Same as now", tone: "neutral" },
  invalid: { label: "Skipped", tone: "danger" },
};

const INVALID_TEXT: Record<NonNullable<IntakeRow["invalidReason"]>, string> = {
  missing_key: "No item number",
  missing_title: "No name",
  bad_price: "The price is not a number",
  bad_currency: "Unknown currency",
  duplicate_key: "The item number is repeated",
  field_too_long: "A value is too long",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 new, 1 changed" for a job's counts. */
export function countsLine(job: Pick<IntakeJob, "counts">): string {
  const { insert, update, unchanged, invalid } = job.counts;
  const parts = [insert && `${insert} new`, update && `${update} changed`, unchanged && `${unchanged} the same`, invalid && `${invalid} skipped`].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No rows";
}

/** A price in its currency's own minor units: 1500 JPY is ¥1,500, 12500 KWD is KWD 12.500, 4200 USD is $42.00. */
function price(fields: Pick<CatalogFields, "priceMinor" | "currency">): string {
  const digits = currencyDigits(fields.currency);
  try {
    return formatMoney(fields.priceMinor / 10 ** digits, fields.currency, digits);
  } catch {
    return `${(fields.priceMinor / 10 ** digits).toFixed(digits)} ${fields.currency}`;
  }
}

const FIELD_TITLE: Record<string, string> = {
  title: "Name", description: "Description", priceMinor: "Price", currency: "Currency", attributes: "Details", active: "Availability",
};
const FIELD_ORDER = ["title", "description", "priceMinor", "currency", "attributes", "active"] as const;

function showField(fields: CatalogFields, name: string): string {
  switch (name) {
    case "title": return fields.title;
    case "description": return fields.description.trim() === "" ? "none" : fields.description;
    case "priceMinor": return price(fields);
    case "currency": return fields.currency;
    case "attributes": {
      const entries = Object.entries(fields.attributes);
      return entries.length === 0 ? "none" : entries.map(([key, value]) => `${key}: ${value}`).join(", ");
    }
    case "active": return fields.active ? "available" : "hidden";
    default: return "";
  }
}

/**
 * DL-13: what the approver reads for one row. A changed item lists each changed field, the current value beside the
 * one the list proposes; a new item lists everything it will add.
 */
export function valueLines(row: Pick<IntakeRow, "diffOp" | "proposed" | "current" | "changedFields">): string[] {
  const proposed = row.proposed;
  if (!proposed) return [];
  if (row.diffOp === "update" && row.current) {
    const current = row.current;
    return FIELD_ORDER.filter((name) => row.changedFields.includes(name))
      .map((name) => `${FIELD_TITLE[name]}: now ${showField(current, name)}, list says ${showField(proposed, name)}`);
  }
  return FIELD_ORDER.filter((name) => name !== "currency" && !(name === "description" && proposed.description.trim() === "") && !(name === "attributes" && Object.keys(proposed.attributes).length === 0))
    .map((name) => `${FIELD_TITLE[name]}: ${showField(proposed, name)}`);
}

/** The rows that can be applied start selected, as the server defaulted them (DL-13). */
function chosenIds(detail: IntakeJobDetail): string[] {
  return detail.rows.filter((row) => row.included && (row.diffOp === "insert" || row.diffOp === "update")).map((row) => row.id);
}

export function IntakeCard() {
  const canManage = useCan(MANAGE_CATALOG);
  const jobs = useIntakeJobs(canManage);
  const zone = useDisplayZone();
  const [open, setOpen] = useState<string | null>(null);
  if (!canManage) return null;

  return (
    <Card aria-labelledby="intake-title">
      <CardHeader>
        <div>
          <CardTitle id="intake-title">Price lists</CardTitle>
          <CardDescription>PDF price lists read into rows. Nothing is added to your catalog until you approve it.</CardDescription>
        </div>
      </CardHeader>
      {jobs.isPending ? <LoadingRows rows={2} label="Loading price lists" /> : jobs.isError ? (
        <ErrorNote error={jobs.error} retry={() => void jobs.refetch()} />
      ) : jobs.data.length === 0 ? (
        <EmptyState title="No price lists yet">An uploaded PDF shows here once it has been read.</EmptyState>
      ) : (
        <ul className="divide-y divide-border-soft" aria-label="Price lists">
          {jobs.data.map((job) => {
            const state = INTAKE_STATUS[job.status];
            const isOpen = open === job.id;
            return (
              <li key={job.id} className="py-3 first:pt-0 last:pb-0" data-job={job.id} data-status={job.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={state.tone}>{state.label}</Badge>
                  <span className="min-w-0 break-words text-sm font-medium text-fg">{job.filename}</span>
                </div>
                <p className="mt-1 text-sm text-fg-2">
                  {job.status === "failed" && job.failureReason ? FAILURE_TEXT[job.failureReason] : countsLine(job)}
                </p>
                <p className="text-xs text-meta">Uploaded {formatDay(job.createdAt, zone)}, {formatTime(job.createdAt, zone)}</p>
                {job.status === "review" || job.status === "applied" ? (
                  <Button
                    variant="ghost"
                    className="mt-1 -ml-3 px-3"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? `intake-${job.id}` : undefined}
                    onClick={() => setOpen(isOpen ? null : job.id)}
                  >
                    {isOpen ? "Hide rows" : job.status === "review" ? "Review rows" : "Show rows"}<span className="sr-only"> of {job.filename}</span>
                  </Button>
                ) : null}
                {isOpen ? <IntakeReview id={job.id} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function IntakeReview({ id }: { id: string }) {
  const job = useIntakeJob(id);
  return (
    <div id={`intake-${id}`} className="mt-2">
      {job.isPending ? <LoadingRows rows={3} label="Loading rows" /> : null}
      {job.isError ? <ErrorNote error={job.error} retry={() => void job.refetch()} /> : null}
      {/* Keyed by the digest: a refreshed diff starts from the server's choices again. */}
      {job.data ? <ReviewBody key={job.data.diffDigest ?? job.data.id} detail={job.data} /> : null}
    </div>
  );
}

export function ReviewBody({ detail }: { detail: IntakeJobDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const proposeKeys = useIntentKey();
  const approveKeys = useIntentKey();
  const discardKeys = useIntentKey();
  const [proposeOnce] = useState(singleFlight);
  const [approveOnce] = useState(singleFlight);
  const [discardOnce] = useState(singleFlight);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(chosenIds(detail)));
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const reviewing = detail.status === "review";
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.docIntakeAll });

  const included = detail.rows.filter((row) => chosen.has(row.id)).map((row) => row.id).sort();
  const propose = useMutation({
    mutationFn: (rowIds: string[]) =>
      api.proposeIntakeApply(detail.id, { includedRowIds: rowIds, diffDigest: detail.diffDigest! }, { idempotencyKey: proposeKeys.keyFor(rowIds) }),
    onSettled: (_result, error, rowIds) => proposeKeys.settle(rowIds, error),
    onSuccess: (result) => setApprovalId(result.approvalId),
    // A refused proposal usually means the list moved on: load it again.
    onError: () => { void refresh(); },
  });
  const approve = useMutation({
    mutationFn: (target: string) => api.approveIntakeApply(target, { idempotencyKey: approveKeys.keyFor(target) }),
    onSettled: async (_result, error, target) => {
      approveKeys.settle(target, error);
      await refresh();
    },
    onSuccess: () => {
      setApprovalId(null);
      toast("Added to your catalog.", "success");
    },
  });
  const discard = useMutation({
    mutationFn: () => api.discardIntakeJob(detail.id, { idempotencyKey: discardKeys.keyFor("discard") }),
    onSettled: async (_result, error) => {
      discardKeys.settle("discard", error);
      await refresh();
    },
    onSuccess: () => toast("Price list discarded.", "info"),
  });

  const toggle = (rowId: string) => {
    setApprovalId(null);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };
  const failure = [propose, approve, discard].find((step) => step.isError)?.error ?? null;
  const busy = propose.isPending || approve.isPending || discard.isPending;

  return (
    <div className="space-y-3">
      <ul className="space-y-2" aria-label={`Rows of ${detail.filename}`}>
        {detail.rows.map((row) => {
          const op = ROW_OP[row.diffOp];
          const selectable = reviewing && (row.diffOp === "insert" || row.diffOp === "update");
          const target = row.proposed ?? row.current;
          const name = target ? `${target.sku}, ${target.title}` : `Row ${row.rowIndex}`;
          return (
            <li key={row.id} data-row={row.id} data-op={row.diffOp} className={cn("rounded-md bg-surface p-3 shadow-card", !selectable && "opacity-90")}>
              <div className="flex flex-wrap items-center gap-2">
                {selectable ? (
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-fg">
                    <input type="checkbox" className="size-5" checked={chosen.has(row.id)} onChange={() => toggle(row.id)} disabled={busy} />
                    <span>{name}</span>
                  </label>
                ) : (
                  <span className="text-sm font-medium text-fg">{name}</span>
                )}
                <Badge tone={op.tone}>{op.label}</Badge>
                {row.invalidReason ? <span className="text-sm text-danger">{INVALID_TEXT[row.invalidReason]}</span> : null}
              </div>
              {row.proposed ? (
                <ul className="mt-1 space-y-0.5 text-sm text-fg-2" data-testid="row-values">
                  {valueLines(row).map((line) => <li key={line} className="break-words">{line}</li>)}
                </ul>
              ) : null}
              {/* DL-12: the page, the box on it and the words the row was read from sit beside it. */}
              <p className="mt-1 text-xs text-meta" data-testid="row-source">
                Page {row.pageNo}, box {row.bbox[0]}, {row.bbox[1]} to {row.bbox[2]}, {row.bbox[3]}: <q className="break-words">{row.sourceSnippet.trim()}</q>
              </p>
            </li>
          );
        })}
      </ul>
      {failure ? <ErrorNote error={failure} /> : null}
      {reviewing ? (
        <div className="flex flex-wrap items-center gap-2">
          {approvalId === null ? (
            <Button
              disabled={included.length === 0 || busy}
              aria-busy={propose.isPending}
              onClick={() => { proposeOnce(() => propose.mutateAsync(included)); }}
            >
              Ask to add {plural(included.length, "row", "rows")}
            </Button>
          ) : (
            <Button
              disabled={busy}
              aria-busy={approve.isPending}
              onClick={() => { approveOnce(() => approve.mutateAsync(approvalId)); }}
            >
              Approve and add {plural(included.length, "row", "rows")}
            </Button>
          )}
          <Button variant="danger-outline" disabled={busy} onClick={() => { discardOnce(() => discard.mutateAsync()); }}>
            Discard this list
          </Button>
        </div>
      ) : null}
    </div>
  );
}
