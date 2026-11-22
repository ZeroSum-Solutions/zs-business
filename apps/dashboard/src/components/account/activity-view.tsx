"use client";

import { ArrowLeft, CaretRight, GearSix, Robot, SealCheck, UserCircle } from "@phosphor-icons/react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ActionLogEntry } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tray, TrayBody, TrayHeader, TrayTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { actionLabel, actorLabel, approvalBadge, outcomeLabel, recordLabel, shortId } from "@/lib/action-log";
import { useActionLog, useActionReceipt, useDisplayZone } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { formatDay, formatTime } from "@/lib/time";

/** Backlog B05: the log is an owner's record; staff never see it. */
export const ACTIVITY_OWNER_ONLY = "Only an owner can see the activity log.";
export const ACTIVITY_DESCRIPTION = "Every action in your business, who did it and how it ended. Message text and addresses stay out of this list.";

export const receiptHref = (id: string) => `/account/activity/${encodeURIComponent(id)}`;

function ActorIcon({ actor }: { actor: ActionLogEntry["actor"] }) {
  const Icon = actor.kind === "agent" ? Robot : actor.kind === "system" ? GearSix : UserCircle;
  return <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-tray text-accent-ink"><Icon size={18} /></span>;
}

function useWhen() {
  const zone = useDisplayZone();
  return (at: string) => `${formatDay(at, zone)}, ${formatTime(at, zone)}`;
}

/**
 * One action. Every row opens its receipt; a row that ran under an approval is an approval card,
 * marked with its approval status.
 */
function ActionRow({ entry }: { entry: ActionLogEntry }) {
  const when = useWhen();
  const approval = entry.approval ? approvalBadge(entry.approval) : null;
  return (
    <li>
      <Link
        href={receiptHref(entry.id)}
        data-action={entry.id}
        data-approval-card={entry.approval ? "" : undefined}
        className="flex min-h-14 w-full items-center gap-3 rounded-md bg-surface p-3 text-left shadow-card transition-quick hover:bg-tray"
      >
        <ActorIcon actor={entry.actor} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold text-fg">{actionLabel(entry.actionType)}</span>
          <span className="block truncate text-sm text-muted">{actorLabel(entry.actor)} · {when(entry.createdAt)}</span>
          {approval ? (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge tone={approval.tone}><SealCheck aria-hidden />{approval.label}</Badge>
              <Badge tone="neutral">Receipt</Badge>
            </span>
          ) : null}
        </span>
        <Badge tone="neutral">{outcomeLabel(entry.outcome)}</Badge>
        <CaretRight size={16} aria-hidden className="shrink-0 text-meta" />
      </Link>
    </li>
  );
}

function OwnerOnly() {
  return <EmptyState title="Owners only">{ACTIVITY_OWNER_ONLY}</EmptyState>;
}

export function ActivityView() {
  const owner = useCan("reports");
  const log = useActionLog(owner);
  const entries = log.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      {!owner ? <OwnerOnly /> : (
        <Tray aria-labelledby="activity-list-title" aria-busy={log.isPending}>
          <TrayHeader><TrayTitle id="activity-list-title">Recent actions</TrayTitle></TrayHeader>
          <TrayBody className="px-2 pb-2">
            {log.isPending ? <LoadingRows rows={5} label="Loading actions" /> : null}
            {log.isError ? <ErrorNote error={log.error} retry={() => void log.refetch()} /> : null}
            {log.isSuccess && entries.length === 0 ? <EmptyState title="Nothing yet">Actions show here as you and your agents work.</EmptyState> : null}
            {entries.length > 0 ? (
              <ul className="grid grid-cols-1 gap-1.5 lg:gap-2" aria-label="Actions">
                {entries.map((entry) => <ActionRow key={entry.id} entry={entry} />)}
              </ul>
            ) : null}
            {log.hasNextPage ? (
              <Button variant="secondary" className="mt-1" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                {log.isFetchingNextPage ? "Loading" : "Show older"}
              </Button>
            ) : null}
          </TrayBody>
        </Tray>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere] text-fg">{children}</dd>
    </div>
  );
}

/** One action's receipt: the same redacted fields, with the full IDs of the record and the approval. */
export function ReceiptView({ id }: { id: string }) {
  const owner = useCan("reports");
  const receipt = useActionReceipt(id, owner);
  const when = useWhen();
  const entry = receipt.data;
  return (
    <>
      <PageHeader
        title="Receipt"
        description="What ran, who ran it, the record it touched and how it ended."
        actions={
          <Link href="/account/activity" className="inline-flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-bold text-muted hover:bg-tray hover:text-fg">
            <ArrowLeft size={16} aria-hidden /> Activity
          </Link>
        }
      />
      {!owner ? <OwnerOnly /> : (
        <Tray aria-labelledby="receipt-title" aria-busy={receipt.isPending}>
          <TrayHeader><TrayTitle id="receipt-title">{entry ? actionLabel(entry.actionType) : "Action"}</TrayTitle></TrayHeader>
          <div className="px-2 pb-2">
            {receipt.isPending ? <LoadingRows rows={4} label="Loading receipt" /> : null}
            {receipt.isError ? <ErrorNote error={receipt.error} retry={() => void receipt.refetch()} /> : null}
            {entry ? (
              <dl data-receipt={entry.id} className="divide-y divide-border-soft rounded-md bg-surface px-3 shadow-card">
                <Field label="By">{actorLabel(entry.actor)}</Field>
                <Field label="When">{when(entry.createdAt)}</Field>
                <Field label="Outcome"><Badge tone="neutral">{outcomeLabel(entry.outcome)}</Badge></Field>
                <Field label="Record">{recordLabel(entry.target.type)} <span className="font-normal text-muted">{entry.target.id}</span></Field>
                <Field label="Approval">
                  {entry.approval ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={approvalBadge(entry.approval).tone}>{approvalBadge(entry.approval).label}</Badge>
                      <span className="font-normal text-muted">{entry.approval.id}</span>
                    </span>
                  ) : "None needed"}
                </Field>
                <Field label="Action type"><code className="font-normal">{entry.actionType}</code></Field>
                <Field label="Receipt ID"><span className="font-normal text-muted" title={entry.id}>{shortId(entry.id)}</span></Field>
              </dl>
            ) : null}
          </div>
        </Tray>
      )}
    </>
  );
}
