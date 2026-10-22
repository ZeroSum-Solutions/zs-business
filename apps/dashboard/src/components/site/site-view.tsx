"use client";

import { ArrowCounterClockwise, ArrowSquareOut, Eye, PencilSimple, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useClearToasts, useToast } from "@/components/ui/toast";
import {
  isApiError,
  isStaleRelease,
  type SitePreview,
  type SiteRecord,
  type SiteReleaseRecord,
  type SiteReleaseResponse,
  type SiteSpec,
} from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { createIntentKeys, fingerprint, isDefinitive, useIntentKey, type IntentKeys } from "@/lib/intent-key";
import { useKeys, useSiteEdge, useSiteRelease, useSiteReleases, useSites } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { draftFrom, draftProblem, LIMITS, MAX_SECTIONS, newSectionKey, specFrom, type Draft } from "./draft";
import { releaseMeta, singleFlight, siteStatus } from "./site-status";

/** Site toasts share a topic: each new answer replaces the last, so two never disagree. */
const SITE = { topic: "site" };

function PreviewFrame({ preview }: { preview: SitePreview }) {
  if (preview.entryHtml === null) return <p className="text-sm text-muted">This page cannot be shown here. Publish to see it on your site.</p>;
  return (
    <iframe
      title="Preview of your site"
      // No scripts, forms or same-origin access: the page is shown, never run.
      sandbox=""
      srcDoc={preview.entryHtml}
      className="h-[60dvh] w-full rounded-sm bg-white shadow-[inset_0_0_0_1px_var(--border-strong)]"
      data-testid="site-preview"
    />
  );
}

/** One opening of the editor: the live release it started from, and the spec it starts with. */
interface Editing { baseline: string | null; liveSpec: SiteSpec | undefined }

interface PublishRequest { spec: SiteSpec; expectedCurrentReleaseId: string | null }

/**
 * A publish sent and not yet answered for good: still in flight, or its answer was lost, so it
 * may have committed. A site has at most one, and until it settles the only publish allowed is
 * that very request again, which reuses its key and so replays instead of adding a version.
 */
interface OpenPublish { request: PublishRequest; inFlight: boolean }

/**
 * Per site, for as long as the tab lives: the intent keys for publish and rollback, and the open
 * publish. Kept outside React, so neither closing a dialog, leaving the page nor a refresh that
 * moves the live release lets a second publish overlap one whose outcome is unknown.
 */
interface SiteWrites { publish: IntentKeys; rollback: IntentKeys; open: OpenPublish | null; listeners: Set<() => void> }
const siteWrites = new Map<string, SiteWrites>();
function writesFor(siteId: string): SiteWrites {
  let writes = siteWrites.get(siteId);
  if (!writes) {
    writes = { publish: createIntentKeys(), rollback: createIntentKeys(), open: null, listeners: new Set() };
    siteWrites.set(siteId, writes);
  }
  return writes;
}
function setOpenPublish(writes: SiteWrites, open: OpenPublish | null) {
  writes.open = open;
  for (const listener of writes.listeners) listener();
}
/** Why `request` may not be published while `open` is unsettled: wait for it, or send it again as it was. */
function holdFor(open: OpenPublish | null, request: PublishRequest): "in_flight" | "changed" | null {
  if (open === null) return null;
  return open.inFlight ? "in_flight" : fingerprint(open.request) === fingerprint(request) ? null : "changed";
}
function useOpenPublish(writes: SiteWrites): OpenPublish | null {
  return useSyncExternalStore(
    (listener) => { writes.listeners.add(listener); return () => { writes.listeners.delete(listener); }; },
    () => writes.open,
    () => writes.open,
  );
}

/** Over its limit after trimming, as `draftProblem` counts it. */
const tooLong = (text: string, limit: number) => text.trim().length > limit || undefined;

/**
 * The editor's fields. No `maxLength`: a pasted text past a limit stays whole, the field is
 * marked, and `draftProblem` says what to shorten (U3-10).
 */
export function DraftFields({ draft, onEdit, onEditSection, onRemove }: {
  draft: Draft;
  onEdit: (change: Partial<Draft>) => void;
  onEditSection: (key: number, change: { heading?: string; body?: string }) => void;
  onRemove: (key: number) => void;
}) {
  const invalid = (over: true | undefined) => (over ? { "aria-invalid": true, "aria-describedby": "draft-why" } : {});
  return (
    <>
      <div>
        <Label htmlFor="site-title">Site title</Label>
        <Input id="site-title" value={draft.title} {...invalid(tooLong(draft.title, LIMITS.title))} onChange={(event) => onEdit({ title: event.target.value })} />
      </div>
      <div>
        <Label htmlFor="site-tagline">Tagline</Label>
        <Input id="site-tagline" value={draft.tagline} {...invalid(tooLong(draft.tagline, LIMITS.tagline))} onChange={(event) => onEdit({ tagline: event.target.value })} />
      </div>
      {draft.sections.map((section, index) => (
        <fieldset key={section.key} className="space-y-3 rounded-sm p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
          <legend className="px-1 text-sm font-medium text-fg">Section {index + 1}</legend>
          <div>
            <Label htmlFor={`section-${section.key}-heading`}>Heading</Label>
            <Input id={`section-${section.key}-heading`} value={section.heading} {...invalid(tooLong(section.heading, LIMITS.heading))}
              onChange={(event) => onEditSection(section.key, { heading: event.target.value })} />
          </div>
          <div>
            <Label htmlFor={`section-${section.key}-body`}>Text</Label>
            <Textarea id={`section-${section.key}-body`} value={section.body} {...invalid(tooLong(section.body, LIMITS.body))}
              onChange={(event) => onEditSection(section.key, { body: event.target.value })} />
          </div>
          <Button variant="ghost" onClick={() => onRemove(section.key)}>
            <Trash aria-hidden />Remove section {index + 1}
          </Button>
        </fieldset>
      ))}
    </>
  );
}

function SiteEditor({ site, editing, writes, generation, onClose, onPublished }: {
  site: SiteRecord;
  editing: Editing;
  writes: SiteWrites;
  /** Tags an attempt with this opening, so the page can tell a late answer from a current one. */
  generation: () => number;
  onClose: () => void;
  onPublished: (response: SiteReleaseResponse, generation: number) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const clearToasts = useClearToasts();
  const [draft, setDraft] = useState(() => draftFrom(editing.liveSpec, site.name));
  // A preview is shown only while the draft still says what was previewed.
  const [preview, setPreview] = useState<{ print: string; preview: SitePreview } | null>(null);
  const [stale, setStale] = useState(false);
  const spec = specFrom(draft);
  const request: PublishRequest = { spec, expectedCurrentReleaseId: editing.baseline };
  const open = useOpenPublish(writes);
  // While a publish is open, nothing else may be published: wait for it, or send it again as it was.
  const held = holdFor(open, request);
  const shown = preview && preview.print === fingerprint(spec) ? preview.preview : null;
  const problem = draftProblem(draft, editing.baseline);
  const edit = (change: Partial<Draft>) => { setDraft({ ...draft, ...change }); setPreview(null); };
  const editSection = (key: number, change: { heading?: string; body?: string }) =>
    edit({ sections: draft.sections.map((section) => (section.key === key ? { ...section, ...change } : section)) });

  // The preview replaces the form: focus moves to the way back, and back to the first field (U3-11).
  const backRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown && !wasShown.current) backRef.current?.focus();
    if (!shown && wasShown.current) titleRef.current?.querySelector("input")?.focus();
    wasShown.current = shown !== null;
  }, [shown]);

  const showPreview = useMutation({
    mutationFn: (requested: SiteSpec) => api.previewSite(site.id, requested),
    onSuccess: (result, requested) => setPreview({ print: fingerprint(requested), preview: result }),
  });
  const publish = useMutation({
    mutationFn: ({ input }: { input: { siteId: string } & PublishRequest; generation: number }) =>
      api.publishSite(input, { idempotencyKey: writes.publish.keyFor(input) }),
    onSettled: (_result, error, attempt) => {
      writes.publish.settle(attempt.input, error);
      const sent: PublishRequest = { spec: attempt.input.spec, expectedCurrentReleaseId: attempt.input.expectedCurrentReleaseId };
      if (writes.open && fingerprint(writes.open.request) === fingerprint(sent)) {
        setOpenPublish(writes, isDefinitive(error) ? null : { request: sent, inFlight: false });
      }
    },
    onSuccess: (response, attempt) => onPublished(response, attempt.generation),
    onError: (error) => {
      if (!isStaleRelease(error)) return;
      setStale(true);
      void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
    },
  });
  const busy = showPreview.isPending || publish.isPending;
  const error = publish.isError && !isStaleRelease(publish.error) ? publish.error : showPreview.error;
  const runPreview = () => {
    if (busy || problem) return;
    publish.reset();
    showPreview.mutate(spec);
  };
  const runPublish = () => {
    // `writes.open` is set below before React re-renders, so a second press in the same frame stops here.
    if (busy || problem || stale || holdFor(writes.open, request) !== null) return;
    showPreview.reset();
    clearToasts(SITE.topic);
    setOpenPublish(writes, { request, inFlight: true });
    publish.mutate({ input: { siteId: site.id, ...request }, generation: generation() });
  };
  // This opening's own publish shows as "Publishing"; one sent from an earlier opening is explained.
  const heldWhy = held && !publish.isPending ? held : null;
  const publishWhy = [problem ? "draft-why" : null, stale ? "stale-why" : null, heldWhy ? "held-why" : null].filter(Boolean).join(" ") || undefined;

  // The actions stay in view below the fields, with the reason they are off beside them (U3 A-7).
  const footer = (
    <div className="space-y-2">
      {problem ? <DisabledReason id="draft-why">{problem}</DisabledReason> : null}
      {heldWhy ? (
        <DisabledReason id="held-why">
          {heldWhy === "in_flight"
            ? "Wait for your last publish to answer before publishing again."
            : "This changes the publish that got no answer. Publish it as it was first, then make more changes."}
        </DisabledReason>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{stale ? "Close" : "Cancel"}</Button>
        {shown ? null : (
          <Button variant="secondary" disabled={busy || problem !== null} aria-busy={showPreview.isPending}
            aria-describedby={problem ? "draft-why" : undefined} onClick={runPreview}>
            <Eye aria-hidden />{showPreview.isPending ? "Building preview" : "Preview"}
          </Button>
        )}
        <Button disabled={busy || problem !== null || stale || held !== null} aria-busy={publish.isPending}
          aria-describedby={publishWhy} onClick={runPublish}>
          {publish.isPending ? "Publishing" : "Publish"}
        </Button>
      </div>
    </div>
  );

  return (
    <DialogContent title="Edit site" description="Change the words, preview the page, then publish. Earlier versions stay in History." footer={footer}>
      {stale ? (
        // Shown where the owner looks first, in the warning style the resume note uses (U3 A-6).
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-sm bg-warn-tint p-3 text-sm text-fg-2">
          <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-warn" />
          <p id="stale-why">
            Another version went live while you were editing, so this one was not published. Close the editor and open it again to start from the live version.
          </p>
        </div>
      ) : null}
      {open && !publish.isPending ? (
        <p className="mb-4 rounded-sm bg-warn-tint p-3 text-sm text-fg-2" role="status" data-testid="site-resume">
          {open.inFlight
            ? "Your last publish is still on its way. You can publish again once it has an answer."
            : "Your last publish got no answer, so it may already be live. Publish it again as it was to finish it. It will not be added twice."}
        </p>
      ) : null}
      {shown ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted">This is a preview. Nothing changes on your site until you publish.</p>
          <PreviewFrame preview={shown} />
          <Button ref={backRef} variant="secondary" onClick={() => setPreview(null)}><PencilSimple aria-hidden />Back to editing</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); runPreview(); }}>
          <div ref={titleRef} className="space-y-4">
            <DraftFields draft={draft} onEdit={edit} onEditSection={editSection}
              onRemove={(key) => edit({ sections: draft.sections.filter((item) => item.key !== key) })} />
          </div>
          <Button variant="secondary" disabled={draft.sections.length >= MAX_SECTIONS}
            aria-describedby={draft.sections.length >= MAX_SECTIONS ? "sections-full" : undefined}
            onClick={() => edit({ sections: [...draft.sections, { key: newSectionKey(), heading: "", body: "" }] })}>
            <Plus aria-hidden />Add section
          </Button>
          {draft.sections.length >= MAX_SECTIONS ? <DisabledReason id="sections-full">A page holds {MAX_SECTIONS} sections at most.</DisabledReason> : null}
          {/* Submitting the form previews; Enter in a field never publishes. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
      {error ? <div className="mt-4"><ErrorNote error={error} /></div> : null}
    </DialogContent>
  );
}

/** One opening of the rollback dialog, with the live release as the page showed it then. */
interface RollingBack { release: SiteReleaseRecord; expectedCurrentReleaseId: string | null }

function RollbackDialog({ site, target, intents, generation, onDone }: {
  site: SiteRecord;
  target: RollingBack;
  intents: IntentKeys;
  generation: () => number;
  onDone: (outcome: { response: SiteReleaseResponse } | { stale: true }, generation: number) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const clearToasts = useClearToasts();
  // A double tap must not send twice or toast twice (U3-4).
  const [flight] = useState(singleFlight);
  const { release } = target;
  // Fixed for this opening: a retry after a lost answer sends the same request with the same key,
  // so the server's stale check still guards it if another version went live meanwhile.
  const input = { siteId: site.id, releaseId: release.id, expectedCurrentReleaseId: target.expectedCurrentReleaseId };
  const activate = useMutation({
    mutationFn: (_attempt: { generation: number }) => api.activateSiteRelease(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: (_result, error) => {
      intents.settle(input, error);
      // After a lost answer the outcome is unknown; refreshing now would only hide what the owner confirmed.
      if (isDefinitive(error)) void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
    },
    onSuccess: (response, attempt) => onDone({ response }, attempt.generation),
    onError: (error, attempt) => {
      if (isStaleRelease(error)) onDone({ stale: true }, attempt.generation);
    },
  });
  return (
    <DialogContent title={`Make version ${release.number} live?`} description={`${releaseMeta(release, Date.now())}. Visitors see it as soon as it is live.`}>
      {activate.isError && !isStaleRelease(activate.error) ? <div className="mb-4"><ErrorNote error={activate.error} /></div> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button disabled={activate.isPending} aria-busy={activate.isPending} onClick={() => flight.run((done) => {
          clearToasts(SITE.topic);
          activate.mutate({ generation: generation() }, { onSettled: done });
        })}>
          <ArrowCounterClockwise aria-hidden />{activate.isPending ? "Making it live" : `Make version ${release.number} live`}
        </Button>
      </div>
    </DialogContent>
  );
}

function CreateSite() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const intents = useIntentKey();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (value: string) => api.createSite(value, { idempotencyKey: intents.keyFor({ name: value }) }),
    onSettled: (_result, error, value) => {
      intents.settle({ name: value }, error);
      void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
    },
  });
  return (
    <EmptyState title="No website yet" action={
      <form className="mx-auto max-w-sm space-y-3 text-left" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !create.isPending) create.mutate(name.trim()); }}>
        <div>
          <Label htmlFor="site-name">Website name</Label>
          <Input id="site-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </div>
        {create.isError ? <ErrorNote error={create.error} /> : null}
        {name.trim() ? null : <DisabledReason id="site-name-why">Name your website first.</DisabledReason>}
        <Button type="submit" disabled={!name.trim() || create.isPending} aria-busy={create.isPending}
          aria-describedby={name.trim() ? undefined : "site-name-why"}>{create.isPending ? "Creating" : "Create website"}</Button>
      </form>
    } />
  );
}

function SitePanel({ site }: { site: SiteRecord }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const clearToasts = useClearToasts();
  const releases = useSiteReleases(site.id);
  const live = useSiteRelease(site.id, site.currentReleaseId);
  const edge = useSiteEdge(site.id, site.pointerVersion, site.currentReleaseId !== null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rollingBack, setRollingBack] = useState<RollingBack | null>(null);
  const writes = writesFor(site.id);
  // A publish or rollback answering after its dialog closed (and maybe reopened) still updates
  // the page and may confirm itself, but never closes the newer opening.
  const editorGeneration = useDialogGeneration(editing !== null);
  const rollbackGeneration = useDialogGeneration(rollingBack !== null, rollingBack?.release.id);
  const [syncFlight] = useState(singleFlight);
  const sync = useMutation({
    mutationFn: () => api.syncSite(site.id),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.siteEdge(site.id, response.site.pointerVersion), response.edge);
      if (response.site.pointerVersion !== site.pointerVersion) void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
      // Still behind: the note on the card says so, and a toast would only repeat it.
      if (response.edge === "synced") toast("Your site shows the live version now.", "success", SITE);
    },
  });
  const runSync = () => syncFlight.run((done) => {
    clearToasts(SITE.topic);
    sync.mutate(undefined, { onSettled: done });
  });
  const wentLive = (response: SiteReleaseResponse) => {
    // A check made for the version before says nothing about this one.
    sync.reset();
    queryClient.setQueryData(keys.siteEdge(site.id, response.result.site.pointerVersion), response.edge);
    void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
  };
  const host = site.hosts[0] ?? null;
  const open = useOpenPublish(writes);
  const status = siteStatus({
    published: site.currentReleaseId !== null,
    live: live.data ?? (live.isError ? "error" : "loading"),
    edge: edge.data ?? (edge.isError ? "error" : "loading"),
    open,
    now: Date.now(),
  });

  return (
    <>
      <PageHeader
        title="Site"
        description={host ?? "No web address yet"}
        actions={host && site.currentReleaseId ? (
          <Button variant="secondary" asChild>
            <a href={`https://${host}`} target="_blank" rel="noreferrer"><ArrowSquareOut aria-hidden />View site</a>
          </Button>
        ) : null}
      />
      <Card className="mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-bold">{site.name}</h2>
          <Badge tone={status.badge.tone} data-testid="site-badge">{status.badge.label}</Badge>
        </div>
        <p id="site-live-summary" className="text-sm text-muted" data-testid="site-live-summary">{status.summary}</p>
        {live.isError ? <ErrorNote error={live.error} retry={() => live.refetch()} /> : null}
        {status.note ? (
          <div className="rounded-sm bg-warn-tint p-3 text-sm text-fg-2" role="status" data-testid="site-edge">
            <p>{status.note}</p>
            {sync.data?.edge === "pending" && edge.data === "pending" ? (
              <p className="mt-1" data-testid="site-edge-checked">Checked again just now. Try again in a moment.</p>
            ) : null}
            <Button className="mt-2" variant="secondary" disabled={sync.isPending} aria-busy={sync.isPending} onClick={runSync}>
              {sync.isPending ? "Updating" : "Update the site now"}
            </Button>
            {sync.isError ? <div className="mt-2"><ErrorNote error={sync.error} retry={runSync} /></div> : null}
          </div>
        ) : null}
        <Button disabled={site.currentReleaseId !== null && !live.data} aria-busy={site.currentReleaseId !== null && live.isPending}
          aria-describedby={live.isError ? "site-live-summary" : undefined}
          // An open publish reopens exactly as it was sent, since it is the only one that may be sent.
          onClick={() => setEditing(writes.open
            ? { baseline: writes.open.request.expectedCurrentReleaseId, liveSpec: writes.open.request.spec }
            : { baseline: site.currentReleaseId, liveSpec: live.data?.spec })}>
          <PencilSimple aria-hidden />Edit site
        </Button>
      </Card>

      <section aria-labelledby="site-history-title" className="tray">
        <h2 id="site-history-title" className="px-3 pt-2 pb-2.5 text-base font-bold lg:px-4">History</h2>
        {releases.isPending ? <LoadingRows rows={3} label="Loading versions" /> : releases.isError ? (
          <ErrorNote error={releases.error} retry={() => releases.refetch()} />
        ) : releases.data.length === 0 ? (
          <p className="card p-4 text-sm text-muted">Each time you publish, the version you replaced stays here, ready to bring back.</p>
        ) : (
          <ul className="grid gap-1.5 lg:gap-2">
            {releases.data.map((release) => {
              const isLive = release.id === site.currentReleaseId;
              return (
                <li key={release.id} data-testid="site-release">
                  <Card className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">Version {release.number}</p>
                        {isLive ? <Badge tone={status.current.tone}>{status.current.label}</Badge> : null}
                      </div>
                      <p className="text-xs text-meta">{releaseMeta(release, Date.now())}</p>
                    </div>
                    {isLive ? null : (
                      <Button variant="secondary" onClick={() => setRollingBack({ release, expectedCurrentReleaseId: site.currentReleaseId })}>
                        <ArrowCounterClockwise aria-hidden />Make live<span className="sr-only"> version {release.number}</span>
                      </Button>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          <SiteEditor
            site={site}
            editing={editing}
            writes={writes}
            generation={editorGeneration.current}
            onClose={() => setEditing(null)}
            onPublished={(response, tag) => {
              wentLive(response);
              const current = editorGeneration.isCurrent(tag);
              if (current) setEditing(null);
              if (current || editorGeneration.isClosed()) {
                toast(response.edge === "pending" ? "Published. Your site will show it in a moment." : "Published. Your site is live.",
                  response.edge === "pending" ? "info" : "success", SITE);
              }
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={rollingBack !== null} onOpenChange={(open) => !open && setRollingBack(null)}>
        {rollingBack ? (
          <RollbackDialog site={site} target={rollingBack} intents={writes.rollback} generation={rollbackGeneration.current}
            onDone={(outcome, tag) => {
              const current = rollbackGeneration.isCurrent(tag);
              const speak = current || rollbackGeneration.isClosed();
              if ("stale" in outcome) {
                if (speak) toast("Another version went live since you opened this page. History is up to date now.", "info", SITE);
              } else {
                wentLive(outcome.response);
                const number = outcome.response.result.release.number;
                if (speak) {
                  toast(outcome.response.edge === "pending"
                    ? `Version ${number} is live. Your site will show it in a moment.`
                    : `Version ${number} is live again.`, outcome.response.edge === "pending" ? "info" : "success", SITE);
                }
              }
              if (current) setRollingBack(null);
            }} />
        ) : null}
      </Dialog>
    </>
  );
}

export function SiteView() {
  const { session } = useSession();
  const sites = useSites();
  if (session.status === "signed_in" && session.role !== "owner") {
    return (
      <>
        <PageHeader title="Site" />
        <EmptyState title="Owners publish the website">Ask an owner of the business to change the site.</EmptyState>
      </>
    );
  }
  if (sites.isPending) return <><PageHeader title="Site" /><LoadingRows rows={4} label="Loading your website" /></>;
  if (sites.isError) {
    return (
      <>
        <PageHeader title="Site" />
        {isApiError(sites.error, "forbidden")
          ? <EmptyState title="Owners publish the website">Ask an owner of the business to change the site.</EmptyState>
          : isApiError(sites.error, "not_found")
            // The API answers 404 for /v1/sites until SITES_STORE is set.
            ? <EmptyState title="Website publishing is not switched on yet">It needs to be set up for this business first.</EmptyState>
            : <ErrorNote error={sites.error} retry={() => sites.refetch()} />}
      </>
    );
  }
  const site = sites.data[0];
  return site ? <SitePanel key={site.id} site={site} /> : <><PageHeader title="Site" /><CreateSite /></>;
}
