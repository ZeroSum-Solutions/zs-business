"use client";

import { ArrowLeft, ArrowRight, ArrowSquareOut, CalendarBlank, Globe, LinkSimple, Robot, UsersThree } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { AppliedSetup, IndustryTemplatePreview, SetupRead } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { KIND_COPY, timeZoneChoices, zoneName } from "@/lib/agents";
import { isApiError } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { browserZone, useCalendarConnections, useKeys, useSetup } from "@/lib/queries";
import { MANAGE_BUSINESS, useCan } from "@/lib/session";
import { calendarConnected, CONNECTION_LABELS, durationLabel, hoursLines, initialZone, messageTimingLine } from "@/lib/setup";
import { formatDay } from "@/lib/time";

export const SETUP_DESCRIPTION = "Pick the template closest to your business. It adds a pipeline, a calendar, a booking page and message wording. It changes nothing you already have.";
export const STAFF_SETUP_DESCRIPTION = "Your owner hasn't finished setup yet. These are the templates they can choose from.";
export const APPLIED_DESCRIPTION = "What your template set up, and what is left to do.";
export const SENDING_OFF = "Sending stays off until you approve the wording.";
export const OWNER_ONLY_TOGGLE = "Only an owner can take the booking page live or off line.";
export const ALREADY_SET_UP = "This business was already set up. Showing what is set up now.";
export const CALENDAR_CLASH_ADVICE = "Until it is connected, keep the booking page off line, or watch your calendar for clashes yourself.";

/** Agents page anchors for each kind's card (template-cards.tsx). */
const AGENT_ANCHORS = { appointment_reminder: "reminder-title", review_request: "review-title" } as const;

/** industry-templates.md IT-7: first-run setup, and what it set up once applied. */
export function SetupView() {
  const setup = useSetup();
  const owner = useCan(MANAGE_BUSINESS);
  if (setup.isPending) return <><PageHeader title="Setup" /><LoadingRows rows={4} label="Loading setup" /></>;
  if (setup.isError) return <><PageHeader title="Setup" /><ErrorNote error={setup.error} retry={() => void setup.refetch()} /></>;
  if (setup.data.applied) return <AppliedView setup={setup.data} applied={setup.data.applied} owner={owner} />;
  return <Chooser setup={setup.data} owner={owner} />;
}

function Chooser({ setup, owner }: { setup: SetupRead; owner: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const template = owner ? setup.templates.find((item) => item.id === selected) : undefined;
  if (template) return <ApplyTemplate template={template} profileZone={setup.timeZone} onBack={() => setSelected(null)} />;
  return (
    <>
      <PageHeader title="Setup" description={owner ? SETUP_DESCRIPTION : STAFF_SETUP_DESCRIPTION} />
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4" aria-label="Templates">
        {setup.templates.map((item) => (
          <li key={item.id} className="min-w-0">
            <TemplateCard template={item} onChoose={owner ? () => setSelected(item.id) : null} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <dt className="text-xs font-semibold text-meta">{label}</dt>
      <dd className="text-sm text-fg-2">{children}</dd>
    </div>
  );
}

const connectionsLine = (template: IndustryTemplatePreview) =>
  template.recommendedConnections.map((id) => CONNECTION_LABELS[id]).join(", ") || "None";

/** IT-7: label, summary, stages, appointment type and hours, booking page title, recommended connections. */
export function TemplateCard({ template, onChoose }: { template: IndustryTemplatePreview; onChoose: (() => void) | null }) {
  const titleId = `template-${template.id}-title`;
  return (
    <Card aria-labelledby={titleId} data-testid={`template-${template.id}`} className="flex h-full flex-col">
      <CardHeader className="mb-2">
        <CardTitle id={titleId}>{template.label}</CardTitle>
      </CardHeader>
      <CardDescription>{template.summary}</CardDescription>
      <dl className="mt-4 flex-1 divide-y divide-border-soft">
        <Fact label="Pipeline stages">{template.pipeline.stages.map((stage) => stage.name).join(", ")}</Fact>
        <Fact label="Appointments">
          {template.resource.name}, {durationLabel(template.resource.slotLengthMinutes)}
          {hoursLines(template.resource.weekly).map((line) => <span key={line} className="block">{line}</span>)}
        </Fact>
        <Fact label="Booking page">{template.bookingPage.title}</Fact>
        <Fact label="Recommended connections">{connectionsLine(template)}</Fact>
      </dl>
      {onChoose ? (
        <Button variant="secondary" className="mt-4 self-start" onClick={onChoose} aria-describedby={titleId}>
          See the full preview<ArrowRight aria-hidden />
        </Button>
      ) : null}
    </Card>
  );
}

/** The owner's choice: the full resolved preview, the time zone, and the confirm. */
export function ApplyTemplate({ template, profileZone, onBack }: { template: IndustryTemplatePreview; profileZone: string | null; onBack: () => void }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const [zone, setZone] = useState(() => initialZone(profileZone, browserZone()));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const apply = useMutation({
    mutationFn: (input: { templateId: string; timeZone: string }) => api.applyTemplate(input),
    onSuccess: (result) => {
      // The commit is done: leave at once. A refetch that fails later must not keep the owner on Confirm.
      const refresh = (queryKeys: readonly (readonly unknown[])[]) =>
        void Promise.allSettled(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (result.replayed) {
        // Someone applied this template first, and the zone just chosen was not saved: show what is stored.
        refresh([keys.setup, keys.business]);
        toast(ALREADY_SET_UP, "info");
        return;
      }
      // The apply added a pipeline, a calendar, a booking page and wording, and set the zone.
      refresh([keys.setup, keys.pipelines, keys.resources, keys.slotsAll, keys.bookingPages, keys.business, keys.agentsAll]);
      // Said on the setup page, read on Home.
      toast(`Set up with ${template.label}.`, "success", { keepOnNavigate: true });
      router.push("/");
    },
    onError: (error) => {
      // Another owner applied a template first: show what is set up now.
      if (isApiError(error, "conflict")) void queryClient.invalidateQueries({ queryKey: keys.setup });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply.mutate({ templateId: template.id, timeZone: zone });
  };

  return (
    <>
      <Button variant="ghost" className="-ml-2 mb-3" onClick={onBack} disabled={apply.isPending}><ArrowLeft aria-hidden />All templates</Button>
      <TemplatePreview template={template} headingRef={heading} />
      <Card aria-labelledby="confirm-title" className="mt-4">
        <CardHeader><CardTitle id="confirm-title">Confirm</CardTitle></CardHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <ZoneField zone={zone} onChange={setZone} disabled={apply.isPending} />
          {apply.isError ? <ErrorNote error={apply.error} /> : null}
          <Button type="submit" disabled={apply.isPending} aria-busy={apply.isPending}>Set up with this template</Button>
        </form>
      </Card>
    </>
  );
}

function ZoneField({ zone, onChange, disabled }: { zone: string; onChange: (zone: string) => void; disabled: boolean }) {
  const zones = useMemo(() => timeZoneChoices(zone), [zone]);
  return (
    <div>
      <Label htmlFor="setup-zone">Time zone</Label>
      <Select id="setup-zone" className="w-full" value={zone} disabled={disabled} aria-describedby="setup-zone-hint" onChange={(event) => onChange(event.target.value)}>
        {zones.map((item) => <option key={item} value={item}>{zoneName(item)}</option>)}
      </Select>
      <p id="setup-zone-hint" className="mt-1 text-xs text-meta">Your opening hours and appointments use this zone. It is saved to your business details.</p>
    </div>
  );
}

/** IT-6, IT-7: everything the template adds, as the API resolved it. */
export function TemplatePreview({ template, headingRef }: { template: IndustryTemplatePreview; headingRef?: Ref<HTMLHeadingElement> }) {
  const { resource, bookingPage } = template;
  return (
    <>
      <header className="mb-6 lg:mb-8">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl leading-tight font-extrabold tracking-display outline-none lg:text-3xl">{template.label}</h1>
        <p className="mt-2 text-body text-muted">{template.summary}</p>
      </header>
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 lg:gap-4">
        <Card aria-labelledby="preview-pipeline-title">
          <CardHeader className="mb-2"><CardTitle id="preview-pipeline-title">Pipeline: {template.pipeline.name}</CardTitle></CardHeader>
          <ol className="divide-y divide-border-soft" data-testid="preview-stages">
            {template.pipeline.stages.map((stage) => (
              <li key={stage.name} className="flex items-center justify-between gap-3 py-2 text-sm text-fg-2 first:pt-0 last:pb-0">
                {stage.name}
                {stage.outcome === "won" ? <Badge tone="success">Won</Badge> : stage.outcome === "lost" ? <Badge>Lost</Badge> : null}
              </li>
            ))}
          </ol>
        </Card>
        <Card aria-labelledby="preview-resource-title">
          <CardHeader className="mb-2"><CardTitle id="preview-resource-title">Appointments: {resource.name}</CardTitle></CardHeader>
          <dl className="divide-y divide-border-soft" data-testid="preview-hours">
            <Fact label="Opening hours">{hoursLines(resource.weekly).map((line) => <span key={line} className="block">{line}</span>)}</Fact>
            <Fact label="Length">{durationLabel(resource.slotLengthMinutes)}, starting every {durationLabel(resource.slotStepMinutes)}</Fact>
            {resource.bufferBeforeMinutes > 0 ? <Fact label="Kept free before">{durationLabel(resource.bufferBeforeMinutes)}</Fact> : null}
            {resource.bufferAfterMinutes > 0 ? <Fact label="Kept free after">{durationLabel(resource.bufferAfterMinutes)}</Fact> : null}
            <Fact label="Booking window">At least {durationLabel(resource.minimumNoticeMinutes)} ahead, up to {durationLabel(resource.bookingHorizonMinutes)} ahead</Fact>
          </dl>
        </Card>
        <Card aria-labelledby="preview-page-title">
          <CardHeader className="mb-2"><CardTitle id="preview-page-title">Booking page: {bookingPage.title}</CardTitle></CardHeader>
          <dl className="divide-y divide-border-soft">
            <Fact label="Description">{bookingPage.description}</Fact>
            <Fact label="Shown to customers">{bookingPage.disclosureText}</Fact>
          </dl>
          <p className="mt-3 text-xs text-meta">The page starts off line. You take it live from Setup.</p>
        </Card>
        <Card aria-labelledby="preview-messages-title">
          <CardHeader className="mb-2"><CardTitle id="preview-messages-title">Messages</CardTitle></CardHeader>
          <dl className="divide-y divide-border-soft">
            {template.messages.map((message) => (
              <Fact key={message.agentKind} label={KIND_COPY[message.agentKind].title}>
                {message.subject ? <span className="block">{message.subject}</span> : null}
                <span className="block text-meta">{messageTimingLine(message)}</span>
              </Fact>
            ))}
            <Fact label="Recommended connections">{connectionsLine(template)}</Fact>
          </dl>
          <p className="mt-3 text-xs text-meta">{SENDING_OFF}</p>
        </Card>
      </div>
    </>
  );
}

/** IT-7 after apply: the template, the booking page and its switch, and what is left to do. */
function AppliedView({ setup, applied, owner }: { setup: SetupRead; applied: AppliedSetup; owner: boolean }) {
  const template = setup.templates.find((item) => item.id === applied.templateId);
  const label = template?.label ?? applied.templateId;
  return (
    <>
      <PageHeader title="Setup" description={APPLIED_DESCRIPTION} />
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 lg:gap-4">
        <Card aria-labelledby="applied-title" data-testid="applied-template">
          <CardHeader className="mb-2"><CardTitle id="applied-title">{label}</CardTitle></CardHeader>
          <CardDescription>Set up on {formatDay(applied.appliedAt, setup.timeZone ?? browserZone(), "long")}{setup.timeZone ? `, in ${zoneName(setup.timeZone)}` : ""}.</CardDescription>
          <ul className="mt-4 grid gap-2">
            <AreaLink href="/calendar" icon={<CalendarBlank size={20} aria-hidden />}>Calendar</AreaLink>
            <AreaLink href="/customers" icon={<UsersThree size={20} aria-hidden />}>Customers</AreaLink>
            <AreaLink href="/account/connections" icon={<LinkSimple size={20} aria-hidden />}>Connections</AreaLink>
          </ul>
        </Card>
        <BookingPageSwitch applied={applied} owner={owner} />
        <CalendarNote resourceId={applied.resourceId} />
        {template && template.recommendedAgents.length > 0 ? (
          <Card aria-labelledby="applied-agents-title">
            <CardHeader className="mb-2"><CardTitle id="applied-agents-title">Agents</CardTitle></CardHeader>
            <ul className="divide-y divide-border-soft">
              {template.recommendedAgents.map((kind) => (
                <li key={kind} className="py-2 first:pt-0 last:pb-0">
                  <Link href={`/agents#${AGENT_ANCHORS[kind]}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-accent-ink underline-offset-4 hover:underline">
                    <Robot size={20} aria-hidden />{KIND_COPY[kind].title}
                  </Link>
                  <p className="text-xs text-meta">{SENDING_OFF}</p>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function AreaLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 items-center gap-3 rounded-md px-2 text-sm font-semibold text-fg hover:bg-tray">
        <span className="text-muted">{icon}</span>
        <span className="flex-1">{children}</span>
        <ArrowRight size={18} aria-hidden className="text-muted" />
      </Link>
    </li>
  );
}

/** IT-11: the template's booking page, live or off line; only an owner switches it. */
function BookingPageSwitch({ applied, owner }: { applied: AppliedSetup; owner: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  // The title and address come with the setup read, so staff (who cannot list pages) see them too.
  const live = applied.published;

  const change = useMutation({
    mutationFn: (payload: { pageId: string; published: boolean }) =>
      api.setBookingPagePublished(payload.pageId, payload.published, { idempotencyKey: intents.keyFor(payload) }),
    onSettled: (_result, error, payload) => intents.settle(payload, error),
    onSuccess: async (result) => {
      // An older setup read still in flight would put the previous flag back: stop it first.
      await queryClient.cancelQueries({ queryKey: keys.setup });
      queryClient.setQueryData<SetupRead>(keys.setup, (read) => (read?.applied ? { ...read, applied: { ...read.applied, published: result.published } } : read));
      void Promise.allSettled([queryClient.invalidateQueries({ queryKey: keys.setup }), queryClient.invalidateQueries({ queryKey: keys.bookingPages })]);
      toast(result.published ? "Your booking page is live." : "Your booking page is off line.");
    },
  });

  return (
    <Card aria-labelledby="applied-page-title" data-testid="applied-page">
      <CardHeader className="mb-2">
        <CardTitle id="applied-page-title" className="flex flex-wrap items-center gap-2">
          <Globe size={20} aria-hidden className="text-meta" />
          {applied.bookingPageTitle}
        </CardTitle>
        <Badge tone={live ? "success" : "neutral"} live={live}>{live ? "Live" : "Off line"}</Badge>
      </CardHeader>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="setup-page-live" className="mb-0">Take the booking page live</Label>
          <p id="setup-page-live-help" className="text-xs text-meta">{live ? "Customers can book on it now." : "Customers can't open it until it is live."}</p>
        </div>
        <Switch
          id="setup-page-live"
          checked={live}
          onCheckedChange={(next) => change.mutate({ pageId: applied.bookingPageId, published: next })}
          disabled={!owner || change.isPending}
          aria-busy={change.isPending}
          aria-describedby={owner ? "setup-page-live-help" : "setup-page-live-help setup-page-reason"}
        />
      </div>
      {owner ? null : <DisabledReason id="setup-page-reason">{OWNER_ONLY_TOGGLE}</DisabledReason>}
      {change.isError ? <ErrorNote error={change.error} /> : null}
      {live && applied.bookingUrl ? (
        <Button asChild variant="secondary" className="mt-3">
          <a href={applied.bookingUrl} target="_blank" rel="noreferrer noopener"><ArrowSquareOut aria-hidden />Open booking page</a>
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * IT-7: a note unless the template's calendar has an active Google Calendar connection. A
 * connection that needs a reconnect counts as not connected. Nothing while the read is pending.
 */
function CalendarNote({ resourceId }: { resourceId: string }) {
  const connections = useCalendarConnections();
  if (connections.isError) {
    return (
      <Card aria-labelledby="applied-google-title" data-testid="google-unknown">
        <CardHeader className="mb-2"><CardTitle id="applied-google-title">Google Calendar</CardTitle></CardHeader>
        <ErrorNote error={connections.error} retry={() => void connections.refetch()} message="We couldn't check your Google Calendar connection." />
        <p className="mt-3 text-sm text-muted">{CALENDAR_CLASH_ADVICE}</p>
      </Card>
    );
  }
  if (!connections.isSuccess || calendarConnected(connections.data, resourceId)) return null;
  const needsReconnect = connections.data.some((item) => item.resourceId === resourceId && item.status === "reauthorize");
  return (
    <Card aria-labelledby="applied-google-title" data-testid="google-not-connected">
      <CardHeader className="mb-2">
        <CardTitle id="applied-google-title">{needsReconnect ? "Google Calendar needs to be reconnected" : "Google Calendar is not connected yet"}</CardTitle>
      </CardHeader>
      <CardDescription>Connect it so busy times there are kept free on your booking page. {CALENDAR_CLASH_ADVICE}</CardDescription>
      <Button asChild variant="secondary" className="mt-3">
        <Link href="/account/connections">Go to Connections</Link>
      </Button>
    </Card>
  );
}
