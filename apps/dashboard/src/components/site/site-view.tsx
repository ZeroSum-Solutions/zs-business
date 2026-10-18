"use client";

import { ArrowSquareOut, DeviceMobile, Image as ImageIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DisabledReason, NOT_AVAILABLE, useSampleOnly } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { SitePage } from "@/lib/api";
import { useSitePages } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";

function SlotEditor({ page, onClose }: { page: SitePage; onClose: () => void }) {
  const toast = useToast();
  const sampleOnly = useSampleOnly();
  const [values, setValues] = useState(() => Object.fromEntries(page.slots.map((slot) => [slot.id, slot.value])));
  const headline = values.headline ?? "";
  return (
    <DialogContent title={`Edit ${page.title}`} description="Change the words on this page. The layout stays as designed.">
      <div className="mb-5 overflow-hidden rounded-lg bg-surface-warm p-5" aria-label="Preview">
        <p className="text-xs text-meta">haldenrowe.example{page.path}</p>
        <p className="mt-3 text-xl font-semibold tracking-display text-fg">{headline}</p>
        {values.sub ? <p className="mt-2 text-sm text-fg-2">{values.sub}</p> : null}
        {values.cta ? <span className="mt-4 inline-flex min-h-10 items-center rounded-sm bg-fg px-4 text-sm font-medium text-bg">{values.cta}</span> : null}
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (sampleOnly) return;
          toast("Saved as a draft. Publish from the full editor.", "info");
          onClose();
        }}
      >
        {page.slots.map((slot) => (
          <div key={slot.id}>
            {/* An image slot has no text control, so its label names the group instead. */}
            {slot.kind === "image" ? (
              <p id={`slot-${slot.id}-label`} className="mb-1.5 block text-sm font-medium text-fg">{slot.label}</p>
            ) : (
              <Label htmlFor={`slot-${slot.id}`}>{slot.label}</Label>
            )}
            {slot.kind === "longtext" ? (
              <Textarea id={`slot-${slot.id}`} value={values[slot.id] ?? ""} onChange={(event) => setValues({ ...values, [slot.id]: event.target.value })} />
            ) : slot.kind === "image" ? (
              <div role="group" aria-labelledby={`slot-${slot.id}-label`} className="rounded-sm p-3 shadow-[inset_0_0_0_1px_var(--border-strong)]">
                <div className="flex items-center gap-3">
                  <ImageIcon size={24} aria-hidden className="shrink-0 text-muted" />
                  <p className="min-w-0 flex-1 text-sm break-words text-fg-2">{slot.value}</p>
                  <Button variant="secondary" disabled aria-describedby={`slot-${slot.id}-why`}>Replace</Button>
                </div>
                <div className="mt-2"><DisabledReason id={`slot-${slot.id}-why`}>Image changes open in the full editor, coming soon.</DisabledReason></div>
              </div>
            ) : (
              <Input id={`slot-${slot.id}`} value={values[slot.id] ?? ""} onChange={(event) => setValues({ ...values, [slot.id]: event.target.value })} />
            )}
          </div>
        ))}
        {sampleOnly ? <DisabledReason id="save-unavailable">{NOT_AVAILABLE}</DisabledReason> : null}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={sampleOnly} aria-describedby={sampleOnly ? "save-unavailable" : undefined}>Save draft</Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function SiteView() {
  const pages = useSitePages();
  const [editing, setEditing] = useState<SitePage | null>(null);
  return (
    <>
      <PageHeader
        title="Site"
        description="haldenrowe.example"
        sample
        actions={(
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button variant="secondary" disabled aria-describedby="view-site-why"><ArrowSquareOut aria-hidden />View site</Button>
            <DisabledReason id="view-site-why">Available once the site is published.</DisabledReason>
          </div>
        )}
      />
      {pages.isPending ? <LoadingRows rows={5} label="Loading pages" /> : pages.isError ? (
        <ErrorNote error={pages.error} retry={() => pages.refetch()} />
      ) : pages.data.length === 0 ? (
        <EmptyState title="No pages yet">Your first page appears here once the site is set up.</EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {pages.data.map((page) => (
            <li key={page.id}>
              <Card className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{page.title}</h2>
                    {page.status === "live" ? <Badge tone="success">Live</Badge> : <Badge tone="warn">Draft</Badge>}
                  </div>
                  <p className="truncate text-sm text-muted">{page.path}</p>
                  <p className="text-xs text-meta">Edited {relativeTime(page.updatedAt)}</p>
                </div>
                {/* Named by its content, so the visible words stay part of the name. */}
                <Button variant="secondary" onClick={() => setEditing(page)}>
                  <DeviceMobile aria-hidden />Edit<span className="sr-only"> {page.title}</span> on phone
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? <SlotEditor key={editing.id} page={editing} onClose={() => setEditing(null)} /> : null}
      </Dialog>
    </>
  );
}
