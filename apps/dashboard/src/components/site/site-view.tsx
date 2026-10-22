"use client";

import { ArrowCounterClockwise, ArrowSquareOut, Eye, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
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
import { relativeTime } from "@/lib/utils";
import { draftFrom, draftProblem, LIMITS, MAX_SECTIONS, newSectionKey, specFrom, type Draft } from "./draft";

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
function useOpenPublish(writes: SiteWrites): OpenPublish | null {
  return useSyncExternalStore(
    (listener) => { writes.listeners.add(listener); return () => { writes.listeners.delete(listener); }; },
    () => writes.open,
    () => writes.open,
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
  const [draft, setDraft] = useState(() => draftFrom(editing.liveSpec, site.name));
  // A preview is shown only while the draft still says what was previewed.
  const [preview, setPreview] = useState<{ print: string; preview: SitePreview } | null>(null);
  const [stale, setStale] = useState(false);
  const spec = specFrom(draft);
  const request: PublishRequest = { spec, expectedCurrentReleaseId: editing.baseline };
  const open = useOpenPublish(writes);
  // While a publish is open, nothing else may be published: wait for it, or send it again as it was.
  const held = open === null ? null : open.inFlight ? "in_flight" : fingerprint(open.request) === fingerprint(request) ? null : "changed";
  const shown = preview && preview.print === fingerprint(spec) ? preview.preview : null;
  const problem = draftProblem(draft, editing.baseline);
  const edit = (change: Partial<Draft>) => { setDraft({ ...draft, ...change }); setPreview(null); };
  const editSection = (key: number, change: { heading?: string; body?: string }) =>
    edit({ sections: draft.sections.map((section) => (section.key === key ? { ...section, ...change } : section)) });

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
    if (busy || problem || stale || held) return;
    showPreview.reset();
    setOpenPublish(writes, { request, inFlight: true });
    publish.mutate({ input: { siteId: site.id, ...request }, generation: generation() });
  };
  // This opening's own publish shows as "Publishing"; one sent from an earlier opening is explained.
  const heldWhy = held && !publish.isPending ? held : null;
  const publishWhy = [problem ? "draft-why" : null, stale ? "stale-why" : null, heldWhy ? "held-why" : null].filter(Boolean).join(" ") || undefined;

  return (
    <DialogContent title="Edit site" description="Change the words, preview the page, then publish. Earlier versions stay in History.">
      {open && !publish.isPending ? (
        <p className="mb-4 rounded-sm bg-warn-tint p-3 text-sm text-fg-2" role="status" data-testid="site-resume">
          {open.inFlight
            ? "Your last publish is still on its way. You can publish again once it has an answer."
            : "Your last publish got no answer, so it may already be live. Publish it again as it was to finish it. It will not be added twice."}
        </p>
      ) : null}
      {shown ? (
        <div className="space-y-4">
          <PreviewFrame preview={shown} />
          <Button variant="secondary" onClick={() => setPreview(null)}><PencilSimple aria-hidden />Back to editing</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); runPreview(); }}>
          <div>
            <Label htmlFor="site-title">Site title</Label>
            <Input id="site-title" value={draft.title} maxLength={LIMITS.title} onChange={(event) => edit({ title: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="site-tagline">Tagline</Label>
            <Input id="site-tagline" value={draft.tagline} maxLength={LIMITS.tagline} onChange={(event) => edit({ tagline: event.target.value })} />
          </div>
          {draft.sections.map((section, index) => (
            <fieldset key={section.key} className="space-y-3 rounded-sm p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
              <legend className="px-1 text-sm font-medium text-fg">Section {index + 1}</legend>
              <div>
                <Label htmlFor={`section-${section.key}-heading`}>Heading</Label>
                <Input id={`section-${section.key}-heading`} value={section.heading} maxLength={LIMITS.heading}
                  onChange={(event) => editSection(section.key, { heading: event.target.value })} />
              </div>
              <div>
                <Label htmlFor={`section-${section.key}-body`}>Text</Label>
                <Textarea id={`section-${section.key}-body`} value={section.body} maxLength={LIMITS.body}
                  onChange={(event) => editSection(section.key, { body: event.target.value })} />
              </div>
              <Button variant="ghost" onClick={() => edit({ sections: draft.sections.filter((item) => item.key !== section.key) })}>
                <Trash aria-hidden />Remove section {index + 1}
              </Button>
            </fieldset>
          ))}
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
      {stale ? (
        <div className="mt-4">
          <DisabledReason id="stale-why">
            Another version went live while you were editing, so this one was not published. Close the editor and open it again to start from the live version.
          </DisabledReason>
        </div>
      ) : null}
      {problem ? <div className="mt-4"><DisabledReason id="draft-why">{problem}</DisabledReason></div> : null}
      {heldWhy ? (
        <div className="mt-4">
          <DisabledReason id="held-why">
            {heldWhy === "in_flight"
              ? "Wait for your last publish to answer before publishing again."
              : "This changes the publish that got no answer. Publish it as it was first, then make more changes."}
          </DisabledReason>
        </div>
      ) : null}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
    <DialogContent title={`Make version ${release.number} live?`} description={`Published ${relativeTime(release.createdAt).toLowerCase()}. Visitors see it as soon as it is live.`}>
      {activate.isError && !isStaleRelease(activate.error) ? <div className="mb-4"><ErrorNote error={activate.error} /></div> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button disabled={activate.isPending} aria-busy={activate.isPending} onClick={() => activate.mutate({ generation: generation() })}>
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
  const sync = useMutation({
    mutationFn: () => api.syncSite(site.id),
    onSuccess: (response) => {
      queryClient.setQueryData(keys.siteEdge(site.id, response.site.pointerVersion), response.edge);
      if (response.site.pointerVersion !== site.pointerVersion) void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
      toast(response.edge === "synced" ? "Your site shows the live version now." : "Your site still shows the previous version. Try again in a moment.",
        response.edge === "synced" ? "success" : "info");
    },
  });
  const wentLive = (response: SiteReleaseResponse) => {
    queryClient.setQueryData(keys.siteEdge(site.id, response.result.site.pointerVersion), response.edge);
    void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
  };
  const host = site.hosts[0] ?? null;
  const edgeBehind = site.currentReleaseId !== null && (edge.data === "pending" || edge.isError);
  const liveSummary = site.currentReleaseId === null ? "Write your first page and publish it."
    : live.data ? `Version ${live.data.number} is live. Published ${relativeTime(live.data.createdAt).toLowerCase()}.`
      : live.isError ? "Could not load the live version." : "Loading the live version.";

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
          {site.currentReleaseId ? <Badge tone="success">Live</Badge> : <Badge tone="warn">Not published</Badge>}
        </div>
        <p id="site-live-summary" className="text-sm text-muted" data-testid="site-live-summary">{liveSummary}</p>
        {live.isError ? <ErrorNote error={live.error} retry={() => live.refetch()} /> : null}
        {edgeBehind ? (
          <div className="rounded-sm bg-warn-tint p-3 text-sm text-fg-2" role="status" data-testid="site-edge">
            <p>{edge.data === "pending"
              ? "Saved and live here, but your site still shows the previous version."
              : "Could not check whether your site shows the live version."}</p>
            <Button className="mt-2" variant="secondary" disabled={sync.isPending} aria-busy={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? "Updating" : "Update the site now"}
            </Button>
            {sync.isError ? <div className="mt-2"><ErrorNote error={sync.error} retry={() => sync.mutate()} /></div> : null}
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
                        {isLive ? <Badge tone="success">Live</Badge> : null}
                      </div>
                      <p className="text-xs text-meta">Published {relativeTime(release.createdAt).toLowerCase()}</p>
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
                  response.edge === "pending" ? "info" : "success");
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
                if (speak) toast("Another version went live since you opened this page. History is up to date now.", "info");
              } else {
                wentLive(outcome.response);
                const number = outcome.response.result.release.number;
                if (speak) {
                  toast(outcome.response.edge === "pending"
                    ? `Version ${number} is live. Your site will show it in a moment.`
                    : `Version ${number} is live again.`, outcome.response.edge === "pending" ? "info" : "success");
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
