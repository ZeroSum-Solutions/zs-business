"use client";

import { ArrowSquareOut, Copy, Globe } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tray, TrayHeader, TrayTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import type { BookingPageSummary } from "@/lib/api";
import { useBookingPages } from "@/lib/queries";

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
          className="w-full resize-none rounded-md bg-well p-3 font-mono shadow-field text-xs focus:shadow-[inset_0_0_0_1px_var(--accent)] text-fg-2"
        />
        <Button variant="secondary" className="mt-2" onClick={() => copy(page[snippet], "embed code")}><Copy aria-hidden />Copy embed code</Button>
      </div>
    </li>
  );
}
