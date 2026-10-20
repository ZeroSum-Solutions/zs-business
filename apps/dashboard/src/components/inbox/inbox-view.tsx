"use client";

import { ArrowLeft, CalendarBlank, Globe, Info, PaperPlaneTilt } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import {
  isApiError,
  type NewReply,
  type ReplyRecord,
  type ReplyStatus,
  type RequestEntry,
  type ResourceSummary,
  type ThreadDetail,
  type ThreadSummary,
} from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useDisplayZone, useKeys, useResources, useThread, useThreads } from "@/lib/queries";
import { resourceLabel } from "@/lib/resources";
import { APPROVE_REPLIES, useCan } from "@/lib/session";
import { formatDay, formatTime, zonedDateKey } from "@/lib/time";
import { cn, formatPhone, initials, relativeTime } from "@/lib/utils";

export const QUEUED_MESSAGE = "Approved. The reply is queued for delivery.";
const CHANNEL_LABELS: Record<RequestEntry["channel"], string> = { booking_page: "Booking page", widget: "Website widget" };

/** Reply states as people read them; an approval is a queued send, never a sent one (I-6). */
export const REPLY_STATUS: Record<Exclude<ReplyStatus, "discarded">, { label: string; tone: "neutral" | "accent" | "success" | "danger" }> = {
  draft: { label: "Draft", tone: "neutral" },
  approved: { label: "Approved and queued", tone: "accent" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const actorName = (actor: ReplyRecord["draftedBy"] | null) => actor?.email ?? "a former team member";
const when = (instant: string, zone: string) => `${formatDay(instant, zone)}, ${formatTime(instant, zone)}`;

function ThreadBadges({ thread }: { thread: ThreadSummary }) {
  return (
    <>
      {thread.kind === "visitor" ? <Badge><Globe aria-hidden />Website visitor</Badge> : null}
      {thread.needsReply ? <Badge tone="warn">Needs reply</Badge> : null}
      {thread.needsReview ? <Badge tone="warn">Needs review</Badge> : null}
      {thread.drafts > 0 ? <Badge tone="accent">{thread.drafts === 1 ? "1 draft" : `${thread.drafts} drafts`}</Badge> : null}
    </>
  );
}

function ThreadList({ selectedId }: { selectedId: string | null }) {
  const threads = useThreads();
  if (threads.isPending) return <LoadingRows rows={6} label="Loading conversations" />;
  // A failed "Show more" keeps the pages already shown, with the error under them.
  if (threads.isError && !threads.isFetchNextPageError) return <ErrorNote error={threads.error} retry={() => threads.refetch()} />;
  const items = threads.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return <EmptyState title="No conversations yet">Website requests and your replies show here, one thread per customer.</EmptyState>;
  }
  return (
    <div>
      <ul aria-label="Conversations" className="divide-y divide-border-soft overflow-hidden rounded-md bg-surface shadow-ring">
        {items.map((thread) => {
          const active = thread.id === selectedId;
          return (
            <li key={thread.id} data-thread-id={thread.id}>
              <Link
                href={`/inbox/${thread.id}`}
                aria-current={active ? "true" : undefined}
                className={cn("focus-inset flex gap-3 px-4 py-3 transition-quick hover:bg-surface-warm", active && "bg-surface-warm shadow-[inset_2px_0_0_var(--accent)]")}
              >
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-surface-warm text-sm font-semibold text-fg-2">
                  {initials(thread.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-sm text-fg", thread.needsReply || thread.needsReview ? "font-semibold" : "font-medium")}>{thread.name}</span>
                    <time dateTime={thread.lastActivityAt} className="shrink-0 text-xs text-meta">{relativeTime(thread.lastActivityAt)}</time>
                  </span>
                  <span className="block truncate text-sm text-muted">{thread.preview ?? "No message"}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-meta"><ThreadBadges thread={thread} /></span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {threads.isFetchNextPageError ? <div className="mt-3"><ErrorNote error={threads.error} retry={() => threads.fetchNextPage()} /></div> : null}
      {threads.hasNextPage ? (
        <Button variant="secondary" className="mt-3 w-full" disabled={threads.isFetchingNextPage} aria-busy={threads.isFetchingNextPage} onClick={() => threads.fetchNextPage()}>
          Show more conversations
        </Button>
      ) : null}
    </div>
  );
}

function RequestBubble({ entry, zone, resources }: { entry: RequestEntry; zone: string; resources: ResourceSummary[] | undefined }) {
  const resource = entry.booking ? resources?.find((item) => item.id === entry.booking!.resourceId) : undefined;
  const bookingZone = resource?.timeZone ?? zone;
  return (
    <li className="flex flex-col items-start" data-entry="request">
      <div className="max-w-[85%] rounded-lg bg-surface-warm px-3.5 py-2.5 text-sm text-fg">
        <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium text-fg-2">
          <Globe size={14} aria-hidden />Website request · {CHANNEL_LABELS[entry.channel]}
        </p>
        {entry.notes ? (
          <p className="break-words whitespace-pre-wrap">{entry.notes}</p>
        ) : (
          <p className="text-muted">No message with this request.</p>
        )}
        {entry.booking ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <CalendarBlank size={16} aria-hidden className="text-muted" />
            <span>Booked {resource ? resourceLabel(resource) : "an appointment"} for</span>
            <Link
              href={`/calendar?date=${zonedDateKey(entry.booking.startsAt, bookingZone)}&calendar=${entry.booking.resourceId}`}
              className="inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline"
            >
              {when(entry.booking.startsAt, bookingZone)}
            </Link>
          </p>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-meta">{entry.name}, {when(entry.at, zone)}</p>
    </li>
  );
}

function ReplyBubble({ reply, zone, children }: { reply: ReplyRecord; zone: string; children?: ReactNode }) {
  const status = reply.status === "discarded" ? null : REPLY_STATUS[reply.status];
  return (
    <li className="flex flex-col items-end" data-entry="reply" data-reply-id={reply.id} data-status={reply.status}>
      <div className="max-w-[85%] rounded-lg bg-accent/10 px-3.5 py-2.5 text-sm text-fg">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs font-medium break-words text-fg-2"><span className="sr-only">Subject: </span>{reply.subject}</p>
          {/* Announced when it changes, such as a draft becoming approved and queued. */}
          <span aria-live="polite">{status ? <Badge tone={status.tone} data-testid="reply-status">{status.label}</Badge> : null}</span>
        </div>
        <p className="break-words whitespace-pre-wrap">{reply.body}</p>
      </div>
      <p className="mt-1 text-right text-xs text-meta">
        Drafted by {actorName(reply.draftedBy)}, {when(reply.createdAt, zone)}
        {reply.approvedAt ? <><br />Approved by {actorName(reply.approvedBy)}, {when(reply.approvedAt, zone)}</> : null}
        {reply.settledAt ? <><br />{reply.status === "failed" ? "Delivery failed" : "Delivered"} {when(reply.settledAt, zone)}</> : null}
      </p>
      {children}
    </li>
  );
}

type Step = { kind: "approve" | "discard"; replyId: string };

function ThreadEntries({ thread, zone }: { thread: ThreadDetail; zone: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const resources = useResources();
  const canApprove = useCan(APPROVE_REPLIES);
  const canDraft = useCan("inbox.drafts");
  const intents = useIntentKey();

  const step = useMutation({
    mutationFn: (input: Step) => {
      const options = { idempotencyKey: intents.keyFor(input) };
      return input.kind === "approve" ? api.approveReply(input.replyId, options) : api.discardReply(input.replyId, options);
    },
    onSettled: async (_reply, error, input) => {
      intents.settle(input, error);
      await queryClient.invalidateQueries({ queryKey: keys.inboxAll });
    },
    onSuccess: (_reply, input) => toast(input.kind === "approve" ? QUEUED_MESSAGE : "Draft discarded.", input.kind === "approve" ? "success" : "info"),
  });

  return (
    <>
      {thread.olderEntries ? <p className="px-4 pt-4 text-xs text-meta">Older messages are not shown. This shows the latest 200.</p> : null}
      {step.isError ? (
        <div className="px-4 pt-4" data-testid="reply-step-error">
          <ErrorNote error={step.error} message={isApiError(step.error, "conflict") ? `${step.error.message} The thread was reloaded.` : undefined} />
        </div>
      ) : null}
      <ol aria-label="Messages" className="flex-1 space-y-4 px-4 py-4">
        {thread.entries.map((entry) => entry.type === "request" ? (
          <RequestBubble key={`r-${entry.id}`} entry={entry} zone={zone} resources={resources.data} />
        ) : (
          <ReplyBubble key={`m-${entry.reply.id}`} reply={entry.reply} zone={zone}>
            {entry.reply.status === "draft" ? (
              <DraftActions
                reply={entry.reply}
                canApprove={canApprove}
                canDiscard={canDraft}
                busy={step.isPending && step.variables?.replyId === entry.reply.id}
                onStep={(kind) => step.mutate({ kind, replyId: entry.reply.id })}
              />
            ) : null}
          </ReplyBubble>
        ))}
      </ol>
    </>
  );
}

/**
 * What a member may do with a waiting draft: owners approve (it is then queued, not sent) or
 * discard it; staff may discard, and see that an owner approves it.
 */
export function DraftActions({ reply, canApprove, canDiscard, busy, onStep }: {
  reply: ReplyRecord;
  canApprove: boolean;
  canDiscard: boolean;
  busy: boolean;
  onStep: (kind: "approve" | "discard") => void;
}) {
  const note = `draft-note-${reply.id}`;
  return (
    <div className="mt-2 flex max-w-[85%] flex-col items-end gap-2">
      <p id={note} className="text-right text-xs text-muted">
        {canApprove ? "Approving queues it for delivery by email." : "Waiting for an owner to approve it before it is queued to send."}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        {canDiscard ? (
          <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => onStep("discard")}>Discard</Button>
        ) : null}
        {canApprove ? (
          <Button disabled={busy} aria-busy={busy} aria-describedby={note} onClick={() => onStep("approve")}>
            <PaperPlaneTilt aria-hidden />Approve and send
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ thread }: { thread: ThreadDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const canApprove = useCan(APPROVE_REPLIES);
  const intents = useIntentKey();
  const [form, setForm] = useState({ subject: "", body: "" });
  const [empty, setEmpty] = useState(false);
  const contactId = thread.contactId!;

  const save = useMutation({
    mutationFn: (input: NewReply) => api.draftReply(input, { idempotencyKey: intents.keyFor(input) }),
    onSettled: async (_reply, error, input) => {
      intents.settle(input, error);
      await queryClient.invalidateQueries({ queryKey: keys.inboxAll });
    },
    onSuccess: (_reply, input) => {
      // A later edit of the form must not be wiped by an earlier save landing.
      setForm((current) => (current.body.trim() === input.body && (current.subject.trim() || null) === input.subject ? { subject: "", body: "" } : current));
      toast(canApprove ? "Draft saved. Approve it to queue it for delivery." : "Draft saved. An owner approves it before it is queued to send.");
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = form.body.trim();
    if (!body) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    save.mutate({ contactId, subject: form.subject.trim() || null, body });
  };

  const help = canApprove
    ? "Saved as a draft first. You approve it before it is queued to send."
    : "Saved as a draft. An owner approves it before it is queued to send.";
  return (
    <form className="space-y-2 border-t border-border-soft p-3" onSubmit={submit} noValidate>
      {thread.email === null ? (
        <p className="flex items-start gap-2 rounded-md bg-warn/10 p-3 text-sm text-fg-2">
          <Info size={20} aria-hidden className="mt-px shrink-0 text-warn" />
          <span>This customer has no email address yet. You can draft a reply, but it can only be approved once their record has an email.</span>
        </p>
      ) : null}
      <div>
        <Label htmlFor="reply-subject">Subject (optional)</Label>
        <Input id="reply-subject" maxLength={200} placeholder="Message from Halden & Rowe" value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} />
      </div>
      <div>
        <Label htmlFor="reply">Reply to {thread.name}</Label>
        <Textarea
          id="reply"
          rows={3}
          maxLength={5000}
          className="min-h-20"
          value={form.body}
          aria-invalid={empty || isApiError(save.error, "validation") || undefined}
          aria-describedby="reply-help"
          onChange={(event) => setForm({ ...form, body: event.target.value })}
        />
      </div>
      {empty ? <p role="alert" className="text-sm text-danger">Write a reply first.</p> : null}
      {save.isError ? <ErrorNote error={save.error} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="reply-help" className="text-xs text-meta">{help}</p>
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending}>Save draft</Button>
      </div>
    </form>
  );
}

/** I-1, P-7: a visitor's request joins a customer's thread only once the owner links it. */
function VisitorNotice({ thread }: { thread: ThreadDetail }) {
  const request = thread.entries.find((entry): entry is RequestEntry => entry.type === "request");
  const rejected = request?.status === "rejected";
  return (
    <div className="flex items-start gap-3 border-t border-border-soft p-4 text-sm text-fg-2" data-testid="visitor-notice">
      <Info size={20} aria-hidden className="mt-px shrink-0 text-accent" />
      <div>
        {rejected ? (
          <p>You kept this visitor apart from your customers. Replies go to customers, so there is nothing to reply to here.</p>
        ) : (
          <>
            <p>This website request is not linked to a customer yet. Review it in Customers before replying: linking it moves it into that customer&apos;s thread.</p>
            <Link href="/customers" className="mt-1 inline-flex min-h-11 items-center font-medium text-accent underline-offset-4 hover:underline">
              Review in Customers
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function ThreadPane({ id }: { id: string }) {
  const thread = useThread(id);
  const zone = useDisplayZone();
  const heading = useRef<HTMLHeadingElement>(null);
  const loaded = thread.isSuccess;
  // Opening a conversation moves focus to it, so keyboard and screen reader users land there.
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [id, loaded]);
  if (thread.isPending) return <LoadingRows rows={4} label="Loading conversation" />;
  if (thread.isError) {
    return (
      <div className="space-y-3">
        <ErrorNote error={thread.error} retry={isApiError(thread.error, "not_found") ? undefined : () => thread.refetch()} />
        {isApiError(thread.error, "not_found") ? (
          <Link href="/inbox" className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline-offset-4 hover:underline">Back to all conversations</Link>
        ) : null}
      </div>
    );
  }
  const data = thread.data;
  const reach = [data.email, formatPhone(data.phone)].filter(Boolean).join(" · ");
  return (
    <article aria-labelledby="thread-title" className="flex flex-col rounded-md bg-surface shadow-ring" data-thread-kind={data.kind}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft px-4 py-3">
        <div className="min-w-0">
          <h2 id="thread-title" ref={heading} tabIndex={-1} className="text-base font-semibold break-words">{data.name}</h2>
          {reach ? <p className="text-xs break-words text-meta">{reach}</p> : null}
          <p className="mt-1 flex flex-wrap gap-1.5"><ThreadBadges thread={data} /></p>
        </div>
        {data.contactId ? (
          <Link href={`/customers/${data.contactId}`} className="-my-1 inline-flex min-h-11 items-center text-sm font-medium text-accent underline-offset-4 hover:underline">
            Customer record
          </Link>
        ) : null}
      </header>
      <ThreadEntries thread={data} zone={zone} />
      {data.kind === "customer" ? <Composer key={data.id} thread={data} /> : <VisitorNotice thread={data} />}
    </article>
  );
}

export function InboxView({ selectedId }: { selectedId: string | null }) {
  return (
    <>
      {/* One visible h1 at every width, also with a conversation open on a phone. */}
      <PageHeader title="Inbox" description="Website requests and your replies, one thread per customer." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <div className={cn(selectedId && "hidden lg:block")}><ThreadList selectedId={selectedId} /></div>
        <div className={cn(!selectedId && "hidden lg:block")}>
          {selectedId ? (
            <>
              <Link href="/inbox" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm font-medium text-muted hover:text-fg lg:hidden">
                <ArrowLeft size={16} aria-hidden /> Inbox
              </Link>
              <ThreadPane id={selectedId} />
            </>
          ) : (
            <EmptyState title="Pick a conversation">Select a conversation to read it.</EmptyState>
          )}
        </div>
      </div>
    </>
  );
}
