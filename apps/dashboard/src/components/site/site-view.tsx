"use client";

import { ArrowCounterClockwise, ArrowSquareOut, Eye, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, isStaleRelease, type SitePreview, type SiteRecord, type SiteReleaseRecord, type SiteSpec } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useKeys, useSiteRelease, useSiteReleases, useSites } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { relativeTime } from "@/lib/utils";

/** The plain site spec as the editor holds it; sections carry a local key for React. */
interface Draft {
  title: string;
  tagline: string;
  sections: { key: number; heading: string; body: string }[];
}
const MAX_SECTIONS = 20;
let nextKey = 1;

function draftFrom(spec: SiteSpec | undefined, fallbackTitle: string): Draft {
  const plain = spec?.kind === "plain" ? spec : undefined;
  const sections = Array.isArray(plain?.sections) ? plain.sections : [];
  return {
    title: typeof plain?.title === "string" ? plain.title : fallbackTitle,
    tagline: typeof plain?.tagline === "string" ? plain.tagline : "",
    sections: sections.flatMap((section) => {
      if (section === null || typeof section !== "object" || Array.isArray(section)) return [];
      const { heading, body } = section as Record<string, unknown>;
      return typeof heading === "string" && typeof body === "string" ? [{ key: nextKey++, heading, body }] : [];
    }),
  };
}

function specFrom(draft: Draft): SiteSpec {
  const tagline = draft.tagline.trim();
  return {
    kind: "plain",
    title: draft.title.trim(),
    ...(tagline ? { tagline } : {}),
    sections: draft.sections.map((section) => ({ heading: section.heading.trim(), body: section.body.trim() })),
  };
}

/** Why the draft cannot go out yet, or null. The API checks the same limits. */
function draftProblem(draft: Draft): string | null {
  if (!draft.title.trim()) return "Add a site title first.";
  if (draft.sections.some((section) => !section.heading.trim() || !section.body.trim())) return "Each section needs a heading and some text.";
  return null;
}

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

function SiteEditor({ site, liveSpec, onClose, onPublished }: {
  site: SiteRecord;
  liveSpec: SiteSpec | undefined;
  onClose: () => void;
  onPublished: (pending: boolean) => void;
}) {
  const api = useApi();
  const intents = useIntentKey();
  const [draft, setDraft] = useState(() => draftFrom(liveSpec, site.name));
  const [preview, setPreview] = useState<SitePreview | null>(null);
  const problem = draftProblem(draft);
  const edit = (change: Partial<Draft>) => { setDraft({ ...draft, ...change }); setPreview(null); };
  const editSection = (key: number, change: { heading?: string; body?: string }) =>
    edit({ sections: draft.sections.map((section) => (section.key === key ? { ...section, ...change } : section)) });

  const showPreview = useMutation({
    mutationFn: () => api.previewSite(site.id, specFrom(draft)),
    onSuccess: setPreview,
  });
  const publish = useMutation({
    mutationFn: (spec: SiteSpec) => api.publishSite(site.id, spec, { idempotencyKey: intents.keyFor({ siteId: site.id, spec }) }),
    onSettled: (_result, error, spec) => intents.settle({ siteId: site.id, spec }, error),
    onSuccess: (response) => onPublished(response.edge === "pending"),
  });
  const busy = showPreview.isPending || publish.isPending;
  const error = publish.error ?? showPreview.error;

  return (
    <DialogContent title="Edit site" description="Change the words, preview the page, then publish. Earlier versions stay in History.">
      {preview ? (
        <div className="space-y-4">
          <PreviewFrame preview={preview} />
          <Button variant="secondary" onClick={() => setPreview(null)}><PencilSimple aria-hidden />Back to editing</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!problem) showPreview.mutate(); }}>
          <div>
            <Label htmlFor="site-title">Site title</Label>
            <Input id="site-title" value={draft.title} maxLength={120} onChange={(event) => edit({ title: event.target.value })} />
          </div>
          <div>
            <Label htmlFor="site-tagline">Tagline</Label>
            <Input id="site-tagline" value={draft.tagline} maxLength={200} onChange={(event) => edit({ tagline: event.target.value })} />
          </div>
          {draft.sections.map((section, index) => (
            <fieldset key={section.key} className="space-y-3 rounded-sm p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
              <legend className="px-1 text-sm font-medium text-fg">Section {index + 1}</legend>
              <div>
                <Label htmlFor={`section-${section.key}-heading`}>Heading</Label>
                <Input id={`section-${section.key}-heading`} value={section.heading} maxLength={120}
                  onChange={(event) => editSection(section.key, { heading: event.target.value })} />
              </div>
              <div>
                <Label htmlFor={`section-${section.key}-body`}>Text</Label>
                <Textarea id={`section-${section.key}-body`} value={section.body} maxLength={2000}
                  onChange={(event) => editSection(section.key, { body: event.target.value })} />
              </div>
              <Button variant="ghost" onClick={() => edit({ sections: draft.sections.filter((item) => item.key !== section.key) })}>
                <Trash aria-hidden />Remove section {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button variant="secondary" disabled={draft.sections.length >= MAX_SECTIONS}
            aria-describedby={draft.sections.length >= MAX_SECTIONS ? "sections-full" : undefined}
            onClick={() => edit({ sections: [...draft.sections, { key: nextKey++, heading: "", body: "" }] })}>
            <Plus aria-hidden />Add section
          </Button>
          {draft.sections.length >= MAX_SECTIONS ? <DisabledReason id="sections-full">A page holds {MAX_SECTIONS} sections at most.</DisabledReason> : null}
          {/* Submitting the form previews; Enter in a field never publishes. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
      {error ? <div className="mt-4"><ErrorNote error={error} /></div> : null}
      {problem ? <div className="mt-4"><DisabledReason id="publish-why">{problem}</DisabledReason></div> : null}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {preview ? null : (
          <Button variant="secondary" disabled={busy || problem !== null} aria-busy={showPreview.isPending}
            aria-describedby={problem ? "publish-why" : undefined} onClick={() => showPreview.mutate()}>
            <Eye aria-hidden />{showPreview.isPending ? "Building preview" : "Preview"}
          </Button>
        )}
        <Button disabled={busy || problem !== null} aria-busy={busy}
          aria-describedby={problem ? "publish-why" : undefined} onClick={() => publish.mutate(specFrom(draft))}>
          {publish.isPending ? "Publishing" : "Publish"}
        </Button>
      </div>
    </DialogContent>
  );
}

function RollbackDialog({ site, release, version, onClose, onActivated }: {
  site: SiteRecord;
  release: SiteReleaseRecord;
  version: number;
  onClose: () => void;
  onActivated: (pending: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const input = { siteId: site.id, releaseId: release.id, expectedCurrentReleaseId: site.currentReleaseId };
  const activate = useMutation({
    mutationFn: () => api.activateSiteRelease(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: (_result, error) => {
      intents.settle(input, error);
      void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
    },
    onSuccess: (response) => {
      toast(response.edge === "pending"
        ? `Version ${version} is live. Your site will show it in a moment.`
        : `Version ${version} is live again.`, response.edge === "pending" ? "info" : "success");
      onActivated(response.edge === "pending");
      onClose();
    },
    onError: (error) => {
      if (!isStaleRelease(error)) return;
      toast("Another version went live since you opened this page. History is up to date now.", "info");
      onClose();
    },
  });
  return (
    <DialogContent title={`Make version ${version} live?`} description={`Published ${relativeTime(release.createdAt).toLowerCase()}. Visitors see it as soon as it is live.`}>
      {activate.isError && !isStaleRelease(activate.error) ? <div className="mb-4"><ErrorNote error={activate.error} /></div> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={activate.isPending} aria-busy={activate.isPending} onClick={() => activate.mutate()}>
          <ArrowCounterClockwise aria-hidden />{activate.isPending ? "Making it live" : `Make version ${version} live`}
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
    <EmptyState title="No website yet">
      <form className="mx-auto mt-4 max-w-sm space-y-3 text-left" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate(name.trim()); }}>
        <div>
          <Label htmlFor="site-name">Website name</Label>
          <Input id="site-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </div>
        {create.isError ? <ErrorNote error={create.error} /> : null}
        {name.trim() ? null : <DisabledReason id="site-name-why">Name your website first.</DisabledReason>}
        <Button type="submit" disabled={!name.trim() || create.isPending} aria-busy={create.isPending}
          aria-describedby={name.trim() ? undefined : "site-name-why"}>{create.isPending ? "Creating" : "Create website"}</Button>
      </form>
    </EmptyState>
  );
}

function SitePanel({ site }: { site: SiteRecord }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const releases = useSiteReleases(site.id);
  const live = useSiteRelease(site.id, site.currentReleaseId);
  const [editing, setEditing] = useState(false);
  const [rollingBack, setRollingBack] = useState<{ release: SiteReleaseRecord; version: number } | null>(null);
  const [pending, setPending] = useState(false);
  const sync = useMutation({
    mutationFn: () => api.syncSite(site.id),
    onSuccess: (response) => {
      setPending(response.edge === "pending");
      if (response.edge === "synced") toast("Your site shows the live version now.");
    },
  });
  const host = site.hosts[0] ?? null;
  const count = releases.data?.length ?? 0;
  const liveVersion = releases.data ? count - releases.data.findIndex((release) => release.id === site.currentReleaseId) : null;

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
          <h2 className="text-base font-semibold">{site.name}</h2>
          {site.currentReleaseId ? <Badge tone="success">Live</Badge> : <Badge tone="warn">Not published</Badge>}
        </div>
        <p className="text-sm text-muted" data-testid="site-live-summary">
          {site.currentReleaseId && live.data
            ? `Version ${liveVersion ?? "?"} is live. Published ${relativeTime(live.data.createdAt).toLowerCase()}.`
            : site.currentReleaseId ? "Loading the live version." : "Write your first page and publish it."}
        </p>
        {live.isError ? <ErrorNote error={live.error} retry={() => live.refetch()} /> : null}
        {pending ? (
          <div className="rounded-sm bg-warn/10 p-3 text-sm text-fg-2" role="status">
            <p>Saved and live here, but your site still shows the previous version.</p>
            <Button className="mt-2" variant="secondary" disabled={sync.isPending} aria-busy={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? "Updating" : "Update the site now"}
            </Button>
          </div>
        ) : null}
        <Button disabled={site.currentReleaseId !== null && !live.data} aria-busy={site.currentReleaseId !== null && live.isPending}
          onClick={() => setEditing(true)}>
          <PencilSimple aria-hidden />Edit site
        </Button>
      </Card>

      <section aria-labelledby="site-history-title">
        <h2 id="site-history-title" className="mb-3 text-base font-semibold">History</h2>
        {releases.isPending ? <LoadingRows rows={3} label="Loading versions" /> : releases.isError ? (
          <ErrorNote error={releases.error} retry={() => releases.refetch()} />
        ) : releases.data.length === 0 ? (
          <p className="text-sm text-muted">Each time you publish, the version you replaced stays here, ready to bring back.</p>
        ) : (
          <ul className="space-y-2">
            {releases.data.map((release, index) => {
              const version = count - index;
              const isLive = release.id === site.currentReleaseId;
              return (
                <li key={release.id} data-testid="site-release">
                  <Card className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">Version {version}</p>
                        {isLive ? <Badge tone="success">Live</Badge> : null}
                      </div>
                      <p className="text-xs text-meta">Published {relativeTime(release.createdAt).toLowerCase()}</p>
                    </div>
                    {isLive ? null : (
                      <Button variant="secondary" onClick={() => setRollingBack({ release, version })}>
                        <ArrowCounterClockwise aria-hidden />Make live<span className="sr-only"> version {version}</span>
                      </Button>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing ? (
          <SiteEditor
            site={site}
            liveSpec={live.data?.spec}
            onClose={() => setEditing(false)}
            onPublished={(wasPending) => {
              setEditing(false);
              setPending(wasPending);
              void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
              toast(wasPending ? "Published. Your site will show it in a moment." : "Published. Your site is live.", wasPending ? "info" : "success");
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={rollingBack !== null} onOpenChange={(open) => !open && setRollingBack(null)}>
        {rollingBack ? (
          <RollbackDialog site={site} release={rollingBack.release} version={rollingBack.version}
            onClose={() => setRollingBack(null)} onActivated={setPending} />
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
