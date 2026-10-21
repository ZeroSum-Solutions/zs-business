"use client";

import { ArrowsClockwise } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { EmptyState, ErrorNote, IncompleteNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isDealChanged, type DealSummary, type ListResult, type PipelineSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { LEAD_SOURCE_LABELS } from "@/lib/lead-sources";
import { useContactNames, useDeals, useDisplayZone, useKeys, usePipelines } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { cn, formatMinor, relativeTime, revealOnFocus } from "@/lib/utils";
import { DealDetailsDialog } from "./deal-details-dialog";

type DealMove = { dealId: string; pipelineId: string; stageId: string; expectedRevision: number };

export const STALE_DEAL_MESSAGE = "Someone changed this deal. Reloaded.";
export const RELOAD_FAILED_MESSAGE = "Someone changed this deal, but the board could not reload. You can move it again once it has.";

function DealCard({ deal, pipeline, contactName, onMove, onEdit, moving, blockedBy, zone }: {
  deal: DealSummary;
  pipeline: PipelineSummary;
  contactName: string;
  onMove: (deal: DealSummary, stageId: string) => void;
  onEdit: (deal: DealSummary) => void;
  moving: boolean;
  /** Id of the note that says why this deal cannot move now. */
  blockedBy: string | null;
  zone: string;
}) {
  const selectId = `stage-${deal.id}`;
  return (
    <li className="rounded-lg bg-lit p-3 shadow-card" data-deal-id={deal.id} aria-busy={moving}>
      <p className="text-sm font-medium break-words text-fg">{deal.title}</p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-2">
        <span className="tabular font-medium" data-testid="deal-value">{deal.value ? formatMinor(deal.value.amountMinor, deal.value.currency) : "No value yet"}</span>
        <span data-testid="deal-source">{deal.leadSource ? `From ${LEAD_SOURCE_LABELS[deal.leadSource]}` : "Source not set"}</span>
        {deal.wonAt ? <span className="text-success" data-testid="deal-won">Won {formatDay(deal.wonAt, zone)}</span> : null}
      </p>
      <Link href={`/customers/${deal.contactId}`} className="mt-0.5 inline-flex min-h-11 max-w-full items-center text-sm break-words text-accent underline-offset-4 hover:underline">
        {contactName}
      </Link>
      <div className="mt-2 flex items-center justify-between gap-2">
        <label htmlFor={selectId} className="sr-only">Move {deal.title} to stage</label>
        <Select id={selectId} value={deal.stageId} disabled={moving || blockedBy !== null} aria-describedby={blockedBy ?? undefined} onChange={(event) => onMove(deal, event.target.value)} className="flex-1">
          {pipeline.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </Select>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-xs text-meta">Updated {relativeTime(deal.updatedAt)}</p>
        <Button variant="ghost" className="-mr-2" disabled={moving} aria-label={`Edit details of ${deal.title}`} onClick={() => onEdit(deal)}>Details</Button>
      </div>
    </li>
  );
}

/**
 * The deal board for one pipeline. A business may have no pipeline yet, a pipeline whose
 * stages are not set up, or several pipelines; each gets its own state before any stage is read.
 */
export function PipelineBoard() {
  const pipelines = usePipelines();
  const [chosen, setChosen] = useState<string | null>(null);

  if (pipelines.isPending) return <LoadingRows rows={5} label="Loading pipeline" />;
  if (pipelines.isError) return <ErrorNote error={pipelines.error} retry={() => pipelines.refetch()} />;
  const list = pipelines.data;
  const pipeline = list.find((item) => item.id === chosen) ?? list[0];

  return (
    <section aria-labelledby="pipeline-title">
      <h2 id="pipeline-title" className="sr-only">Pipeline</h2>
      {list.length > 1 && pipeline ? (
        <div className="mb-4 max-w-xs">
          <label htmlFor="pipeline-choice" className="mb-1 block text-sm font-medium text-fg-2">Pipeline</label>
          <Select id="pipeline-choice" value={pipeline.id} onChange={(event) => setChosen(event.target.value)}>
            {list.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </div>
      ) : null}
      {!pipeline ? (
        <EmptyState title="No pipeline yet">Once a pipeline is set up, each deal shows here under its stage.</EmptyState>
      ) : pipeline.stages.length === 0 ? (
        <EmptyState title={`${pipeline.name} has no stages yet`}>Its deals show here once the pipeline has stages to move them through.</EmptyState>
      ) : (
        // A new key per pipeline: a stage filter or a pending move never carries over.
        <StageBoard key={pipeline.id} pipeline={pipeline} />
      )}
    </section>
  );
}

function StageBoard({ pipeline }: { pipeline: PipelineSummary }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const dealQuery = useMemo(() => ({ pipelineId: pipeline.id }), [pipeline.id]);
  const deals = useDeals(dealQuery);
  const contacts = useContactNames(useMemo(() => deals.data?.items.map((deal) => deal.contactId) ?? [], [deals.data]));
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // A deal whose move hit a newer revision while the reload after it failed: its revision
  // on screen is known to be old, so it stays unmovable until a later read succeeds.
  const [reloadNeeded, setReloadNeeded] = useState<{ dealId: string; since: number } | null>(null);
  const [editing, setEditing] = useState<{ dealId: string; open: boolean } | null>(null);
  const zone = useDisplayZone();

  const names = useMemo(() => new Map(contacts.data?.map((contact) => [contact.id, contact.displayName ?? contact.email ?? "Customer"]) ?? []), [contacts.data]);

  // The intent is (deal, expected revision, target stage): retrying it after a lost answer
  // replays the first attempt instead of failing on the revision that attempt moved on.
  const intents = useIntentKey();

  const move = useMutation({
    mutationFn: (request: DealMove) => api.moveDealStage(request, { idempotencyKey: intents.keyFor(request) }),
    onSettled: (_updated, error, request) => intents.settle(request, error),
    onSuccess: async (updated) => {
      setStale(false);
      // A move answers with the frozen record: keep the value and lead source on screen.
      queryClient.setQueryData<ListResult<DealSummary>>(keys.deals(dealQuery), (current) => current && {
        ...current, items: current.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      });
      // Settle on the server's list before saying "Moved", so the next move reads its revision.
      // A refetch that started before this move cannot roll it back: useDeals keeps the
      // higher revision of each deal.
      await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      // A move into or out of a won stage changes Home's revenue (H-2).
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      const stage = pipeline.stages.find((item) => item.id === updated.stageId)?.name ?? "the new stage";
      toast(`Moved to ${stage}.`);
    },
    onError: async (error, request) => {
      const since = Date.now();
      let reloaded = true;
      try {
        await queryClient.invalidateQueries({ queryKey: keys.dealsAll }, { throwOnError: true });
      } catch {
        reloaded = false;
      }
      // A concurrent_update is the same story as a stale revision: reload, then retry.
      if (!isDealChanged(error)) return;
      // Say "Reloaded" only once a read that started after the conflict has landed, so the
      // fresh revision is on screen and a retry uses it.
      const state = queryClient.getQueryState(keys.deals(dealQuery));
      if (reloaded && state?.status === "success" && state.dataUpdatedAt >= since) {
        setStale(true);
        toast(STALE_DEAL_MESSAGE, "info");
      } else {
        setStale(false);
        setReloadNeeded({ dealId: request.dealId, since });
      }
    },
  });

  // Any later read that succeeds (the note's Try again, a background refetch) clears the block.
  useEffect(() => {
    if (!reloadNeeded || deals.isFetching || deals.status !== "success" || deals.dataUpdatedAt < reloadNeeded.since) return;
    setReloadNeeded(null);
    setStale(true);
    toast(STALE_DEAL_MESSAGE, "info");
  }, [reloadNeeded, deals.isFetching, deals.status, deals.dataUpdatedAt, toast]);

  if (deals.isPending) return <LoadingRows rows={5} label="Loading pipeline" />;
  if (deals.isError && !deals.data) return <ErrorNote error={deals.error} retry={() => deals.refetch()} />;

  const stages = pipeline.stages;
  // The open dialog follows the deal in the list, so a reload brings in its new revision.
  const editingDeal = editing ? deals.data.items.find((item) => item.id === editing.dealId) : undefined;
  // PipelineBoard renders this only for a pipeline with stages.
  const activeStage = stageFilter ?? stages[0]!.id;
  const moveError = move.isError && !isDealChanged(move.error) ? move.error : null;
  // A failed refresh keeps the last board on screen, with the note above it.
  const refreshError = deals.isError && !moveError && !reloadNeeded ? deals.error : null;

  return (
    // data-fetching lets tests wait out a background refetch before acting as someone else.
    <div data-fetching={deals.isFetching || undefined}>
      {stale ? (
        <div role="alert" className="mb-4 flex items-center gap-3 rounded-md bg-accent/8 p-3 text-sm text-fg">
          <ArrowsClockwise size={20} aria-hidden className="shrink-0 text-accent" />
          <p>{STALE_DEAL_MESSAGE}</p>
        </div>
      ) : null}
      {reloadNeeded ? (
        <div id="deal-reload-needed" className="mb-4 space-y-2">
          <p className="text-sm text-fg-2">{RELOAD_FAILED_MESSAGE}</p>
          <ErrorNote error={deals.error} retry={() => deals.refetch()} />
        </div>
      ) : null}
      {moveError ? <div className="mb-4"><ErrorNote error={moveError} /></div> : null}
      {refreshError ? <div className="mb-4"><ErrorNote error={refreshError} retry={() => deals.refetch()} /></div> : null}
      <IncompleteNote list={deals.data} />

      <div role="group" aria-label="Stage" className="-mx-4 mb-3 flex scroll-px-4 gap-2 overflow-x-auto px-4 py-1 lg:hidden">
        {stages.map((stage) => {
          const count = deals.data.items.filter((deal) => deal.stageId === stage.id).length;
          const active = stage.id === activeStage;
          return (
            <button
              key={stage.id}
              type="button"
              aria-pressed={active}
              onClick={() => setStageFilter(stage.id)}
              onFocus={revealOnFocus}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-pill px-4 text-sm font-medium transition-quick",
                active ? "bg-accent/14 text-accent ring-1 ring-inset ring-accent" : "bg-surface text-fg-2 shadow-ring hover:bg-surface-warm",
              )}
            >
              {stage.name}
              <span className={cn("tabular text-xs", active ? "text-accent" : "text-meta")}>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {stages.map((stage) => {
          const items = deals.data.items.filter((deal) => deal.stageId === stage.id);
          return (
            <div key={stage.id} className={cn(stage.id === activeStage ? "block" : "hidden", "lg:block")} data-stage={stage.name}>
              <h3 className="mb-2 hidden items-baseline justify-between text-sm font-medium text-fg-2 lg:flex">
                {stage.name}<span className="tabular text-xs text-meta">{items.length}</span>
              </h3>
              {items.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-meta">No deals here.</p>
              ) : (
                <ul className="space-y-2">
                  {items.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      pipeline={pipeline}
                      contactName={names.get(deal.contactId) ?? "Customer"}
                      moving={move.isPending && move.variables?.dealId === deal.id}
                      blockedBy={reloadNeeded?.dealId === deal.id ? "deal-reload-needed" : null}
                      zone={zone}
                      onMove={(target, stageId) => move.mutate({ dealId: target.id, pipelineId: target.pipelineId, stageId, expectedRevision: target.revision })}
                      onEdit={(target) => setEditing({ dealId: target.id, open: true })}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {editingDeal ? (
        <DealDetailsDialog
          deal={editingDeal}
          open={editing?.open ?? false}
          onOpenChange={(open) => setEditing((current) => current && { ...current, open })}
          onSaved={(updated) => queryClient.setQueryData<ListResult<DealSummary>>(keys.deals(dealQuery), (current) => current && {
            ...current, items: current.items.map((item) => (item.id === updated.id && item.revision < updated.revision ? updated : item)),
          })}
        />
      ) : null}
    </div>
  );
}
