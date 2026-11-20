"use client";

import { ArrowSquareOut, Copy, Globe, PencilSimple } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tray, TrayHeader, TrayTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ErrorNote } from "@/components/ui/states";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { isApiError, type BookingPageChanges, type BookingPageSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import {
  BOOKING_PAGE_MESSAGES,
  pageFieldFromIssuePath,
  readBookingPageForm,
  toBookingPageForm,
  type BookingPageForm,
  type BookingPageFormErrors,
} from "@/lib/booking-page-form";
import { useIntentKey } from "@/lib/intent-key";
import { useBookingPages, useKeys } from "@/lib/queries";

const EMBED_OPTIONS = [{ value: "embedScript", label: "Widget" }, { value: "embedIframe", label: "Plain iframe" }] as const;

type Snippet = "embedScript" | "embedIframe";

/**
 * The owner's public booking pages, with what to paste into any website (public-intake.md P-14).
 * Bookings made there land in this calendar, marked as from the website.
 */
export function BookingPageCard() {
  const pages = useBookingPages();
  // A business without pages, or an API without public booking, shows nothing here.
  if (!pages.isSuccess || pages.data.length === 0) return null;
  return (
    <Tray className="mt-4" aria-labelledby="booking-pages-title">
      <TrayHeader>
        <div>
          <TrayTitle id="booking-pages-title">Booking on your website</TrayTitle>
          <p className="text-caption text-muted">Customers can book on this page or in a widget on any site. Their bookings show here, marked Website.</p>
        </div>
      </TrayHeader>
      <ul className="grid gap-1.5 lg:gap-2">{pages.data.map((page) => <PageRow key={page.id} page={page} />)}</ul>
    </Tray>
  );
}

function PageRow({ page }: { page: BookingPageSummary }) {
  const toast = useToast();
  const [snippet, setSnippet] = useState<Snippet>("embedScript");
  const [editing, setEditing] = useState(false);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied the ${what}.`);
    } catch {
      toast(`Could not copy. Select the ${what} and copy it by hand.`, "danger");
    }
  };
  return (
    <li data-testid="booking-page" className="card p-4 lg:px-6 lg:py-5">
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={20} aria-hidden className="text-meta" />
        <p className="font-bold text-fg">{page.title}</p>
        <Badge tone={page.published ? "success" : "neutral"} live={page.published}>{page.published ? "Live" : "Not published"}</Badge>
      </div>
      {editing ? (
        <PageEditForm page={page} onDone={() => setEditing(false)} />
      ) : (
        <div className="mt-2">
          {page.description ? (
            <p data-testid="booking-page-description" className="whitespace-pre-line text-sm text-fg-2">{page.description}</p>
          ) : (
            <p className="text-sm text-meta">No description. Customers see only the title.</p>
          )}
          <Button variant="secondary" className="mt-2" onClick={() => setEditing(true)}><PencilSimple aria-hidden />Edit details</Button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <a href={page.bookingUrl} target="_blank" rel="noreferrer noopener">
            <ArrowSquareOut aria-hidden />Open booking page
          </a>
        </Button>
        <Button variant="secondary" onClick={() => copy(page.bookingUrl, "booking link")}><Copy aria-hidden />Copy link</Button>
      </div>
      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <p aria-hidden className="text-sm font-bold text-fg-2">Embed code</p>
          <Segmented label="Embed code" value={snippet} options={EMBED_OPTIONS} onChange={setSnippet} />
        </div>
        <label htmlFor={`embed-${page.id}`} className="sr-only">Embed code to paste into your website</label>
        <textarea
          id={`embed-${page.id}`}
          readOnly
          rows={3}
          value={page[snippet]}
          onFocus={(event) => event.currentTarget.select()}
          // Grows to fit the code, so nothing is cut off on a phone; three rows where browsers cannot size to content.
          className="field-sizing-content w-full min-w-0 max-w-full resize-none break-all rounded-md bg-well p-3 font-mono shadow-field text-xs focus:shadow-[inset_0_0_0_1px_var(--accent)] text-fg-2"
        />
        <Button variant="secondary" className="mt-2" onClick={() => copy(page[snippet], "embed code")}><Copy aria-hidden />Copy embed code</Button>
      </div>
    </li>
  );
}

/** P-24: the owner changes a page's title and description after it is created. */
function PageEditForm({ page, onDone }: { page: BookingPageSummary; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const [form, setForm] = useState<BookingPageForm>(() => toBookingPageForm(page));
  const [errors, setErrors] = useState<BookingPageFormErrors>({});
  const idBase = `page-${page.id}`;

  const save = useMutation({
    mutationFn: (changes: BookingPageChanges) =>
      api.updateBookingPage(page.id, changes, { idempotencyKey: intents.keyFor({ pageId: page.id, changes }) }),
    onSettled: (_result, error, changes) => intents.settle({ pageId: page.id, changes }, error),
    onSuccess: async () => {
      // The list and the setup read both carry the page's title; read them again.
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: keys.bookingPages }),
        queryClient.invalidateQueries({ queryKey: keys.setup }),
      ]);
      toast("Booking page saved.");
      onDone();
    },
    onError: (error) => {
      if (!isApiError(error, "validation")) return;
      const issues = Array.isArray(error.details.issues) ? error.details.issues : [];
      const next: BookingPageFormErrors = {};
      for (const issue of issues) {
        const path = (issue as { path?: unknown } | null)?.path;
        const field = typeof path === "string" ? pageFieldFromIssuePath(path) : null;
        if (field) next[field] = BOOKING_PAGE_MESSAGES[field];
      }
      setErrors(next);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = readBookingPageForm(page, form);
    if (!read.ok) {
      setErrors(read.errors);
      document.getElementById(read.errors.title ? `${idBase}-title` : `${idBase}-description`)?.focus();
      return;
    }
    setErrors({});
    if (Object.keys(read.changes).length === 0) {
      onDone();
      return;
    }
    save.mutate(read.changes);
  };

  const describedBy = (field: keyof BookingPageForm) => (errors[field] ? `${idBase}-${field}-error` : undefined);
  return (
    <form className="mt-3 space-y-3" onSubmit={submit} noValidate aria-label={`Edit ${page.title}`}>
      <fieldset disabled={save.isPending} className="space-y-3">
        <div>
          <Label htmlFor={`${idBase}-title`}>Title</Label>
          <Input
            id={`${idBase}-title`}
            value={form.title}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy("title")}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          {errors.title ? <p id={`${idBase}-title-error`} className="mt-1 text-xs text-danger">{errors.title}</p> : null}
        </div>
        <div>
          <Label htmlFor={`${idBase}-description`}>Description</Label>
          <Textarea
            id={`${idBase}-description`}
            rows={4}
            value={form.description}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy("description")}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
          {errors.description ? <p id={`${idBase}-description-error`} className="mt-1 text-xs text-danger">{errors.description}</p> : null}
          <p className="mt-1 text-xs text-meta">Shown to customers on the booking page. Leave empty to show none.</p>
        </div>
      </fieldset>
      {save.isError && !isApiError(save.error, "validation") ? <ErrorNote error={save.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>Save details</Button>
        <Button type="button" variant="secondary" disabled={save.isPending} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
