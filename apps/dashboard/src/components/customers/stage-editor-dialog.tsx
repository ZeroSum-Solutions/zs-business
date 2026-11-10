"use client";

import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type DealSummary, type ListResult, type PipelineSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useKeys } from "@/lib/queries";

// The server counts UTF-16 code units (zod `.max(100)`), so the form counts the same way.
const NAME_MAX = 100;
const nameLength = (name: string) => name.length;
/** Conflicts that mean the list on screen is out of date: show what the pipeline is now. */
const STALE_REASONS = new Set(["stage_set_changed", "stage_archived", "stage_limit", "last_stage", "name_in_use"]);
type Outcome = "open" | "won" | "lost";
const OUTCOME_LABELS: Record<Outcome, string> = { open: "Open", won: "Won (a deal here counts as won)", lost: "Lost" };

type Op =
  | { kind: "create"; pipelineId: string; name: string; outcome: Outcome }
  | { kind: "rename"; stageId: string; name: string }
  | { kind: "reorder"; pipelineId: string; stageIds: string[]; focus: string }
  | { kind: "archive"; stageId: string; name: string; moveDealsTo: string | null }
  | { kind: "restore"; stageId: string; name: string };

/** Moving deals across an outcome changes their won date (inbox-home.md H-2), and no automation runs for the move. */
function outcomeNote(from: Outcome, to: Outcome | undefined): string | null {
  if (to === undefined || from === to) return null;
  if (to === "won") return "Deals moved into a won stage count as won today. Automations do not run for this move.";
  if (from === "won") return "Deals moved out of a won stage lose their won date, and Home revenue drops.";
  return null;
}

/** The pipeline answers are the whole truth: write them into the cached list. */
function withPipeline(list: PipelineSummary[] | undefined, next: PipelineSummary): PipelineSummary[] | undefined {
  return list?.map((item) => (item.id === next.id ? next : item));
}

/**
 * Add, rename, reorder and archive the stages of one pipeline (crm.md C-25..C-33). Each change saves
 * on its own, so there is no Save button. A stage is archived, never deleted: its deals move to
 * another stage first, and it can be restored.
 */
export function StageEditorDialog({
  pipeline,
  dealCounts,
  open,
  onOpenChange,
}: {
  pipeline: PipelineSummary;
  /** Deals per stage as the board has them; the server still checks (a list can be incomplete). */
  dealCounts: ReadonlyMap<string, number>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const nameId = useId();
  const outcomeId = useId();
  const [newName, setNewName] = useState("");
  const [newOutcome, setNewOutcome] = useState<Outcome>("open");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  // `ask`: the deals need a destination (the stage holds some, or the server said so). Fixed once chosen, so a retry
  // after a lost answer sends the same request and replays it.
  const [archiving, setArchiving] = useState<{ id: string; to: string; ask: boolean } | null>(null);

  const stages = pipeline.stages;

  const edit = useMutation({
    mutationFn: (op: Op) => {
      const options = { idempotencyKey: intents.keyFor(op) };
      switch (op.kind) {
        case "create": return api.createStage({ pipelineId: op.pipelineId, name: op.name, outcome: op.outcome }, options);
        case "rename": return api.renameStage({ stageId: op.stageId, name: op.name }, options);
        case "reorder": return api.reorderStages({ pipelineId: op.pipelineId, stageIds: op.stageIds }, options);
        case "archive": return api.archiveStage({ stageId: op.stageId, moveDealsTo: op.moveDealsTo }, options);
        case "restore": return api.restoreStage({ stageId: op.stageId }, options);
      }
    },
    onSettled: (_result, error, op) => intents.settle(op, error),
    onSuccess: async (result, op) => {
      // A pipelines read that started before this write must not land over it; the refetch after
      // settles on the server's list (a replayed answer can be older than the pipeline now).
      await queryClient.cancelQueries({ queryKey: keys.pipelines });
      queryClient.setQueryData<PipelineSummary[]>(keys.pipelines, (list) => withPipeline(list, result));
      void queryClient.invalidateQueries({ queryKey: keys.pipelines });
      if (op.kind === "archive" && op.moveDealsTo !== null) {
        // The cards follow their stage at once, so a failed deals read cannot leave them under a stage that is gone.
        queryClient.setQueriesData<ListResult<DealSummary>>({ queryKey: keys.dealsAll }, (list) => list && {
          ...list,
          items: list.items.map((deal) => (deal.stageId === op.stageId ? { ...deal, stageId: op.moveDealsTo!, revision: deal.revision + 1 } : deal)),
        });
      }
      if (op.kind === "archive") {
        // The deals that moved changed stage and revision; a move into a won stage changes Home's revenue.
        void queryClient.invalidateQueries({ queryKey: keys.dealsAll });
        void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      }
      // The control that was used may be gone: focus goes to the nearest one that is not.
      // The buttons stay disabled until the write has settled, so try again for a few frames.
      const focusTo = (id: string, tries = 20): number => requestAnimationFrame(() => {
        const element = document.getElementById(id);
        if (element instanceof HTMLButtonElement && element.disabled && tries > 0) focusTo(id, tries - 1);
        else element?.focus();
      });
      switch (op.kind) {
        case "create": setNewName(""); toast(`Added ${op.name}.`); focusTo(nameId); break;
        case "rename": setRenaming(null); toast(`Renamed to ${op.name}.`); focusTo(`stage-rename-${op.stageId}`); break;
        case "reorder": focusTo(op.focus); break;
        case "archive": setArchiving(null); toast(`Archived ${op.name}.`); focusTo(nameId); break;
        case "restore": toast(`Restored ${op.name}.`); focusTo(`stage-rename-${op.stageId}`); break;
      }
    },
    onError: (error, op) => {
      if (!isApiError(error, "conflict")) return;
      // Somebody else changed the pipeline: show what it is now before the owner tries again.
      if (error.reason && STALE_REASONS.has(error.reason)) void queryClient.invalidateQueries({ queryKey: keys.pipelines });
      // The stage holds more deals than the board showed: ask where they go.
      if (error.reason === "stage_has_deals" && op.kind === "archive") {
        const other = stages.find((stage) => stage.id !== op.stageId);
        if (other) setArchiving({ id: op.stageId, to: other.id, ask: true });
      }
    },
  });
  const { reset } = edit;
  const busy = edit.isPending;
  // A change in flight finishes first: closing now would lose its answer.
  const close = (next: boolean) => { if (next || !busy) onOpenChange(next); };

  useEffect(() => {
    if (open) {
      setNewName("");
      setNewOutcome("open");
      setRenaming(null);
      setArchiving(null);
      reset();
    }
  }, [open, reset]);

  const move = (index: number, by: -1 | 1) => {
    const ids = stages.map((stage) => stage.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    // Focus follows the stage: the same button, or the other one when this one is now disabled at the end.
    const target = index + by;
    const focus = target === 0 ? `stage-down-${moved}` : target === stages.length - 1 ? `stage-up-${moved}` : by === -1 ? `stage-up-${moved}` : `stage-down-${moved}`;
    edit.mutate({ kind: "reorder", pipelineId: pipeline.id, stageIds: ids, focus });
  };
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (name) edit.mutate({ kind: "create", pipelineId: pipeline.id, name, outcome: newOutcome });
  };

  const newTrimmed = newName.trim();
  const newTooLong = nameLength(newTrimmed) > NAME_MAX;
  const startArchive = (id: string) => {
    const others = stages.filter((stage) => stage.id !== id);
    const first = others[0];
    if (first) setArchiving({ id, to: first.id, ask: (dealCounts.get(id) ?? 0) > 0 });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Edit stages"
        description={`${pipeline.name}. Each change saves as you make it.`}
        footer={<div className="flex justify-end"><Button disabled={busy} onClick={() => close(false)}>Done</Button></div>}
      >
        <div className="space-y-5" aria-busy={busy}>
          <ul className="space-y-2" aria-label="Stages">
            {stages.map((stage, index) => {
              const count = dealCounts.get(stage.id) ?? 0;
              const isRenaming = renaming?.id === stage.id;
              const isArchiving = archiving?.id === stage.id;
              const others = stages.filter((item) => item.id !== stage.id);
              return (
                <li key={stage.id} data-stage-row={stage.name} className="rounded-md bg-inset px-3 py-2">
                  {isRenaming ? (
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = renaming.value.trim();
                        if (name && name !== stage.name) edit.mutate({ kind: "rename", stageId: stage.id, name });
                        else setRenaming(null);
                      }}
                    >
                      <Input
                        aria-label={`New name for ${stage.name}`}
                        value={renaming.value}
                        maxLength={NAME_MAX * 2}
                        autoFocus
                        disabled={busy}
                        onChange={(event) => setRenaming({ id: stage.id, value: event.target.value })}
                        className="min-w-0 flex-1"
                      />
                      <Button type="submit" disabled={busy || nameLength(renaming.value.trim()) > NAME_MAX || renaming.value.trim() === ""}>Save</Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setRenaming(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex-1 sm:basis-0">
                        <span className="min-w-0 break-words text-sm font-medium text-fg [overflow-wrap:anywhere]">{stage.name}</span>
                        {stage.outcome !== "open" ? <Badge tone={stage.outcome === "won" ? "success" : "neutral"}>{stage.outcome === "won" ? "Won" : "Lost"}</Badge> : null}
                        <span className="tabular text-xs text-meta">{count === 1 ? "1 deal" : `${count} deals`}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" id={`stage-up-${stage.id}`} disabled={busy || index === 0} aria-label={`Move ${stage.name} earlier`} onClick={() => move(index, -1)}>
                          <ArrowUp aria-hidden />
                        </Button>
                        <Button variant="ghost" size="icon" id={`stage-down-${stage.id}`} disabled={busy || index === stages.length - 1} aria-label={`Move ${stage.name} later`} onClick={() => move(index, 1)}>
                          <ArrowDown aria-hidden />
                        </Button>
                        <Button variant="ghost" id={`stage-rename-${stage.id}`} disabled={busy} aria-label={`Rename ${stage.name}`} onClick={() => setRenaming({ id: stage.id, value: stage.name })}>Rename</Button>
                        <Button variant="ghost" disabled={busy || others.length === 0} aria-label={`Archive ${stage.name}`} onClick={() => startArchive(stage.id)}>Archive</Button>
                      </div>
                    </div>
                  )}
                  {isArchiving ? (
                    <div className="mt-2 space-y-2 border-t border-border pt-2" role="group" aria-label={`Archive ${stage.name}`}>
                      <p className="text-sm text-fg-2">
                        {archiving.ask
                          ? count > 0
                            ? `${count === 1 ? "1 deal is" : `${count} deals are`} in ${stage.name}. Choose where they go.`
                            : `Deals are still in ${stage.name}. Choose where they go.`
                          : `${stage.name} leaves the board. You can restore it later.`}
                      </p>
                      {archiving.ask ? (
                        <div className="space-y-2">
                          <div>
                            <Label htmlFor={`archive-to-${stage.id}`}>Move its deals to</Label>
                            <Select
                              id={`archive-to-${stage.id}`}
                              value={archiving.to}
                              disabled={busy}
                              onChange={(event) => setArchiving({ id: stage.id, to: event.target.value, ask: true })}
                              className="w-full"
                            >
                              {others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                            </Select>
                          </div>
                          {outcomeNote(stage.outcome, others.find((item) => item.id === archiving.to)?.outcome) ? (
                            <p className="text-sm text-fg-2">{outcomeNote(stage.outcome, others.find((item) => item.id === archiving.to)?.outcome)}</p>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" disabled={busy} onClick={() => setArchiving(null)}>Keep stage</Button>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => edit.mutate({ kind: "archive", stageId: stage.id, name: stage.name, moveDealsTo: archiving.ask ? archiving.to : null })}
                        >
                          Archive stage
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <form onSubmit={submitNew} className="space-y-2" aria-label="Add a stage">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-40">
                <Label htmlFor={nameId}>New stage</Label>
                <Input
                  id={nameId}
                  value={newName}
                  maxLength={NAME_MAX * 2}
                  placeholder="For example, Quote sent"
                  aria-invalid={newTooLong || undefined}
                  disabled={busy}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={outcomeId}>Counts as</Label>
                <Select id={outcomeId} value={newOutcome} disabled={busy} onChange={(event) => setNewOutcome(event.target.value as Outcome)}>
                  {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((outcome) => <option key={outcome} value={outcome}>{OUTCOME_LABELS[outcome]}</option>)}
                </Select>
              </div>
              <Button type="submit" disabled={busy || newTrimmed === "" || newTooLong}>Add stage</Button>
            </div>
            {newTooLong ? <p role="alert" className="text-sm text-danger">Keep it to {NAME_MAX} characters.</p> : null}
          </form>

          {pipeline.archivedStages.length > 0 ? (
            <section aria-labelledby={`${nameId}-archived`}>
              <h3 id={`${nameId}-archived`} className="mb-2 text-sm font-semibold text-fg-2">Archived stages</h3>
              <ul className="space-y-2">
                {pipeline.archivedStages.map((stage) => (
                  <li key={stage.id} data-archived-stage={stage.name} className="flex items-center justify-between gap-2 rounded-md bg-inset px-3 py-1">
                    <span className="min-w-0 break-words text-sm text-fg-2">{stage.name}</span>
                    <Button variant="ghost" disabled={busy} aria-label={`Restore ${stage.name}`} onClick={() => edit.mutate({ kind: "restore", stageId: stage.id, name: stage.name })}>Restore</Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {edit.isError ? <ErrorNote error={edit.error} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
