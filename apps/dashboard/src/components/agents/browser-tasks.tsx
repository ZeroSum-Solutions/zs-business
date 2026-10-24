"use client";

import { FileText, Globe, Play, Prohibit } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import type { BrowserRun, BrowserStatus } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { dollars } from "@/lib/agents";
import { isApiError } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import {
  BROWSER_ACTION_WORDS,
  BROWSER_BLOCKED_WORDS,
  BROWSER_REFUSED_WORDS,
  BROWSER_RUN_STATUS,
  fileSize,
  monthLabel,
  recentMonths,
  stopSentence,
} from "@/lib/browser-tasks";
import { useIntentKey } from "@/lib/intent-key";
import { useBrowserRun, useBrowserRuns, useBrowserStatus, useDisplayZone, useKeys } from "@/lib/queries";
import { MANAGE_AGENTS, useCan } from "@/lib/session";
import { singleFlight } from "@/lib/single-flight";
import { formatDay, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const when = (instant: string, zone: string) => `${formatDay(instant, zone)}, ${formatTime(instant, zone)}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Website tasks (browser-tasks.md): a helper that signs in to a supplier's site you allowed and
 * saves last month's invoices. It only reads. Owners start a run; the team can stop it.
 */
export function BrowserTasksCard() {
  const status = useBrowserStatus();
  const forbidden = status.isError && isApiError(status.error, "forbidden");
  return (
    <Card aria-labelledby="browser-title" data-testid="browser-card">
      <CardHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Globe size={20} aria-hidden className="text-muted" />
            <CardTitle id="browser-title">Website tasks</CardTitle>
            <span aria-live="polite">
              {status.data ? <StateBadge status={status.data} /> : null}
            </span>
          </div>
          <CardDescription className="mt-1">
            Signs in to a supplier website you allowed and saves last month&apos;s invoices as files. It only reads: it never orders, pays or changes anything.
          </CardDescription>
        </div>
      </CardHeader>
      {status.isPending ? <LoadingRows rows={2} label="Loading website tasks" /> : forbidden ? (
        <p className="text-sm text-muted" data-testid="browser-forbidden">Only an owner can see website tasks.</p>
      ) : status.isError ? (
        <ErrorNote error={status.error} retry={() => status.refetch()} />
      ) : (
        <>
          <BrowserControls status={status.data} />
          <BrowserRuns />
        </>
      )}
    </Card>
  );
}

function StateBadge({ status }: { status: BrowserStatus }) {
  if (status.blockedBy) {
    const stopped = status.blockedBy === "global_killed" || status.blockedBy === "tenant_killed";
    return <Badge tone="warn" data-testid="browser-state">{stopped ? "Stopped" : status.blockedBy === "disabled" ? "Off" : "Limit reached"}</Badge>;
  }
  return <Badge tone="success" data-testid="browser-state">Ready</Badge>;
}

function BrowserControls({ status }: { status: BrowserStatus }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const canManage = useCan(MANAGE_AGENTS);
  const zone = useDisplayZone();
  const stopKeys = useIntentKey();
  const resumeKeys = useIntentKey();
  const runKeys = useIntentKey();
  const [stopOnce] = useState(singleFlight);
  const [resumeOnce] = useState(singleFlight);
  const [runOnce] = useState(singleFlight);
  const [note, setNote] = useState("");
  const months = useMemo(() => recentMonths(new Date()), []);
  const runnable = status.targets.filter((target) => target.enabled);
  const [targetId, setTargetId] = useState(runnable[0]?.id ?? "");
  const [month, setMonth] = useState(months[1] ?? months[0]!);
  const chosen = runnable.find((target) => target.id === targetId) ?? runnable[0];

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.browser }),
    queryClient.invalidateQueries({ queryKey: keys.browserRuns }),
  ]);
  const showStatus = (next: BrowserStatus) => queryClient.setQueryData(keys.browser, next);

  const stop = useMutation({
    mutationFn: (input: { note?: string }) => api.killBrowser(input, { idempotencyKey: stopKeys.keyFor(input) }),
    onSettled: async (_status, error, input) => { stopKeys.settle(input, error); await refresh(); },
    onSuccess: (next) => { showStatus(next); setNote(""); toast("Website tasks stopped. Nothing runs until an owner resumes them.", "info"); },
  });
  const resume = useMutation({
    mutationFn: () => api.resumeBrowser({ idempotencyKey: resumeKeys.keyFor("resume") }),
    onSettled: async (_status, error) => { resumeKeys.settle("resume", error); await refresh(); },
    onSuccess: (next) => { showStatus(next); toast("Website tasks resumed."); },
  });
  const request = useMutation({
    mutationFn: (input: { targetId: string; month: string }) => api.requestBrowserRun(input, { idempotencyKey: runKeys.keyFor(input) }),
    onSettled: async (_run, error, input) => { runKeys.settle(input, error); await refresh(); },
    onSuccess: () => toast("Run started. Watch its steps below."),
  });

  const submitStop = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    stopOnce(() => stop.mutateAsync(trimmed ? { note: trimmed } : {}));
  };

  const busy = stop.isPending || resume.isPending;
  const failure = [stop, resume, request].find((step) => step.isError)?.error ?? null;
  const refused = request.isError && isApiError(request.error, "conflict") && request.error.reason
    ? BROWSER_REFUSED_WORDS[request.error.reason] ?? null : null;
  const runBlocked = status.blockedBy !== null || !chosen;

  return (
    <div className="space-y-4 text-sm text-fg-2">
      {status.killed ? (
        <p data-testid="browser-killed">
          Stopped on {when(status.killed.at, zone)}.
          {status.killed.note ? <> Note: <q className="break-words">{status.killed.note}</q></> : null}
        </p>
      ) : null}
      <p data-testid="browser-blocked">
        {status.blockedBy ? BROWSER_BLOCKED_WORDS[status.blockedBy] : "It can run now."}
      </p>
      <p className="text-xs text-meta" data-testid="browser-usage">
        Today: {plural(status.runsToday, "run", "runs")} of {status.settings.maxRunsPerDay}, {dollars(status.costTodayMicros)} of {dollars(status.settings.maxCostMicrosPerDay)}.
      </p>

      {status.killed ? (
        <div className="space-y-2">
          <Button
            variant={canManage ? "primary" : "secondary"}
            onClick={() => resumeOnce(() => resume.mutateAsync())}
            disabled={!canManage || busy}
            aria-busy={resume.isPending}
            aria-describedby={canManage ? undefined : "browser-resume-reason"}
          >
            <Play aria-hidden />Resume website tasks
          </Button>
          {canManage ? null : <DisabledReason id="browser-resume-reason">Only an owner can resume website tasks.</DisabledReason>}
        </div>
      ) : (
        <form className="space-y-2" onSubmit={submitStop} noValidate>
          <div>
            <Label htmlFor="browser-stop-note">Note for the team (optional)</Label>
            <Input id="browser-stop-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why you stopped it" />
          </div>
          <Button type="submit" variant="danger-outline" disabled={busy} aria-busy={stop.isPending}>
            <Prohibit aria-hidden />Stop website tasks
          </Button>
        </form>
      )}

      {canManage ? (
        <form
          className="space-y-2 border-t border-border-soft pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen) runOnce(() => request.mutateAsync({ targetId: chosen.id, month }));
          }}
          noValidate
        >
          {runnable.length === 0 ? (
            <p className="text-xs text-meta" data-testid="browser-no-target">No website is set up yet. Add one with the API before the first run.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="browser-target">Website</Label>
                <Select id="browser-target" value={chosen?.id ?? ""} onChange={(event) => setTargetId(event.target.value)}>
                  {runnable.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="browser-month">Invoices from</Label>
                <Select id="browser-month" value={month} onChange={(event) => setMonth(event.target.value)}>
                  {months.map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}
                </Select>
              </div>
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={runBlocked || request.isPending} aria-busy={request.isPending} aria-describedby={runBlocked ? "browser-run-reason" : undefined}>
            Save invoices now
          </Button>
          {runBlocked ? <DisabledReason id="browser-run-reason">{status.blockedBy ? BROWSER_BLOCKED_WORDS[status.blockedBy] : "Add a website first."}</DisabledReason> : null}
          {refused ? <p className="text-sm text-fg-2" role="alert" data-testid="browser-refused">{refused}</p> : null}
        </form>
      ) : null}

      {failure && !refused ? <ErrorNote error={failure} /> : null}
    </div>
  );
}

function BrowserRuns() {
  const runs = useBrowserRuns();
  const status = useBrowserStatus();
  const zone = useDisplayZone();
  const [open, setOpen] = useState<string | null>(null);
  const names = new Map((status.data?.targets ?? []).map((target) => [target.id, target.name]));
  const items = runs.data ?? [];
  return (
    <div className="mt-4 space-y-2 border-t border-border-soft pt-4">
      <h3 className="text-sm font-bold text-fg">Recent website runs</h3>
      {runs.isPending ? <LoadingRows rows={2} label="Loading runs" /> : runs.isError ? (
        <ErrorNote error={runs.error} retry={() => runs.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No runs yet">When a website task runs, its steps and files show here.</EmptyState>
      ) : (
        <ul className="divide-y divide-border-soft" aria-label="Website downloads">
          {items.map((run) => {
            const state = BROWSER_RUN_STATUS[run.status];
            const isOpen = open === run.id;
            const stopped = stopSentence(run);
            return (
              <li key={run.id} className="py-3 first:pt-0 last:pb-0" data-run-id={run.id} data-status={run.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={state.tone}>{state.label}</Badge>
                  <span className="text-sm font-medium text-fg">{names.get(run.targetId) ?? "Website"}, {monthLabel(run.month)}</span>
                </div>
                <p className="mt-1 text-sm text-fg-2" data-testid="browser-run-counts">
                  {plural(run.steps, "step", "steps")}, {plural(run.artifactCount, "file", "files")}, {dollars(run.costMicros)}. Requested {when(run.requestedAt, zone)}.
                </p>
                {stopped ? <p className="text-sm text-muted" data-testid="browser-run-stop">{stopped}</p> : null}
                <Button
                  variant="ghost"
                  className="mt-1 -ml-3 px-3"
                  aria-expanded={isOpen}
                  aria-controls={`browser-run-${run.id}`}
                  onClick={() => setOpen(isOpen ? null : run.id)}
                >
                  {isOpen ? "Hide the steps" : "Show the steps and files"}
                </Button>
                {isOpen ? <BrowserRunDetail run={run} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BrowserRunDetail({ run }: { run: BrowserRun }) {
  const detail = useBrowserRun(run.id);
  return (
    <div id={`browser-run-${run.id}`} className={cn("mt-2 space-y-3 rounded-md bg-well p-3 text-sm")} data-testid="browser-run-detail">
      {detail.isPending ? <LoadingRows rows={2} label="Loading steps" /> : detail.isError ? (
        <ErrorNote error={detail.error} retry={() => detail.refetch()} />
      ) : (
        <>
          <ol className="space-y-1" aria-label="Steps">
            {detail.data.events.map((event) => (
              <li key={event.seq} data-testid="browser-step">
                <span className="font-medium text-fg">{event.seq}. {BROWSER_ACTION_WORDS[event.action]}</span>
                {event.path ? <span className="text-muted"> {event.origin ?? ""}{event.path}</span> : null}
              </li>
            ))}
          </ol>
          {detail.data.artifacts.length > 0 ? (
            <ul className="space-y-1" aria-label="Files">
              {detail.data.artifacts.map((file) => (
                <li key={file.id} className="flex items-center gap-2" data-testid="browser-file">
                  <FileText size={16} aria-hidden className="text-muted" />
                  <span className="break-all">{file.name}</span>
                  <span className="text-xs text-meta">{fileSize(file.bytes)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
