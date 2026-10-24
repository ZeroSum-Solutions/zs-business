"use client";

import { Bell, PencilSimple, Play, SealCheck, Sparkle, Star, Warning } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  deliveryChannelSchema,
  TEMPLATE_SUBJECT_MAX,
  TEMPLATE_TIMING_HOURS,
  TEMPLATE_VARIABLES,
  type AgentKindStatus,
  type ApproveTemplateRequest,
  type CreateTemplateRevisionRequest,
  type DeliveryChannel,
  type SuggestTemplateRequest,
  type TemplatedKind,
  type TemplateRevision,
  type TemplateState,
  type UpdateAgentKindSettingsRequest,
} from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle, TrayHeader, TrayTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { isApiError, isSettingsChanged } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import {
  CHANNEL_LABELS,
  currentRevisionOf,
  ENABLE_NEEDS_REVIEW_LINK,
  KIND_COPY,
  kindBlockedSentence,
  kindRunToast,
  kindState,
  NEEDS_APPROVAL_NOTE,
  readReviewLink,
  readTemplateForm,
  revisionState,
  TEMPLATE_CHANGED_MESSAGE,
  TEMPLATE_STALE_MESSAGE,
  timingSentence,
  toTemplateForm,
  UNAPPROVES_WARNING,
  VARIABLE_HELP,
  type TemplateField,
  type TemplateForm,
} from "@/lib/agents";
import { useIntentKey } from "@/lib/intent-key";
import { useAgentKindStatus, useDisplayZone, useKeys, useTemplate } from "@/lib/queries";
import { MANAGE_AGENTS, useCan, useSession } from "@/lib/session";
import { singleFlight } from "@/lib/single-flight";
import { formatDay, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// agents.md G-14, G-19, G-20 and approvals.md A-15: the kinds that send wording an owner approved.
// Owners write a revision, approve it, and turn the kind on; any new revision needs approval again.

/** Element IDs per kind. */
const PREFIX: Record<TemplatedKind, string> = { appointment_reminder: "reminder", review_request: "review" };
const ICONS = { appointment_reminder: Bell, review_request: Star } as const;
const KINDS: readonly TemplatedKind[] = ["appointment_reminder", "review_request"];
const FIELDS: readonly TemplateField[] = ["subject", "body", "timingHours"];

export const STALE_KIND_SETTINGS = "Someone else changed these settings first. The latest are shown. Try again.";

const when = (instant: string, zone: string) => `${formatDay(instant, zone)}, ${formatTime(instant, zone)}`;
const noticeClass = "flex items-start gap-2 rounded-md p-3 text-sm text-fg-2";

/** The tray of templated kinds below the follow-up agent. */
export function TemplatedKinds() {
  return (
    <section aria-labelledby="templated-title" className="tray mt-3 grid min-w-0 gap-1.5 lg:mt-4 lg:gap-2">
      <TrayHeader>
        <div className="min-w-0">
          <TrayTitle id="templated-title">Reminders and review requests</TrayTitle>
          <p className="text-sm text-muted">They send only wording an owner approved. Every send still checks the customer&apos;s consent and unsubscribes.</p>
        </div>
      </TrayHeader>
      <div className="grid min-w-0 grid-cols-1 items-start gap-1.5 lg:grid-cols-2 lg:gap-2">
        {KINDS.map((kind) => <KindCard key={kind} kind={kind} />)}
      </div>
    </section>
  );
}

function KindCard({ kind }: { kind: TemplatedKind }) {
  const p = PREFIX[kind];
  const copy = KIND_COPY[kind];
  const Icon = ICONS[kind];
  const canManage = useCan(MANAGE_AGENTS);
  const status = useAgentKindStatus(kind);
  // G-19: the wording is owners only; staff never read it.
  const template = useTemplate(kind, canManage);
  const current = canManage && template.data ? currentRevisionOf(template.data) : undefined;
  const state = status.data ? kindState(status.data, current) : null;
  return (
    <Card aria-labelledby={`${p}-title`} data-testid={`kind-${kind}`}>
      <CardHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon size={20} aria-hidden className="text-muted" />
            <CardTitle id={`${p}-title`}>{copy.title}</CardTitle>
            <span aria-live="polite">{state ? <Badge tone={state.tone} data-testid={`${p}-state`}>{state.label}</Badge> : null}</span>
          </div>
          <CardDescription className="mt-1">{copy.description}</CardDescription>
        </div>
      </CardHeader>
      <div className="space-y-4">
        {status.isPending ? <LoadingRows rows={1} label={`Loading ${copy.noun}`} /> : status.isError ? (
          <ErrorNote error={status.error} retry={() => status.refetch()} />
        ) : <KindControls kind={kind} status={status.data} current={current} />}
        <div className="border-t border-border-soft pt-4">
          {!canManage ? (
            <p className="text-sm text-muted" data-testid={`${p}-owner-only`}>Only an owner can see and change this wording.</p>
          ) : template.isPending ? <LoadingRows rows={2} label="Loading the wording" /> : template.isError ? (
            <ErrorNote error={template.error} retry={() => template.refetch()} />
          ) : <TemplateSection kind={kind} state={template.data} />}
        </div>
      </div>
    </Card>
  );
}

/** The on/off switch, the review link (G-20) and Run now. Owners change them; staff read them. */
function KindControls({ kind, status, current }: { kind: TemplatedKind; status: AgentKindStatus; current: TemplateRevision | null | undefined }) {
  const p = PREFIX[kind];
  const copy = KIND_COPY[kind];
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const canManage = useCan(MANAGE_AGENTS);
  const intents = useIntentKey();
  const runKeys = useIntentKey();
  const [saveOnce] = useState(singleFlight);
  const [runOnce] = useState(singleFlight);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const savedLink = typeof status.settings.config.reviewUrl === "string" ? status.settings.config.reviewUrl : "";
  const enabled = status.settings.enabled;
  const waitsForApproval = current === null || (current !== undefined && !current.approved);

  const intent = (input: UpdateAgentKindSettingsRequest) => ({ kind, ...input });
  const save = useMutation({
    mutationFn: (input: UpdateAgentKindSettingsRequest) => api.updateAgentKindSettings(kind, input, { idempotencyKey: intents.keyFor(intent(input)) }),
    onSettled: (_status, error, input) => intents.settle(intent(input), error),
    onSuccess: (next, input) => {
      queryClient.setQueryData(keys.agentKind(kind), next);
      setProblem(null);
      if (input.enabled !== enabled) {
        toast(input.enabled
          ? `${copy.title} turned on.${waitsForApproval ? " Nothing is sent until an owner approves the wording." : ""}`
          : `${copy.title} turned off. Nothing more is sent.`);
      } else {
        setLink(null);
        toast("Review link saved.");
      }
    },
    onError: async (error, input) => {
      if (isSettingsChanged(error)) {
        setProblem(STALE_KIND_SETTINGS);
        await queryClient.invalidateQueries({ queryKey: keys.agentKind(kind) });
      } else if (isApiError(error, "validation") && kind === "review_request" && input.enabled) {
        // G-20: the server refuses review requests without a link, with no detail to show.
        setProblem(ENABLE_NEEDS_REVIEW_LINK);
      } else {
        setProblem(null);
      }
    },
  });
  const run = useMutation({
    mutationFn: () => api.startKindRun(kind, { idempotencyKey: runKeys.keyFor({ kind, run: true }) }),
    onSettled: async (_run, error) => {
      runKeys.settle({ kind, run: true }, error);
      await queryClient.invalidateQueries({ queryKey: keys.agentKind(kind) });
    },
    onSuccess: (detail) => toast(kindRunToast(detail), detail.status === "stopped" ? "info" : "success"),
  });

  const settingsWith = (patch: Partial<UpdateAgentKindSettingsRequest>): UpdateAgentKindSettingsRequest => ({
    enabled, quietStartMinute: status.settings.quietStartMinute, quietEndMinute: status.settings.quietEndMinute,
    timeZone: status.settings.timeZone, maxCostMicrosPerDay: status.settings.maxCostMicrosPerDay, config: status.settings.config,
    expectedRevision: status.revision, ...patch,
  });
  const toggle = (next: boolean) => {
    setProblem(null);
    saveOnce(() => save.mutateAsync(settingsWith({ enabled: next })));
  };
  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    const read = readReviewLink(link ?? savedLink);
    if (!read.ok) {
      setLinkError(read.message);
      document.getElementById("review-link")?.focus();
      return;
    }
    setLinkError(null);
    setProblem(null);
    const { reviewUrl: _old, ...rest } = status.settings.config;
    saveOnce(() => save.mutateAsync(settingsWith({ config: read.reviewUrl ? { ...rest, reviewUrl: read.reviewUrl } : rest })));
  };

  const blocked = enabled ? kindBlockedSentence(status) : null;
  const help = enabled
    ? (waitsForApproval ? "Nothing is sent until an owner approves the wording." : "It sends the approved wording on its own.")
    : "When off, nothing is sent.";
  return (
    <div className="space-y-4 text-sm text-fg-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={`${p}-enabled`} className="mb-0">{copy.sendLabel}</Label>
          <p id={`${p}-enabled-help`} className="text-xs text-meta">{help}</p>
        </div>
        <Switch
          id={`${p}-enabled`}
          checked={enabled}
          onCheckedChange={toggle}
          disabled={!canManage || save.isPending}
          aria-busy={save.isPending}
          aria-describedby={canManage ? `${p}-enabled-help` : `${p}-enabled-help ${p}-switch-reason`}
        />
      </div>
      {canManage ? null : <DisabledReason id={`${p}-switch-reason`}>Only an owner can turn this on or off.</DisabledReason>}
      {blocked ? <p data-testid={`${p}-blocked`}><span className="font-medium text-fg">Why it can&apos;t send right now:</span> {blocked}</p> : null}
      {problem ? (
        <p role="alert" data-testid={`${p}-settings-problem`} className={cn(noticeClass, "bg-warn-tint")}>
          <Warning size={20} aria-hidden className="mt-px shrink-0 text-warn" />{problem}
        </p>
      ) : save.isError ? <ErrorNote error={save.error} /> : null}

      {kind === "review_request" && canManage ? (
        <form className="space-y-2" onSubmit={submitLink} noValidate>
          <div>
            <Label htmlFor="review-link">Review link</Label>
            <Input
              id="review-link"
              type="url"
              inputMode="url"
              autoComplete="url"
              maxLength={500}
              placeholder="https://"
              value={link ?? savedLink}
              onChange={(event) => setLink(event.target.value)}
              aria-invalid={linkError ? true : undefined}
              aria-describedby="review-link-hint"
            />
            <p id="review-link-hint" className={cn("mt-1 text-xs", linkError ? "text-danger" : "text-meta")}>
              {linkError ?? "Where customers leave a review, starting https://. It fills in {review_link}."}
            </p>
          </div>
          <Button type="submit" variant="secondary" disabled={save.isPending}>Save review link</Button>
        </form>
      ) : null}

      {canManage ? (
        <div className="space-y-2">
          <Button
            variant="secondary"
            onClick={() => runOnce(() => run.mutateAsync())}
            disabled={!status.canRun || run.isPending}
            aria-busy={run.isPending}
            aria-describedby={status.canRun ? `${p}-run-help` : `${p}-run-reason`}
          >
            <Play aria-hidden />Run now<span className="sr-only">: {copy.noun}</span>
          </Button>
          {status.canRun ? (
            <p id={`${p}-run-help`} className="text-xs text-meta">Looks once, now, for appointments that are due a message.</p>
          ) : (
            <DisabledReason id={`${p}-run-reason`}>Run now works when it is on and can send.</DisabledReason>
          )}
          {run.isError ? <ErrorNote error={run.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The current wording with its approval, and the form for new wording. Owners only. */
function TemplateSection({ kind, state }: { kind: TemplatedKind; state: TemplateState }) {
  const p = PREFIX[kind];
  const current = currentRevisionOf(state);
  const [writing, setWriting] = useState(false);
  // G-19: a server without a suggestion model answers 404; then the button goes.
  const [suggestions, setSuggestions] = useState(true);
  const open = writing || current === null;
  const saved = () => {
    setWriting(false);
    // The form closes; focus moves to the wording just saved.
    requestAnimationFrame(() => document.getElementById(`${p}-current-title`)?.focus());
  };
  return (
    <div className="space-y-4">
      {current ? <CurrentWording kind={kind} revision={current} /> : (
        <p data-testid={`${p}-none`} className="text-sm text-fg-2">No wording yet. Write the message it sends below.</p>
      )}
      {open ? (
        <WordingForm
          kind={kind}
          state={state}
          current={current}
          suggestions={suggestions}
          onNoSuggestions={() => setSuggestions(false)}
          onCancel={current ? () => setWriting(false) : undefined}
          onSaved={saved}
        />
      ) : (
        <div className="space-y-2">
          <Button variant="secondary" aria-expanded={false} aria-describedby={`${p}-write-note`} onClick={() => setWriting(true)}>
            <PencilSimple aria-hidden />Write new wording
          </Button>
          <p id={`${p}-write-note`} className="text-xs text-meta" data-testid={`${p}-write-note`}>
            {current?.approved ? UNAPPROVES_WARNING : NEEDS_APPROVAL_NOTE}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-meta">{term}</dt>
      <dd className="text-fg">{children}</dd>
    </div>
  );
}

/** A-15: the current revision as the owner approves it, by its digest. */
function CurrentWording({ kind, revision }: { kind: TemplatedKind; revision: TemplateRevision }) {
  const p = PREFIX[kind];
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const zone = useDisplayZone();
  const { session } = useSession();
  const userId = session.status === "signed_in" ? session.userId : null;
  const intents = useIntentKey();
  const [approveOnce] = useState(singleFlight);
  const [changed, setChanged] = useState(false);
  const state = revisionState(revision);

  const approve = useMutation({
    mutationFn: (input: ApproveTemplateRequest) => api.approveTemplate(kind, input, { idempotencyKey: intents.keyFor({ kind, ...input }) }),
    onSettled: async (_answer, error, input) => {
      intents.settle({ kind, ...input }, error);
      await queryClient.invalidateQueries({ queryKey: keys.template(kind) });
    },
    onSuccess: () => toast("Wording approved. It may be sent for the next 30 days."),
    // The wording changed or was replaced since this page read it: show the latest instead.
    onError: (error) => setChanged(isApiError(error, "conflict") || isApiError(error, "not_found")),
  });
  const sends = revision.standing?.sends ?? 0;

  return (
    <div className="space-y-3" data-testid={`${p}-current`} data-revision={revision.revision}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${p}-current-title`} tabIndex={-1} className="text-base font-bold text-fg outline-none">Current wording</h3>
        <span aria-live="polite"><Badge tone={state.tone} data-testid={`${p}-approval`}>{state.label}</Badge></span>
      </div>
      <p className="text-xs text-meta">
        Revision {revision.revision}, saved {when(revision.createdAt, zone)}{revision.createdBy === userId ? " by you" : ""}.
      </p>
      <dl className="grid grid-cols-1 gap-3 text-sm">
        <Row term="Sent as">{CHANNEL_LABELS[revision.channel]}, {timingSentence(kind, revision.timingHours)}</Row>
        {revision.subject !== null ? <Row term="Subject"><span className="break-words">{revision.subject}</span></Row> : null}
        <Row term="Message">
          <span className="mt-1 block rounded-md bg-inset p-3 break-words whitespace-pre-wrap" data-testid={`${p}-body`}>{revision.body}</span>
        </Row>
      </dl>
      {revision.approved && revision.standing ? (
        <p data-testid={`${p}-approved-note`} className={cn(noticeClass, "bg-success-tint")}>
          <SealCheck size={20} aria-hidden className="mt-px shrink-0 text-success" />
          <span>
            Approved until {formatDay(revision.standing.expiresAt, zone)}. Used for {sends} {sends === 1 ? "message" : "messages"} so far.
            Every send still checks the customer&apos;s consent and unsubscribes.
          </span>
        </p>
      ) : (
        <div className="space-y-2">
          <Button
            onClick={() => {
              setChanged(false);
              approveOnce(() => approve.mutateAsync({ revision: revision.revision, contentDigest: revision.contentDigest }));
            }}
            disabled={approve.isPending}
            aria-busy={approve.isPending}
            aria-describedby={`${p}-approve-help`}
          >
            <SealCheck aria-hidden />Approve this wording
          </Button>
          <p id={`${p}-approve-help`} className="text-xs text-meta">
            Lets it send exactly this wording for 30 days. Any change to the wording needs approval again.
          </p>
        </div>
      )}
      {changed ? (
        <p role="alert" data-testid={`${p}-changed`} className={cn(noticeClass, "bg-warn-tint")}>
          <Warning size={20} aria-hidden className="mt-px shrink-0 text-warn" />{TEMPLATE_CHANGED_MESSAGE}
        </p>
      ) : approve.isError ? <ErrorNote error={approve.error} /> : null}
    </div>
  );
}

interface WordingFormProps {
  kind: TemplatedKind;
  state: TemplateState;
  current: TemplateRevision | null;
  suggestions: boolean;
  onNoSuggestions: () => void;
  onCancel: (() => void) | undefined;
  onSaved: () => void;
}

/**
 * A new revision. Placeholders are checked against the kind's variables before anything is
 * sent; the server checks again. The save names the revision it started from, so one made after
 * someone else's is refused (409 `stale_revision`) and the text stays for another try.
 */
function WordingForm({ kind, state, current, suggestions, onNoSuggestions, onCancel, onSaved }: WordingFormProps) {
  const p = PREFIX[kind];
  const copy = KIND_COPY[kind];
  const range = TEMPLATE_TIMING_HOURS[kind];
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const suggestKeys = useIntentKey();
  const [saveOnce] = useState(singleFlight);
  const [suggestOnce] = useState(singleFlight);
  const [form, setForm] = useState<TemplateForm>(() => toTemplateForm(kind, current));
  const [errors, setErrors] = useState<Partial<Record<TemplateField, string>>>({});
  const [stale, setStale] = useState(false);
  const edit = (patch: Partial<TemplateForm>) => setForm((before) => ({ ...before, ...patch }));
  const fieldId = (field: TemplateField) => `${p}-${field === "timingHours" ? "timing" : field}`;

  const save = useMutation({
    mutationFn: (input: CreateTemplateRevisionRequest) => api.createTemplateRevision(kind, input, { idempotencyKey: intents.keyFor({ kind, ...input }) }),
    onSettled: (_state, error, input) => intents.settle({ kind, ...input }, error),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.template(kind), next);
      setStale(false);
      toast(`New wording saved as revision ${next.currentRevision}. Nothing is sent until an owner approves it.`);
      onSaved();
    },
    onError: async (error) => {
      if (!isSettingsChanged(error)) return;
      setStale(true);
      await queryClient.invalidateQueries({ queryKey: keys.template(kind) });
    },
  });
  const suggest = useMutation({
    mutationFn: (input: SuggestTemplateRequest) => api.suggestTemplate(kind, input, { idempotencyKey: suggestKeys.keyFor({ kind, ...input }) }),
    onSettled: (_suggestion, error, input) => suggestKeys.settle({ kind, ...input }, error),
    onSuccess: (suggestion) => {
      edit({ channel: suggestion.channel, subject: suggestion.subject ?? "", body: suggestion.body });
      setErrors({});
      toast("Suggested wording filled in. Read it, change what you like, then save it.");
    },
    onError: (error) => {
      if (isApiError(error, "not_found")) onNoSuggestions();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = readTemplateForm(kind, form, state.currentRevision);
    if (!read.ok) {
      setErrors(read.errors);
      const first = FIELDS.find((field) => read.errors[field]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    setErrors({});
    setStale(false);
    saveOnce(() => save.mutateAsync(read.request));
  };

  const fieldProps = (field: TemplateField) => ({
    id: fieldId(field),
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": `${fieldId(field)}-hint`,
  });
  const hint = (field: TemplateField, text: string) => (
    <p id={`${fieldId(field)}-hint`} className={cn("mt-1 text-xs", errors[field] ? "text-danger" : "text-meta")}>{errors[field] ?? text}</p>
  );

  return (
    <form id={`${p}-form`} className="space-y-4" onSubmit={submit} noValidate aria-labelledby={`${p}-form-title`}>
      <h3 id={`${p}-form-title`} className="text-base font-bold text-fg">{current ? "Write new wording" : "Write the wording"}</h3>
      {stale ? (
        <p role="alert" data-testid={`${p}-stale`} className={cn(noticeClass, "bg-warn-tint")}>
          <Warning size={20} aria-hidden className="mt-px shrink-0 text-warn" />{TEMPLATE_STALE_MESSAGE}
        </p>
      ) : null}
      {current?.approved ? (
        <p data-testid={`${p}-unapproves`} className={cn(noticeClass, "bg-warn-tint")}>
          <Warning size={20} aria-hidden className="mt-px shrink-0 text-warn" />{UNAPPROVES_WARNING}
        </p>
      ) : null}
      <div>
        <Label htmlFor={`${p}-channel`}>Send as</Label>
        <Select id={`${p}-channel`} className="w-full" value={form.channel} onChange={(event) => edit({ channel: event.target.value as DeliveryChannel })}>
          {deliveryChannelSchema.options.map((channel) => <option key={channel} value={channel}>{CHANNEL_LABELS[channel]}</option>)}
        </Select>
      </div>
      {form.channel === "email" ? (
        <div>
          <Label htmlFor={fieldId("subject")}>Subject</Label>
          <Input {...fieldProps("subject")} maxLength={TEMPLATE_SUBJECT_MAX} value={form.subject} onChange={(event) => edit({ subject: event.target.value })} />
          {hint("subject", "One line. Variables work here too.")}
        </div>
      ) : null}
      <div>
        <Label htmlFor={fieldId("body")}>Message</Label>
        <Textarea {...fieldProps("body")} rows={6} value={form.body} onChange={(event) => edit({ body: event.target.value })} />
        {hint("body", form.channel === "sms"
          ? "Up to 1,530 characters once the variables are filled in. Use only the variables below."
          : "Plain text. Use only the variables below; each is filled in for every customer.")}
      </div>
      <div>
        <p className="text-sm font-semibold text-fg-2" id={`${p}-variables-title`}>Variables you can use</p>
        <ul className="mt-1 space-y-1 text-sm text-fg-2" aria-labelledby={`${p}-variables-title`} data-testid={`${p}-variables`}>
          {TEMPLATE_VARIABLES[kind].map((name) => (
            <li key={name}>
              <code className="rounded-sm bg-inset px-1.5 py-0.5 font-mono text-xs text-fg">{`{${name}}`}</code> {VARIABLE_HELP[name]}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <Label htmlFor={fieldId("timingHours")}>{copy.timingLabel}</Label>
        <Input
          {...fieldProps("timingHours")}
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          step={1}
          value={form.timingHours}
          onChange={(event) => edit({ timingHours: event.target.value })}
        />
        {hint("timingHours", `A whole number of hours from ${range.min} to ${range.max}.`)}
      </div>
      {current?.approved ? null : <p className="text-xs text-meta">{NEEDS_APPROVAL_NOTE}</p>}
      {Object.keys(errors).length > 0 ? <p role="alert" className="text-sm text-danger">Some of the wording needs another look.</p> : null}
      {save.isError && !stale ? <ErrorNote error={save.error} /> : null}
      {suggest.isError && !isApiError(suggest.error, "not_found") ? <ErrorNote error={suggest.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>Save new wording</Button>
        {suggestions ? (
          <Button
            variant="secondary"
            onClick={() => suggestOnce(() => suggest.mutateAsync({ channel: form.channel }))}
            disabled={suggest.isPending}
            aria-busy={suggest.isPending}
          >
            <Sparkle aria-hidden />Suggest wording
          </Button>
        ) : null}
        {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
