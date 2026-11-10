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
import { isApiError, type PipelineSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useKeys } from "@/lib/queries";

const NAME_MAX = 100;
type Outcome = "open" | "won" | "lost";
const OUTCOME_LABELS: Record<Outcome, string> = { open: "Open", won: "Won (a deal here counts as won)", lost: "Lost" };

type Op =
  | { kind: "create"; pipelineId: string; name: string; outcome: Outcome }
  | { kind: "rename"; stageId: string; name: string }
  | { kind: "reorder"; pipelineId: string; stageIds: string[]; focus: string }
  | { kind: "archive"; stageId: string; name: string; moveDealsTo: string | null }
  | { kind: "restore"; stageId: string; name: string };

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
  const [archiving, setArchiving] = useState<{ id: string; to: string } | null>(null);

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
      queryClient.setQueryData<PipelineSummary[]>(keys.pipelines, (list) => withPipeline(list, result));
      if (op.kind === "archive") {
        // The deals that moved changed stage and revision; a move into a won stage changes Home's revenue.
        await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
        void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      }
      switch (op.kind) {
        case "create": setNewName(""); toast(`Added ${op.name}.`); break;
        case "rename": setRenaming(null); toast(`Renamed to ${op.name}.`); break;
        case "reorder":
          requestAnimationFrame(() => document.getElementById(`stage-move-${op.focus}`)?.focus());
          break;
        case "archive": setArchiving(null); toast(`Archived ${op.name}.`); break;
        case "restore": toast(`Restored ${op.name}.`); break;
      }
    },
    onError: (error) => {
      // Somebody else changed the pipeline: show what it is now before the owner tries again.
      if (isApiError(error, "conflict") && (error.reason === "stage_set_changed" || error.reason === "stage_archived"))
        void queryClient.invalidateQueries({ queryKey: keys.pipelines });
      // The stage holds more deals than the board showed: ask where they go.
      if (isApiError(error, "conflict") && error.reason === "stage_has_deals") {
        const failed = edit.variables;
        if (failed?.kind === "archive") {
          const other = stages.find((stage) => stage.id !== failed.stageId);
          if (other) setArchiving({ id: failed.stageId, to: other.id });
        }
      }
    },
  });
  const { reset } = edit;
  const busy = edit.isPending;

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
    edit.mutate({ kind: "reorder", pipelineId: pipeline.id, stageIds: ids, focus: moved! });
  };
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (name) edit.mutate({ kind: "create", pipelineId: pipeline.id, name, outcome: newOutcome });
  };

  const newTrimmed = newName.trim();
  const newTooLong = [...newTrimmed].length > NAME_MAX;
  const startArchive = (id: string) => {
    const others = stages.filter((stage) => stage.id !== id);
    const first = others[0];
    if (first) setArchiving({ id, to: first.id });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Edit stages"
        description={`${pipeline.name}. Each change saves as you make it.`}
        footer={<div className="flex justify-end"><Button onClick={() => onOpenChange(false)}>Done</Button></div>}
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
                      <Button type="submit" disabled={busy || [...renaming.value.trim()].length > NAME_MAX || renaming.value.trim() === ""}>Save</Button>
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
                        <Button variant="ghost" size="icon" id={`stage-move-${stage.id}`} disabled={busy || index === 0} aria-label={`Move ${stage.name} earlier`} onClick={() => move(index, -1)}>
                          <ArrowUp aria-hidden />
                        </Button>
                        <Button variant="ghost" size="icon" disabled={busy || index === stages.length - 1} aria-label={`Move ${stage.name} later`} onClick={() => move(index, 1)}>
                          <ArrowDown aria-hidden />
                        </Button>
                        <Button variant="ghost" disabled={busy} aria-label={`Rename ${stage.name}`} onClick={() => setRenaming({ id: stage.id, value: stage.name })}>Rename</Button>
                        <Button variant="ghost" disabled={busy || others.length === 0} aria-label={`Archive ${stage.name}`} onClick={() => startArchive(stage.id)}>Archive</Button>
                      </div>
                    </div>
                  )}
                  {isArchiving ? (
                    <div className="mt-2 space-y-2 border-t border-border pt-2" role="group" aria-label={`Archive ${stage.name}`}>
                      <p className="text-sm text-fg-2">
                        {count > 0
                          ? `${count === 1 ? "1 deal is" : `${count} deals are`} in ${stage.name}. They move with it.`
                          : `${stage.name} leaves the board. You can restore it later.`}
                      </p>
                      <div>
                        <Label htmlFor={`archive-to-${stage.id}`}>Move its deals to</Label>
                        <Select
                          id={`archive-to-${stage.id}`}
                          value={archiving.to}
                          disabled={busy}
                          onChange={(event) => setArchiving({ id: stage.id, to: event.target.value })}
                          className="w-full"
                        >
                          {others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </Select>
                      </div>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" disabled={busy} onClick={() => setArchiving(null)}>Keep stage</Button>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => edit.mutate({ kind: "archive", stageId: stage.id, name: stage.name, moveDealsTo: count > 0 || edit.isError ? archiving.to : null })}
                        >
                          Archive {stage.name}
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
