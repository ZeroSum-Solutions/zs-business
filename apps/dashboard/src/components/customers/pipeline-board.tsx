"use client";

import { ArrowsClockwise } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Select } from "@/components/ui/input";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isStaleRevision, type DealRecord, type PipelineSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { keys, useContacts, useDeals, usePipeline } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";

type DealMove = { dealId: string; pipelineId: string; stageId: string; expectedRevision: number };

export const STALE_DEAL_MESSAGE = "Someone changed this deal. Reloaded.";

function DealCard({ deal, pipeline, contactName, onMove, moving }: {
  deal: DealRecord;
  pipeline: PipelineSummary;
  contactName: string;
  onMove: (deal: DealRecord, stageId: string) => void;
  moving: boolean;
}) {
  const selectId = `stage-${deal.id}`;
  return (
    <li className="rounded-md bg-surface p-3 shadow-ring" data-deal-id={deal.id} aria-busy={moving}>
      <p className="text-sm font-medium text-fg">{deal.title}</p>
      <Link href={`/customers/${deal.contactId}`} className="mt-0.5 inline-flex min-h-8 items-center text-sm text-accent underline-offset-4 hover:underline">
        {contactName}
      </Link>
      <div className="mt-2 flex items-center justify-between gap-2">
        <label htmlFor={selectId} className="sr-only">Move {deal.title} to stage</label>
        <Select id={selectId} value={deal.stageId} disabled={moving} onChange={(event) => onMove(deal, event.target.value)} className="flex-1">
          {pipeline.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </Select>
      </div>
      <p className="mt-2 text-xs text-meta">Updated {relativeTime(deal.updatedAt)}</p>
    </li>
  );
}

export function PipelineBoard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const pipeline = usePipeline();
  const deals = useDeals();
  const contacts = useContacts();
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const names = useMemo(() => new Map(contacts.data?.map((contact) => [contact.id, contact.displayName ?? contact.email ?? "Customer"]) ?? []), [contacts.data]);

  // The intent is (deal, expected revision, target stage): retrying it after a lost answer
  // replays the first attempt instead of failing on the revision that attempt moved on.
  const intents = useIntentKey();

  const move = useMutation({
    mutationFn: (request: DealMove) => api.moveDealStage(request, { idempotencyKey: intents.keyFor(request) }),
    onSettled: (_updated, error, request) => intents.settle(request, error),
    onSuccess: (updated) => {
      setStale(false);
      queryClient.setQueryData<DealRecord[]>(keys.deals(), (current) => current?.map((item) => (item.id === updated.id ? updated : item)));
      void queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      const stage = pipeline.data?.stages.find((item) => item.id === updated.stageId)?.name ?? "the new stage";
      toast(`Moved to ${stage}.`);
    },
    onError: async (error) => {
      // Say "Reloaded" only once the fresh revision is on screen, so a retry uses it.
      await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      if (isStaleRevision(error)) {
        setStale(true);
        toast(STALE_DEAL_MESSAGE, "info");
      }
    },
  });

  if (pipeline.isPending || deals.isPending) return <LoadingRows rows={5} label="Loading pipeline" />;
  if (pipeline.isError) return <ErrorNote error={pipeline.error} retry={() => pipeline.refetch()} />;
  if (deals.isError && !deals.data) return <ErrorNote error={deals.error} retry={() => deals.refetch()} />;

  const stages = pipeline.data.stages;
  const activeStage = stageFilter ?? stages[0]!.id;
  const moveError = move.isError && !isStaleRevision(move.error) ? move.error : null;
  // A failed refresh keeps the last board on screen, with the note above it.
  const refreshError = deals.isError && !moveError ? deals.error : null;

  return (
    // data-fetching lets tests wait out a background refetch before acting as someone else.
    <section aria-labelledby="pipeline-title" data-fetching={deals.isFetching || undefined}>
      <h2 id="pipeline-title" className="sr-only">Pipeline</h2>
      {stale ? (
        <div role="alert" className="mb-4 flex items-center gap-3 rounded-md bg-accent/8 p-3 text-sm text-fg">
          <ArrowsClockwise size={20} aria-hidden className="shrink-0 text-accent" />
          <p>{STALE_DEAL_MESSAGE}</p>
        </div>
      ) : null}
      {moveError ? <div className="mb-4"><ErrorNote error={moveError} /></div> : null}
      {refreshError ? <div className="mb-4"><ErrorNote error={refreshError} retry={() => deals.refetch()} /></div> : null}

      <div role="group" aria-label="Stage" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 lg:hidden">
        {stages.map((stage) => {
          const count = deals.data.filter((deal) => deal.stageId === stage.id).length;
          const active = stage.id === activeStage;
          return (
            <button
              key={stage.id}
              type="button"
              aria-pressed={active}
              onClick={() => setStageFilter(stage.id)}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-pill px-4 text-sm font-medium transition-quick",
                active ? "bg-fg text-bg" : "bg-surface text-fg-2 shadow-ring hover:bg-surface-warm",
              )}
            >
              {stage.name}
              <span className={cn("tabular text-xs", active ? "text-bg/70" : "text-meta")}>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {stages.map((stage) => {
          const items = deals.data.filter((deal) => deal.stageId === stage.id);
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
                      pipeline={pipeline.data}
                      contactName={names.get(deal.contactId) ?? "Customer"}
                      moving={move.isPending && move.variables?.dealId === deal.id}
                      onMove={(target, stageId) => move.mutate({ dealId: target.id, pipelineId: target.pipelineId, stageId, expectedRevision: target.revision })}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
