"use client";

import { ArrowLeft, Envelope, Info, Phone } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, IncompleteNote, LoadingRows } from "@/components/ui/states";
import type { ConsentEvidence } from "@/lib/api";
import { useContact, useDeals, usePipelines } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { formatPhone, initials, relativeTime } from "@/lib/utils";

function ConsentLine({ label, evidence }: { label: string; evidence: ConsentEvidence | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="text-xs text-meta">{evidence ? `${evidence.source}, ${formatDay(evidence.recordedAt, "America/New_York")}` : "No record yet"}</p>
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
        <ErrorNote error={contact.error} retry={() => contact.refetch()} />
      ) : (
        <>
          {existing ? (
            <div role="status" className="mb-4 flex items-start gap-3 rounded-md bg-accent/8 p-3 text-sm text-fg">
              <Info size={20} aria-hidden className="mt-px shrink-0 text-accent" />
              <p>Already a customer. This is their existing record, so nothing was duplicated.</p>
            </div>
          ) : null}
          <header className="mb-6 flex items-center gap-4">
            <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-pill bg-accent/12 text-lg font-semibold text-accent">
              {initials(contact.data.displayName ?? contact.data.email)}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl tracking-display lg:text-2xl">{contact.data.displayName ?? "Unnamed customer"}</h1>
              <p className="text-sm text-muted">Customer since {formatDay(contact.data.createdAt, "America/New_York")}</p>
            </div>
          </header>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card aria-labelledby="deals-title">
              <CardHeader><CardTitle id="deals-title">Commissions</CardTitle></CardHeader>
              {deals.isPending ? <LoadingRows rows={2} /> : deals.isError ? <ErrorNote error={deals.error} retry={() => deals.refetch()} /> : deals.data.items.length === 0 ? (
                <EmptyState title="No commissions yet">Deals for this customer show here.</EmptyState>
              ) : (
                <>
                <IncompleteNote list={deals.data} />
                <ul className="divide-y divide-border-soft">
                  {deals.data.items.map((deal) => (
                    <li key={deal.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium break-words text-fg">{deal.title}</p>
                        <p className="text-xs text-meta">Updated {relativeTime(deal.updatedAt)}</p>
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
