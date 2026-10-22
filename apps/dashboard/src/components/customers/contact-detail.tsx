"use client";

import { ArrowLeft, Envelope, Info, Phone } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, IncompleteNote, LoadingRows } from "@/components/ui/states";
import { isApiError, type ConsentEvidence } from "@/lib/api";
import { browserZone, useContact, useDeals, usePipelines } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { formatPhone, relativeTime } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";

// No business time zone exists yet, so dates show in the viewer's own zone.
function ConsentLine({ label, evidence }: { label: string; evidence: ConsentEvidence | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-meta">{evidence ? `${evidence.source}, ${formatDay(evidence.recordedAt, browserZone())}` : "No record yet"}</p>
      </div>
      {evidence === null ? <Badge>Not asked</Badge> : evidence.status === "granted" ? <Badge tone="success">Allowed</Badge> : <Badge tone="danger">Declined</Badge>}
    </div>
  );
}

export function ContactDetail({ id }: { id: string }) {
  const params = useSearchParams();
  const existing = params.get("existing") === "1";
  const contact = useContact(id);
  const deals = useDeals({ contactId: id });
  const pipelines = usePipelines();
  const stageName = (pipelineId: string, stageId: string) =>
    pipelines.data?.find((pipeline) => pipeline.id === pipelineId)?.stages.find((stage) => stage.id === stageId)?.name ?? "Stage";

  return (
    <>
      <Link href="/customers" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm font-medium text-muted hover:text-fg">
        <ArrowLeft size={16} aria-hidden /> Customers
      </Link>
      {contact.isPending ? <LoadingRows rows={4} label="Loading customer" /> : contact.isError ? (
        isMissing(contact.error) ? <ContactMissing /> : <ErrorNote error={contact.error} retry={() => contact.refetch()} />
      ) : (
        <>
          {existing ? (
            <div role="status" className="mb-4 flex items-start gap-3 rounded-md bg-accent-tint p-3 text-sm text-fg">
              <Info size={20} aria-hidden className="mt-px shrink-0 text-accent" />
              <p>Already a customer. This is their existing record, so nothing was duplicated.</p>
            </div>
          ) : null}
          <header className="mb-6 flex items-center gap-4">
            <Avatar name={contact.data.displayName ?? contact.data.email} size="lg" />
            <div className="min-w-0">
              <h1 className="text-2xl leading-tight font-extrabold break-words tracking-display lg:text-3xl">{contact.data.displayName ?? "Unnamed customer"}</h1>
              <p className="text-sm text-muted">Customer since {formatDay(contact.data.createdAt, browserZone())}</p>
            </div>
          </header>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card aria-labelledby="deals-title">
              <CardHeader><CardTitle id="deals-title">Deals</CardTitle></CardHeader>
              {deals.isPending ? <LoadingRows rows={2} /> : deals.isError ? <ErrorNote error={deals.error} retry={() => deals.refetch()} /> : deals.data.items.length === 0 ? (
                <EmptyState title="No deals yet">Deals for this customer show here.</EmptyState>
              ) : (
                <>
                <IncompleteNote list={deals.data} />
                <ul className="divide-y divide-border-soft">
                  {deals.data.items.map((deal) => (
                    <li key={deal.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words text-fg">{deal.title}</p>
                        <p className="text-xs text-meta">Updated {relativeTime(deal.updatedAt).toLowerCase()}</p>
                      </div>
                      <Badge tone="accent">{stageName(deal.pipelineId, deal.stageId)}</Badge>
                    </li>
                  ))}
                </ul>
                </>
              )}
            </Card>
            <div className="space-y-4">
              <Card aria-labelledby="reach-title">
                <CardHeader><CardTitle id="reach-title">Contact</CardTitle></CardHeader>
                <ul className="space-y-1">
                  {contact.data.email ? (
                    <li><a href={`mailto:${contact.data.email}`} className="flex min-h-11 items-center gap-3 text-sm text-fg hover:text-accent"><Envelope size={20} aria-hidden className="text-muted" />{contact.data.email}</a></li>
                  ) : null}
                  {contact.data.phone ? (
                    <li><a href={`tel:${contact.data.phone}`} className="flex min-h-11 items-center gap-3 text-sm text-fg hover:text-accent"><Phone size={20} aria-hidden className="text-muted" />{formatPhone(contact.data.phone)}</a></li>
                  ) : null}
                </ul>
              </Card>
              <Card aria-labelledby="consent-title">
                <CardHeader><CardTitle id="consent-title">Marketing permission</CardTitle></CardHeader>
                <div className="divide-y divide-border-soft">
                  <ConsentLine label="Email" evidence={contact.data.consent.email} />
                  <ConsentLine label="Text messages" evidence={contact.data.consent.sms} />
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** A record this account cannot see, or an address that names none: retrying will not change it. */
const isMissing = (error: unknown) => isApiError(error, "forbidden") || isApiError(error, "not_found") || isApiError(error, "validation");

function ContactMissing() {
  return (
    <>
      <h1 className="mb-4 text-2xl leading-tight font-extrabold tracking-display lg:text-3xl">Customer not found</h1>
      <EmptyState title="We could not find that customer" action={<Link href="/customers" className="inline-flex min-h-11 items-center font-bold text-accent-ink underline-offset-4 hover:underline">Back to customers</Link>}>
        The link may be wrong, or this account cannot open that record.
      </EmptyState>
    </>
  );
}
