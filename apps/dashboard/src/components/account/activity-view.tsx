"use client";

import { ArrowLeft, CaretRight, GearSix, Robot, SealCheck, UserCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionLogEntry } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tray, TrayBody, TrayHeader, TrayTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { isApiError } from "@/lib/api";
import { actionLabel, actorLabel, approvalBadge, outcomeLabel, recordHref, recordLabel, shortId } from "@/lib/action-log";
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

type When = (at: string) => ReactNode;

/** "Sun, Nov 22, 7:00 PM"; the year is added when it is not this year, so an old row reads true. */
function useWhen(): When {
  const zone = useDisplayZone();
  const year = (at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(at);
  const thisYear = year(new Date());
  return (at: string) => {
    const then = year(new Date(at));
    return <time dateTime={at}>{formatDay(at, zone)}{then === thisYear ? "" : `, ${then}`}, {formatTime(at, zone)}</time>;
  };
}

/**
 * One action. Every row opens its receipt; a row that ran under an approval is an approval card,
 * marked with where that approval stands today.
 */
function ActionRow({ entry, when }: { entry: ActionLogEntry; when: When }) {
  const approval = entry.approval ? approvalBadge(entry.approval) : null;
  return (
    <li>
      <Link
        href={receiptHref(entry.id)}
        data-action={entry.id}
        data-approval-card={entry.approval ? "" : undefined}
        className="flex min-h-14 w-full items-center gap-3 rounded-md bg-surface p-3 text-left shadow-card transition-quick hover:shadow-card-hover"
      >
        <ActorIcon actor={entry.actor} />
        <span className="min-w-0 flex-1">
          <span className="block font-bold [overflow-wrap:anywhere] text-fg">{actionLabel(entry.actionType)}</span>
          <span className="block text-sm text-muted">{actorLabel(entry.actor)} · <span className="whitespace-nowrap">{when(entry.createdAt)}</span></span>
          <span className="block text-sm text-meta">{recordLabel(entry.target.type)} {shortId(entry.target.id)}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="neutral">{outcomeLabel(entry.outcome)}</Badge>
            {approval ? (
              <>
                <Badge tone={approval.tone}><SealCheck aria-hidden />{approval.label}</Badge>
                <Badge tone="neutral">Receipt</Badge>
              </>
            ) : null}
          </span>
        </span>
        <CaretRight size={16} aria-hidden className="shrink-0 text-meta" />
      </Link>
    </li>
  );
}

function OwnerOnly() {
  return <EmptyState title="Owners only">{ACTIVITY_OWNER_ONLY}</EmptyState>;
}

/** True once the API refused this viewer; a later error of another kind does not bring rows back. */
function useDenied(owner: boolean, error: unknown): boolean {
  const [refused, setRefused] = useState(false);
  const forbidden = isApiError(error, "forbidden");
  useEffect(() => { if (forbidden) setRefused(true); }, [forbidden]);
  return !owner || refused || forbidden;
}

export function ActivityView() {
  const owner = useCan("reports");
  const log = useActionLog(owner);
  const when = useWhen();
  const list = useRef<HTMLUListElement>(null);
  // "Show older" goes away after the last page; focus moves to the first row it added.
  const focusFrom = useRef<number | null>(null);
  const entries = log.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    if (focusFrom.current === null || entries.length <= focusFrom.current) return;
    list.current?.querySelectorAll<HTMLAnchorElement>("a[data-action]")[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [entries.length]);
  // A 403 after a role change hides what was loaded before it.
  const denied = useDenied(owner, log.error);
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      {denied ? <OwnerOnly /> : (
        <Tray aria-labelledby="activity-list-title" aria-busy={log.isPending}>
          <TrayHeader><TrayTitle id="activity-list-title">Recent actions</TrayTitle></TrayHeader>
          <TrayBody className="px-2 pb-2">
            {log.isPending ? <LoadingRows rows={5} label="Loading actions" /> : null}
            {log.isError && !log.isFetchNextPageError ? <ErrorNote error={log.error} retry={() => void log.refetch()} /> : null}
            {log.isSuccess && entries.length === 0 ? <EmptyState title="Nothing yet">Actions show here as you and your agents work.</EmptyState> : null}
            {entries.length > 0 ? (
              <ul ref={list} className="grid grid-cols-1 gap-1.5 lg:gap-2" aria-label="Actions">
                {entries.map((entry) => <ActionRow key={entry.id} entry={entry} when={when} />)}
              </ul>
            ) : null}
            {/* A failed "Show older" keeps the rows already shown, with the error under them. */}
            {log.isFetchNextPageError ? <div className="mt-2"><ErrorNote error={log.error} retry={() => void log.fetchNextPage()} /></div> : null}
            {log.hasNextPage ? (
              <Button
                variant="secondary"
                className="mt-1"
                onClick={() => { focusFrom.current = entries.length; void log.fetchNextPage(); }}
                disabled={log.isFetchingNextPage}
                aria-busy={log.isFetchingNextPage}
              >
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

function ActorField({ actor }: { actor: ActionLogEntry["actor"] }) {
  // Two staff members read apart by member ID. The role shown is the member's role today.
  if (actor.kind !== "person" || actor.memberId === null) return <>{actorLabel(actor)}</>;
  return <>{actorLabel(actor)} <span className="font-normal text-muted">(role today) · member {shortId(actor.memberId)}</span></>;
}

/** One action's receipt: the same redacted fields, with the full IDs of the record and the approval. */
export function ReceiptView({ id }: { id: string }) {
  const owner = useCan("reports");
  const receipt = useActionReceipt(id, owner);
  const when = useWhen();
  const denied = useDenied(owner, receipt.error);
  const entry = receipt.isError ? undefined : receipt.data;
  const record = entry ? recordHref(entry.target) : null;
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
      {denied ? <OwnerOnly /> : (
        <Tray aria-labelledby="receipt-title" aria-busy={receipt.isPending}>
          <TrayHeader><TrayTitle id="receipt-title">{entry ? actionLabel(entry.actionType) : "Action"}</TrayTitle></TrayHeader>
          <div className="px-2 pb-2">
            {receipt.isPending ? <LoadingRows rows={4} label="Loading receipt" /> : null}
            {receipt.isError ? <ErrorNote error={receipt.error} retry={isApiError(receipt.error, "not_found") ? undefined : () => void receipt.refetch()} /> : null}
            {entry ? (
              <dl data-receipt={entry.id} className="divide-y divide-border-soft rounded-md bg-surface px-3 shadow-card">
                <Field label="By"><ActorField actor={entry.actor} /></Field>
                <Field label="When">{when(entry.createdAt)}</Field>
                <Field label="Outcome"><Badge tone="neutral">{outcomeLabel(entry.outcome)}</Badge></Field>
                <Field label="Record">
                  {record ? (
                    <Link href={record} className="text-accent-ink underline-offset-4 hover:underline">{recordLabel(entry.target.type)}</Link>
                  ) : recordLabel(entry.target.type)}{" "}
                  <span className="font-normal text-muted">{entry.target.id}</span>
                </Field>
                <Field label="Approval">
                  {entry.approval ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={approvalBadge(entry.approval).tone}>{approvalBadge(entry.approval).label}</Badge>
                      <span className="font-normal text-muted">as it stands today · {entry.approval.id}</span>
                    </span>
                  ) : "None needed"}
                </Field>
                <Field label="Action type"><code className="font-normal">{entry.actionType}</code></Field>
                <Field label="Receipt ID"><span className="font-normal text-muted">{entry.id}</span></Field>
              </dl>
            ) : null}
          </div>
        </Tray>
      )}
    </>
  );
}
