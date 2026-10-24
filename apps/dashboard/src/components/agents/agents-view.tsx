"use client";

import { CheckCircle, MinusCircle, Play, Prohibit, Robot, ShieldCheck } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { FollowUpRunDetail, FollowUpStatus, KillFollowUpRequest, UpdateFollowUpSettingsRequest } from "@zs/contracts";
import { BrowserTasksCard } from "@/components/agents/browser-tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { isApiError, isSettingsChanged, type FollowUpRun } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import {
  agentState,
  blockedSentence,
  costLine,
  FIELD_HINTS,
  quietHoursLabel,
  readSettingsForm,
  RUN_STATUS,
  SKIP_REASONS,
  STOP_REASONS,
  timeZoneChoices,
  toSettingsForm,
  zoneName,
  type SettingsField,
  type SettingsForm,
} from "@/lib/agents";
import { IntakeCard } from "@/components/agents/intake-review";
import { useIntentKey } from "@/lib/intent-key";
import { useContactNames, useDisplayZone, useFollowUpRun, useFollowUpRuns, useFollowUpStatus, useKeys } from "@/lib/queries";
import { MANAGE_AGENTS, useCan, useSession } from "@/lib/session";
import { singleFlight } from "@/lib/single-flight";
import { formatDay, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const linkClass = "inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline";
const when = (instant: string, zone: string) => `${formatDay(instant, zone)}, ${formatTime(instant, zone)}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** A stop note longer than this shows three lines until the reader asks for the rest. */
const LONG_NOTE = 140;

export const STOPPED_MESSAGE = "Agent stopped. It drafts nothing until an owner resumes it.";
export const STALE_SETTINGS_MESSAGE = "Someone else saved these settings while you were editing. The latest settings are loaded below. Check them and save again.";

function useSignedInUserId(): string | null {
  const { session } = useSession();
  return session.status === "signed_in" ? session.userId : null;
}

export function AgentsView() {
  return (
    <>
      <PageHeader title="Agents" description="Helpers that work for you. Nothing they write reaches a customer until an owner approves it." />
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-4">
        <div className="tray grid min-w-0 gap-1.5 lg:gap-2">
          <FollowUpCard />
          <RunsCard />
          <BrowserTasksCard />
          <IntakeCard />
        </div>
        <div className="tray min-w-0">
          <SettingsCard />
        </div>
      </div>
    </>
  );
}

/** The agent's state in words, the stop and resume switches, and Run now (agents.md G-3, G-11). */
function FollowUpCard() {
  const status = useFollowUpStatus();
  // agents.md G-11: without a model on the server `POST /runs` is a 404; only Run now finds out.
  const [runnable, setRunnable] = useState(true);
  const state = status.data ? agentState(status.data, { runnable }) : null;
  return (
    <Card aria-labelledby="followup-title" data-testid="followup-card">
      <CardHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Robot size={20} aria-hidden className="text-muted" />
            <CardTitle id="followup-title">Inquiry follow-up</CardTitle>
            <span aria-live="polite">
              {state ? <Badge tone={state.tone} data-testid="followup-state">{state.label}</Badge> : null}
            </span>
          </div>
          <CardDescription className="mt-1">
            {status.data
              ? `Looks for website booking requests nobody has answered after ${plural(status.data.settings.waitHours, "hour", "hours")} and drafts a follow-up email.`
              : "Looks for website booking requests nobody has answered and drafts a follow-up email."}
          </CardDescription>
        </div>
      </CardHeader>
      {status.isPending ? <LoadingRows rows={2} label="Loading the agent" /> : status.isError ? (
        <ErrorNote error={status.error} retry={() => status.refetch()} />
      ) : <FollowUpControls status={status.data} runnable={runnable} onUnrunnable={() => setRunnable(false)} />}
    </Card>
  );
}

function FollowUpControls({ status, runnable, onUnrunnable }: { status: FollowUpStatus; runnable: boolean; onUnrunnable: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const zone = useDisplayZone();
  const userId = useSignedInUserId();
  const canManage = useCan(MANAGE_AGENTS);
  const stopKeys = useIntentKey();
  const resumeKeys = useIntentKey();
  const runKeys = useIntentKey();
  const [note, setNote] = useState("");
  const [wholeNote, setWholeNote] = useState(false);
  // One write of each kind at a time: a double tap must not send twice or toast twice.
  const [stopOnce] = useState(singleFlight);
  const [resumeOnce] = useState(singleFlight);
  const [runOnce] = useState(singleFlight);
  // Stop and Resume replace each other, and Run now turns off: focus moves to what changed.
  const stateLine = useRef<HTMLParagraphElement>(null);
  const focusState = () => stateLine.current?.focus();

  const showStatus = (next: FollowUpStatus) => queryClient.setQueryData(keys.followUp, next);
  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: keys.followUp });

  const stop = useMutation({
    mutationFn: (input: KillFollowUpRequest) => api.killFollowUp(input, { idempotencyKey: stopKeys.keyFor(input) }),
    onSettled: async (_status, error, input) => {
      stopKeys.settle(input, error);
      await refreshStatus();
    },
    onSuccess: (next) => {
      showStatus(next);
      setNote("");
      toast(STOPPED_MESSAGE, "info");
      focusState();
    },
  });
  const resume = useMutation({
    mutationFn: () => api.resumeFollowUp({ idempotencyKey: resumeKeys.keyFor("resume") }),
    onSettled: async (_status, error) => {
      resumeKeys.settle("resume", error);
      await refreshStatus();
    },
    onSuccess: (next) => {
      showStatus(next);
      toast(next.canDraft ? "Agent resumed." : "Agent resumed. It still cannot draft right now; see why above.");
      focusState();
    },
  });
  const run = useMutation({
    mutationFn: () => api.startFollowUpRun({ idempotencyKey: runKeys.keyFor("run") }),
    onSettled: async (_run, error) => {
      runKeys.settle("run", error);
      await Promise.all([
        refreshStatus(),
        queryClient.invalidateQueries({ queryKey: keys.followUpRuns }),
        queryClient.invalidateQueries({ queryKey: keys.inboxAll }),
      ]);
    },
    onSuccess: (detail) => toast(runToast(detail), detail.status === "stopped" ? "info" : "success"),
    // agents.md G-11: without a model on the server the route does not exist.
    onError: (error) => {
      if (!isApiError(error, "not_found")) return;
      onUnrunnable();
      focusState();
    },
  });

  const submitStop = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    stopOnce(() => stop.mutateAsync(trimmed ? { note: trimmed } : {}));
  };

  const blocked = blockedSentence(status, { runnable });
  const cost = costLine(status);
  const busy = stop.isPending || resume.isPending;
  const failure = [stop, resume].find((step) => step.isError)?.error ?? (run.isError && runnable ? run.error : null);
  // Stop stays open while it is off: a stop latches, so turning it on later still needs a Resume (G-3).
  // A run while it cannot draft only reports why it stopped (the reason is shown above).
  const runBlocked = !runnable || !status.canDraft;
  const killedNote = status.killed?.note ?? null;
  const clampNote = killedNote !== null && killedNote.length > LONG_NOTE && !wholeNote;

  return (
    <div className="space-y-4 text-sm text-fg-2">
      {status.killed ? (
        <div>
          <p data-testid="followup-killed">
            Stopped by {status.killed.by === userId ? "you" : "a team member"} on {when(status.killed.at, zone)}.
            {killedNote ? <> Note: <q id="stop-note-text" className={cn("break-words", clampNote && "line-clamp-3")}>{killedNote}</q></> : null}
          </p>
          {killedNote && killedNote.length > LONG_NOTE ? (
            <Button variant="ghost" className="-ml-3 px-3" aria-expanded={wholeNote} aria-controls="stop-note-text" onClick={() => setWholeNote(!wholeNote)}>
              {wholeNote ? "Show less of the note" : "Show the whole note"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p ref={stateLine} tabIndex={-1} className="outline-none" data-testid="followup-blocked">
        {blocked ? <><span className="font-medium text-fg">Why it can&apos;t draft right now:</span> {blocked}</> : "It can draft now."}
      </p>
      <p
        data-testid="followup-cost"
        className={cn("text-xs", cost.warning ? "rounded-md bg-warn-tint p-3 text-sm text-fg-2" : "text-meta")}
      >
        {cost.text}
      </p>

      <div className="flex items-start gap-3 rounded-md bg-accent-tint p-3" data-testid="approval-note">
        <ShieldCheck size={20} aria-hidden className="mt-px shrink-0 text-accent" />
        <div>
          <p>Agent drafts wait in the Inbox for an owner&apos;s approval. Nothing is sent to a customer without it.</p>
          <Link href="/inbox" className={linkClass}>Open the Inbox</Link>
        </div>
      </div>

      {status.killed ? (
        <div className="space-y-2">
          <Button
            // Staff cannot resume: a filled primary button reads as live even when disabled.
            variant={canManage ? "primary" : "secondary"}
            onClick={() => resumeOnce(() => resume.mutateAsync())}
            disabled={!canManage || busy}
            aria-busy={resume.isPending}
            aria-describedby={canManage ? undefined : "resume-reason"}
          >
            <Play aria-hidden />Resume
          </Button>
          {canManage ? null : <DisabledReason id="resume-reason">Only an owner can resume the agent.</DisabledReason>}
        </div>
      ) : (
        <form className="space-y-2" onSubmit={submitStop} noValidate>
          <div>
            <Label htmlFor="stop-note">Note for the team (optional)</Label>
            <Input id="stop-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why you stopped it" />
          </div>
          <Button
            type="submit"
            variant="danger-outline"
            disabled={busy}
            aria-busy={stop.isPending}
            aria-describedby="stop-help"
          >
            <Prohibit aria-hidden />Stop the agent
          </Button>
          <p id="stop-help" className="text-xs text-meta">Stops new drafts at once. Drafts already in the Inbox stay there until someone approves or discards them.</p>
        </form>
      )}

      {canManage ? (
        <div className="space-y-2 border-t border-border-soft pt-4">
          <Button
            variant="secondary"
            onClick={() => runOnce(() => run.mutateAsync())}
            disabled={runBlocked || run.isPending}
            aria-busy={run.isPending}
            aria-describedby={runBlocked ? "run-reason" : "run-help"}
          >
            Run now
          </Button>
          {runBlocked ? (
            <DisabledReason id="run-reason">Run now works when the agent can draft. See why above.</DisabledReason>
          ) : (
            <p id="run-help" className="text-xs text-meta">Looks for unanswered requests once, now. Its drafts wait in the Inbox for approval.</p>
          )}
        </div>
      ) : null}

      {failure ? <ErrorNote error={failure} /> : null}
    </div>
  );
}

function runToast(run: FollowUpRunDetail): string {
  if (run.status === "stopped" && run.stopReason) {
    return run.considered === 0
      ? `The agent did not draft: ${STOP_REASONS[run.stopReason]}.`
      : `Stopped because ${STOP_REASONS[run.stopReason]}. ${runCounts(run)}`;
  }
  return run.considered === 0 ? "Run finished. No unanswered requests to follow up." : `Run finished. ${runCounts(run)}`;
}

/** "Drafted 1 follow-up, skipped 2." */
export function runCounts(run: Pick<FollowUpRun, "drafted" | "skipped" | "considered">): string {
  if (run.considered === 0) return "Nothing to follow up.";
  return `Drafted ${plural(run.drafted, "follow-up", "follow-ups")}, skipped ${run.skipped}.`;
}

/** Owners edit the settings; staff read them (G-2: `agents` is owners only). */
function SettingsCard() {
  const status = useFollowUpStatus();
  const canManage = useCan(MANAGE_AGENTS);
  const zone = useDisplayZone();
  return (
    <Card aria-labelledby="settings-title">
      <CardHeader>
        <div>
          <CardTitle id="settings-title">Follow-up settings</CardTitle>
          {status.data ? (
            <CardDescription data-testid="settings-saved">
              {status.data.updatedAt ? `Last saved ${when(status.data.updatedAt, zone)}.` : "Not saved yet. These are the defaults."}
            </CardDescription>
          ) : null}
        </div>
      </CardHeader>
      {status.isPending ? <LoadingRows rows={4} label="Loading settings" /> : status.isError ? (
        <ErrorNote error={status.error} retry={() => status.refetch()} />
      ) : canManage ? (
        <SettingsFormBody status={status.data} reload={async () => { await status.refetch(); }} />
      ) : (
        <SettingsSummary status={status.data} />
      )}
    </Card>
  );
}

function SettingsSummary({ status }: { status: FollowUpStatus }) {
  const { settings } = status;
  const rows: [string, string][] = [
    ["Drafting", settings.enabled ? "On" : "Off"],
    ["Drafts per day, at most", String(settings.maxDraftsPerDay)],
    ["Per customer", `${plural(settings.maxDraftsPerContact, "draft", "drafts")} in ${plural(settings.contactWindowHours, "hour", "hours")}`],
    ["Wait before following up", plural(settings.waitHours, "hour", "hours")],
    ["Look back", plural(settings.lookbackDays, "day", "days")],
    ["Quiet hours", quietHoursLabel(settings)],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs text-meta">{term}</dt>
            <dd className="text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted" data-testid="settings-owner-only">Only an owner can change these settings.</p>
    </div>
  );
}

type NumberField = { field: SettingsField; id: string; label: string; min: number; max: number };
const NUMBER_FIELDS: NumberField[] = [
  { field: "maxDraftsPerDay", id: "agent-per-day", label: "Drafts per day, at most", min: 1, max: 200 },
  { field: "waitHours", id: "agent-wait", label: "Wait before following up (hours)", min: 1, max: 720 },
  { field: "lookbackDays", id: "agent-lookback", label: "Look back (days)", min: 1, max: 90 },
];
/** The per-customer limit and its window read as one rule, so they share a fieldset. */
const PER_CUSTOMER_FIELDS: NumberField[] = [
  { field: "maxDraftsPerContact", id: "agent-per-customer", label: "Drafts at most", min: 1, max: 10 },
  { field: "contactWindowHours", id: "agent-window", label: "Within this many hours", min: 1, max: 2160 },
];
/**
 * Chromium makes a time input's clock button a tab stop of its own that never shows a focus
 * ring. People type the time (phones open their own picker), so the button is hidden.
 */
const TIME_INPUT = "[&::-webkit-calendar-picker-indicator]:hidden";
const FIELD_IDS: Record<SettingsField, string> = {
  ...Object.fromEntries([...NUMBER_FIELDS, ...PER_CUSTOMER_FIELDS].map((item) => [item.field, item.id])) as Record<SettingsField, string>,
  quietStart: "agent-quiet-start",
  quietEnd: "agent-quiet-end",
  timeZone: "agent-zone",
};

/**
 * The settings form. Edits keep the revision they started from, so a save made after someone
 * else's is refused (409 `stale_revision`) and the form reloads the latest settings.
 */
function SettingsFormBody({ status, reload }: { status: FollowUpStatus; reload: () => Promise<void> }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const [draft, setDraft] = useState<{ revision: number; form: SettingsForm } | null>(null);
  const [invalid, setInvalid] = useState<SettingsField[]>([]);
  const [stale, setStale] = useState(false);
  const [saveOnce] = useState(singleFlight);
  const form = draft?.form ?? toSettingsForm(status.settings);
  const revision = draft?.revision ?? status.revision;
  const zones = useMemo(() => timeZoneChoices(form.timeZone), [form.timeZone]);

  const edit = (patch: Partial<SettingsForm>) => setDraft({ revision, form: { ...form, ...patch } });

  const save = useMutation({
    mutationFn: (input: UpdateFollowUpSettingsRequest) => api.updateFollowUpSettings(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: (_status, error, input) => intents.settle(input, error),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.followUp, next);
      setDraft(null);
      toast("Settings saved.");
    },
    onError: async (error) => {
      if (!isSettingsChanged(error)) return;
      setStale(true);
      await reload();
      setDraft(null);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = readSettingsForm(form);
    if (!read.ok) {
      setInvalid(read.fields);
      const first = read.fields[0];
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }
    setInvalid([]);
    setStale(false);
    saveOnce(() => save.mutateAsync({ ...read.settings, expectedRevision: revision }));
  };

  const hintId = (field: SettingsField) => (field === "quietStart" || field === "quietEnd" ? "agent-quiet-hint" : `${FIELD_IDS[field]}-hint`);
  const fieldProps = (field: SettingsField) => ({
    id: FIELD_IDS[field],
    "aria-invalid": invalid.includes(field) || undefined,
    "aria-describedby": hintId(field),
  });
  const hint = (field: SettingsField, text = FIELD_HINTS[field]) => (
    <p id={hintId(field)} className={cn("mt-1 text-xs", invalid.includes(field) ? "text-danger" : "text-meta")}>{text}</p>
  );
  const quietInvalid = invalid.includes("quietStart") || invalid.includes("quietEnd");
  const numberField = ({ field, label, min, max }: NumberField, inGroup = false) => (
    <div key={field}>
      <Label htmlFor={FIELD_IDS[field]} className={inGroup ? "font-normal" : undefined}>{label}</Label>
      <Input
        {...fieldProps(field)}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={form[field]}
        onChange={(event) => edit({ [field]: event.target.value })}
      />
      {hint(field)}
    </div>
  );

  return (
    <form className="space-y-4" onSubmit={submit} noValidate aria-labelledby="settings-title">
      {stale ? <p role="alert" data-testid="settings-stale" className="rounded-md bg-warn-tint p-3 text-sm text-fg-2">{STALE_SETTINGS_MESSAGE}</p> : null}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="agent-enabled" className="mb-0">Draft follow-ups</Label>
          <p id="agent-enabled-help" className="text-xs text-meta">When off, the agent drafts nothing.</p>
        </div>
        <Switch id="agent-enabled" checked={form.enabled} onCheckedChange={(enabled) => edit({ enabled })} aria-describedby="agent-enabled-help" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
        {NUMBER_FIELDS.map((item) => numberField(item))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg-2">Per customer</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PER_CUSTOMER_FIELDS.map((item) => numberField(item, true))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg-2">Quiet hours</legend>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={FIELD_IDS.quietStart} className="font-normal">From</Label>
            <Input {...fieldProps("quietStart")} type="time" className={TIME_INPUT} value={form.quietStart} onChange={(event) => edit({ quietStart: event.target.value })} />
          </div>
          <div>
            <Label htmlFor={FIELD_IDS.quietEnd} className="font-normal">Until</Label>
            <Input {...fieldProps("quietEnd")} type="time" className={TIME_INPUT} value={form.quietEnd} onChange={(event) => edit({ quietEnd: event.target.value })} />
          </div>
        </div>
        <p id="agent-quiet-hint" className={cn("text-xs", quietInvalid ? "text-danger" : "text-meta")}>
          {quietInvalid ? "Enter both times. " : null}No drafts in this window, in the time zone below. The same start and end means no quiet hours.
        </p>
      </fieldset>
      <div>
        <Label htmlFor={FIELD_IDS.timeZone}>Time zone</Label>
        <Select {...fieldProps("timeZone")} className="w-full" value={form.timeZone} onChange={(event) => edit({ timeZone: event.target.value })}>
          {zones.map((zone) => <option key={zone} value={zone}>{zoneName(zone)}</option>)}
        </Select>
        {hint("timeZone", "Quiet hours follow this zone.")}
      </div>
      {invalid.length > 0 ? <p role="alert" className="text-sm text-danger">Some settings need another look.</p> : null}
      {save.isError && !isSettingsChanged(save.error) ? <ErrorNote error={save.error} /> : null}
      <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>Save settings</Button>
    </form>
  );
}

/** The agent's runs, newest first, each with what it decided for every request it looked at. */
function RunsCard() {
  const runs = useFollowUpRuns();
  const zone = useDisplayZone();
  const userId = useSignedInUserId();
  const [open, setOpen] = useState<string | null>(null);
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card aria-labelledby="runs-title">
      <CardHeader>
        <div>
          <CardTitle id="runs-title">Recent runs</CardTitle>
          <CardDescription>Each time the agent looked for requests to follow up.</CardDescription>
        </div>
      </CardHeader>
      {runs.isPending ? <LoadingRows rows={3} label="Loading runs" /> : runs.isError ? (
        <ErrorNote error={runs.error} retry={() => runs.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No runs yet">When the agent runs, what it drafted and skipped shows here.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border-soft" aria-label="Runs">
            {items.map((run) => {
              const state = RUN_STATUS[run.status];
              const started = when(run.startedAt, zone);
              const isOpen = open === run.id;
              return (
                <li key={run.id} className="py-3 first:pt-0 last:pb-0" data-run-id={run.id} data-status={run.status}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className="text-sm font-medium text-fg">Started {started}</span>
                  </div>
                  <p className="mt-1 text-sm text-fg-2" data-testid="run-counts">{runCounts(run)}</p>
                  {run.stopReason ? <p className="text-sm text-muted" data-testid="run-stop">Stopped because {STOP_REASONS[run.stopReason]}.</p> : null}
                  <p className="text-xs text-meta">
                    {run.requestedBy === null ? "Scheduled run" : run.requestedBy === userId ? "You started it" : "An owner started it"}
                  </p>
                  <Button
                    variant="ghost"
                    // Text lines up with the run's words above, not with the button's padding.
                    className="mt-1 -ml-3 px-3"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? `run-${run.id}` : undefined}
                    onClick={() => setOpen(isOpen ? null : run.id)}
                  >
                    {isOpen ? "Hide details" : "Show details"}<span className="sr-only"> of the run started {started}</span>
                  </Button>
                  {isOpen ? <RunDetail id={run.id} /> : null}
                </li>
              );
            })}
          </ul>
          {runs.hasNextPage ? (
            <Button variant="secondary" className="mt-4" onClick={() => runs.fetchNextPage()} disabled={runs.isFetchingNextPage} aria-busy={runs.isFetchingNextPage}>
              Show more runs
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function RunDetail({ id }: { id: string }) {
  const run = useFollowUpRun(id);
  const contactIds = useMemo(() => run.data?.decisions.map((decision) => decision.contactId) ?? [], [run.data]);
  const names = useContactNames(contactIds);
  const nameOf = (contactId: string) => {
    const contact = names.data?.find((item) => item.id === contactId);
    return contact?.displayName ?? contact?.email ?? "a customer";
  };

  return (
    <div id={`run-${id}`} className="mt-1 rounded-md bg-inset p-3 text-sm text-fg-2" data-testid="run-detail">
      {run.isPending ? <LoadingRows rows={2} label="Loading the run" /> : run.isError ? (
        <ErrorNote error={run.error} retry={() => run.refetch()} />
      ) : run.data.decisions.length === 0 ? (
        <p>It looked at no requests in this run.</p>
      ) : (
        <ul className="space-y-2" aria-label="What it decided">
          {run.data.decisions.map((decision) => (
            <li key={decision.id} className="flex items-start gap-2" data-outcome={decision.outcome}>
              {decision.outcome === "drafted" ? (
                <>
                  <CheckCircle size={20} aria-hidden className="mt-3 shrink-0 text-success" />
                  <p>
                    Drafted a follow-up for{" "}
                    <Link href={`/inbox/c_${decision.contactId}`} className={linkClass}>{nameOf(decision.contactId)}</Link>.
                    {" "}It waits in the Inbox for an owner&apos;s approval.
                  </p>
                </>
              ) : (
                <>
                  <MinusCircle size={20} aria-hidden className="mt-px shrink-0 text-muted" />
                  <p>Skipped {nameOf(decision.contactId)}: {decision.reason ? SKIP_REASONS[decision.reason] : "no reason recorded"}.</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
