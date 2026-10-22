"use client";

import { ArrowLeft, ArrowRight, CalendarBlank, Check, ChatCircleDots, Clock, Globe, Info, PaperPlaneTilt, Robot } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tray, TrayHeader, TrayTitle } from "@/components/ui/card";
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
import { useAgentActorId, useDisplayZone, useKeys, useResources, useThread, useThreads } from "@/lib/queries";
import { resourceLabel } from "@/lib/resources";
import { APPROVE_REPLIES, useCan } from "@/lib/session";
import { formatDay, formatTime, zonedDateKey } from "@/lib/time";
import { cn, formatPhone, relativeTime } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { currentMinute, subscribeMinute } from "@/components/home/home-model";

export const QUEUED_MESSAGE = "Approved. The reply is queued for delivery.";
const CHANNEL_LABELS: Record<RequestEntry["channel"], string> = { booking_page: "Booking page", widget: "Website widget" };

/** Reply states as people read them; an approval is a queued send, never a sent one (I-6). */
export const REPLY_STATUS: Record<Exclude<ReplyStatus, "discarded">, { label: string; tone: "neutral" | "info" | "success" | "danger"; icon?: ReactNode }> = {
  draft: { label: "Draft", tone: "neutral" },
  // Queued and sent look apart: a clock while it waits, a check once delivered.
  approved: { label: "Approved and queued", tone: "info", icon: <Clock aria-hidden /> },
  sent: { label: "Sent", tone: "success", icon: <Check aria-hidden /> },
  failed: { label: "Failed", tone: "danger" },
};

/** The follow-up agent's drafts carry its actor ID and no email (agents.md G-1, G-6). */
export const AGENT_AUTHOR = "the follow-up agent";

/** Who drafted or approved a reply: a member's email, the follow-up agent, or someone no longer on the team. */
export function actorName(actor: ReplyRecord["draftedBy"] | null, agentId: string | null = null): string {
  if (actor?.email) return actor.email;
  if (actor && agentId !== null && actor.userId === agentId) return AGENT_AUTHOR;
  return "a former team member";
}

/** "Oct 20, 12:21 AM", with the date and the time each kept on one line. */
function When({ instant, zone }: { instant: string; zone: string }) {
  return <><span className="whitespace-nowrap">{formatDay(instant, zone)}</span>, <span className="whitespace-nowrap">{formatTime(instant, zone)}</span></>;
}

/** The current minute, client only, so times like "8 h ago" move on while the page is open. */
function useNowMinute(): number | null {
  return useSyncExternalStore(subscribeMinute, currentMinute, () => null);
}

// Badges tint a solid surface, so their text keeps its contrast on a hovered or selected row.
function Solid({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-pill bg-surface">{children}</span>;
}

function ThreadBadges({ thread }: { thread: ThreadSummary }) {
  return (
    <>
      {/* An edge, so the grey chip still reads on the grey header. */}
      {thread.kind === "visitor" ? <Solid><Badge className="shadow-[inset_0_0_0_1px_var(--border)]"><Globe aria-hidden />Website visitor</Badge></Solid> : null}
      {thread.needsReply ? <Solid><Badge tone="info">Needs reply</Badge></Solid> : null}
      {thread.needsReview ? <Solid><Badge tone="warn">Needs review</Badge></Solid> : null}
      {thread.drafts > 0 ? <Solid><Badge tone="accent">{thread.drafts === 1 ? "1 draft" : `${thread.drafts} drafts`}</Badge></Solid> : null}
    </>
  );
}

function ThreadList({ selectedId }: { selectedId: string | null }) {
  return (
    <Tray aria-labelledby="conversations-title">
      <TrayHeader>
        <TrayTitle id="conversations-title">Conversations</TrayTitle>
      </TrayHeader>
      <ThreadRows selectedId={selectedId} />
    </Tray>
  );
}

function ThreadRows({ selectedId }: { selectedId: string | null }) {
  const threads = useThreads();
  const zone = useDisplayZone();
  const now = useNowMinute();
  if (threads.isPending) return <div className="card p-4"><LoadingRows rows={6} label="Loading conversations" /></div>;
  // A failed "Show more" keeps the pages already shown, with the error under them.
  if (threads.isError && !threads.isFetchNextPageError) return <div className="card p-4"><ErrorNote error={threads.error} retry={() => threads.refetch()} /></div>;
  const items = threads.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return <EmptyState title="No conversations yet">Website requests and your replies show here, one thread per customer.</EmptyState>;
  }
  return (
    <div>
      {/* One column that cannot grow past the list, so a long unbroken preview wraps instead. */}
      <ul aria-label="Conversations" className="grid grid-cols-1 gap-1.5">
        {items.map((thread) => {
          const active = thread.id === selectedId;
          return (
            <li key={thread.id} data-thread-id={thread.id}>
              <Link
                href={`/inbox/${thread.id}`}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "relative flex gap-3 rounded-lg p-3.5 transition-quick",
                  // The open conversation is tinted; the outline ring stays for keyboard focus.
                  active ? "bg-accent-tint shadow-card" : "bg-surface shadow-card hover:shadow-card-hover",
                )}
              >
                <Avatar name={thread.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-sm tracking-[-0.01em] text-fg", thread.needsReply || thread.needsReview ? "font-extrabold" : "font-bold")}>{thread.name}</span>
                    <time dateTime={thread.lastActivityAt} className="shrink-0 text-xs font-semibold text-meta">{relativeTime(thread.lastActivityAt, now ?? Date.now(), zone)}</time>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-caption [overflow-wrap:anywhere] text-muted">{thread.preview ?? "No message"}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-meta empty:hidden"><ThreadBadges thread={thread} /></span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {threads.isFetchNextPageError ? <div className="mt-2"><ErrorNote error={threads.error} retry={() => threads.fetchNextPage()} /></div> : null}
      {threads.hasNextPage ? (
        <Button variant="secondary" className="mt-2 w-full" disabled={threads.isFetchingNextPage} aria-busy={threads.isFetchingNextPage} onClick={() => threads.fetchNextPage()}>
          Show more conversations
        </Button>
      ) : null}
    </div>
  );
}

function RequestBubble({ entry, zone, resources, now }: { entry: RequestEntry; zone: string; resources: ResourceSummary[] | undefined; now: number }) {
  const resource = entry.booking ? resources?.find((item) => item.id === entry.booking!.resourceId) : undefined;
  const bookingZone = resource?.timeZone ?? zone;
  const past = entry.booking ? Date.parse(entry.booking.startsAt) < now : false;
  return (
    <li className="flex flex-col items-start" data-entry="request">
      <div className="max-w-full rounded-[20px] rounded-tl-md bg-tray px-4 py-3 text-body text-fg sm:max-w-[85%]">
        <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-bold text-fg-2">
          <Globe size={14} aria-hidden />Website request · {CHANNEL_LABELS[entry.channel]}
        </p>
        {entry.notes ? (
          <p className="break-words whitespace-pre-wrap">{entry.notes}</p>
        ) : (
          <p className="text-muted">No message with this request.</p>
        )}
        {entry.booking ? (
          <Link
            href={`/calendar?date=${zonedDateKey(entry.booking.startsAt, bookingZone)}&calendar=${entry.booking.resourceId}`}
            className="mt-3 flex min-h-11 items-center gap-3 rounded-md bg-surface px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)] transition-quick hover:shadow-[inset_0_0_0_1px_var(--accent)]"
          >
            <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-md", past ? "bg-tray text-muted" : "bg-accent-tint text-accent-ink")}><CalendarBlank size={18} /></span>
            {/* A booking that has passed is muted and says so, so it does not read as coming up. */}
            <span className="min-w-0 flex-1">
              {past ? (
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-bold tracking-[0.04em] text-muted uppercase"><Badge>Past</Badge>{resource ? resourceLabel(resource) : "Appointment"}</span>
              ) : (
                <span className="block text-xs font-bold tracking-[0.04em] text-muted uppercase">Booked {resource ? resourceLabel(resource) : "an appointment"} for</span>
              )}
              <span className={cn("block font-bold", past ? "text-fg-2" : "text-accent-ink")}><When instant={entry.booking.startsAt} zone={bookingZone} /></span>
            </span>
            <ArrowRight size={16} aria-hidden className={cn("shrink-0", past ? "text-muted" : "text-accent-ink")} />
          </Link>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs font-semibold text-meta">{entry.name}, <When instant={entry.at} zone={zone} /></p>
    </li>
  );
}

export function ReplyBubble({ reply, zone, agentId = null, children }: { reply: ReplyRecord; zone: string; agentId?: string | null; children?: ReactNode }) {
  const status = reply.status === "discarded" ? null : REPLY_STATUS[reply.status];
  const byAgent = agentId !== null && reply.draftedBy.userId === agentId;
  return (
    // Focus lands here after an approve or discard settles (tabIndex -1: a landing point, not a stop).
    <li className="flex flex-col items-end outline-none" tabIndex={-1} data-entry="reply" data-reply-id={reply.id} data-status={reply.status}>
      <div className="max-w-[85%] rounded-[20px] rounded-tr-md bg-accent-tint px-4 py-3 text-body text-fg">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs font-bold break-words text-fg-2"><span className="sr-only">Subject: </span>{reply.subject}</p>
          {/* Badges sit on a solid surface: their tint over the violet bubble fell below AA. */}
          {byAgent ? <span className="inline-flex rounded-pill bg-surface"><Badge data-testid="agent-draft"><Robot aria-hidden />Follow-up agent</Badge></span> : null}
          {/* Announced when it changes, such as a draft becoming approved and queued. */}
          <span aria-live="polite">{status ? <span className="inline-flex rounded-pill bg-surface"><Badge tone={status.tone} data-testid="reply-status">{status.icon}{status.label}</Badge></span> : null}</span>
        </div>
        <p className="break-words whitespace-pre-wrap">{reply.body}</p>
      </div>
      <p className="mt-1.5 text-right text-xs font-semibold text-meta">
        Drafted by {actorName(reply.draftedBy, agentId)}, <When instant={reply.createdAt} zone={zone} />
        {reply.approvedAt ? <><br />Approved by {actorName(reply.approvedBy)}, <When instant={reply.approvedAt} zone={zone} /></> : null}
        {reply.settledAt ? <><br />{reply.status === "failed" ? "Delivery failed" : "Delivered"} <When instant={reply.settledAt} zone={zone} /></> : null}
      </p>
      {children}
    </li>
  );
}

type Step = { kind: "approve" | "discard"; replyId: string };

const STEP_OUTCOME: Partial<Record<ReplyStatus, string>> = { approved: "It is queued for delivery.", sent: "It was sent.", failed: "Its delivery failed." };

/**
 * What to say after an approve or discard failed. A `not_draft` conflict names what happened
 * once the reloaded thread shows it, as information; only conflicts that change the thread say
 * it was reloaded (`no_email` changes nothing: the owner adds an email first). A reply missing
 * from the reload may be discarded or older than the latest 200 entries (I-3), so the
 * conflict's own `status` (I-6, I-7) says which.
 */
export function stepNotice(error: unknown, thread: Pick<ThreadDetail, "entries"> | undefined, replyId: string, agentId: string | null): { tone: "info" | "danger"; message: string } {
  const message = isApiError(error) ? error.message : "Something went wrong. Try again.";
  if (!isApiError(error, "conflict")) return { tone: "danger", message };
  if (error.reason === "not_draft" && thread) {
    const status = error.details.status;
    const reply = thread.entries.find((entry) => entry.type === "reply" && entry.reply.id === replyId);
    if (!reply) {
      if (status === "discarded") return { tone: "info", message: "Someone discarded this draft first." };
      const outcome = typeof status === "string" ? STEP_OUTCOME[status as ReplyStatus] : undefined;
      if (outcome) return { tone: "info", message: `Someone already approved this draft. ${outcome}` };
    } else if (reply.type === "reply" && reply.reply.status !== "draft") {
      const by = `Already approved by ${actorName(reply.reply.approvedBy, agentId)}`;
      return { tone: "info", message: `${by}. ${STEP_OUTCOME[reply.reply.status] ?? STEP_OUTCOME.approved}` };
    }
  }
  if (error.reason === "not_draft" || error.reason === "approved_by_other") return { tone: "danger", message: `${message} The thread was reloaded.` };
  return { tone: "danger", message };
}

/**
 * Where focus lands once a step's reply has left the draft state in the reloaded thread: the
 * approved reply, or after a discard the next waiting draft, else the messages. Null while the
 * thread still shows the draft, so focus waits for the reload.
 */
export function focusAfterStep(kind: Step["kind"], replyId: string, entries: readonly ({ type: "reply"; reply: { id: string; status: ReplyStatus } } | { type: "request" })[]): { replyId: string } | "messages" | null {
  const replies = entries.flatMap((entry) => entry.type === "reply" ? [entry.reply] : []);
  const reply = replies.find((item) => item.id === replyId);
  if (reply?.status === "draft") return null;
  if (reply) return { replyId };
  if (kind === "discard") {
    const next = replies.find((item) => item.status === "draft");
    if (next) return { replyId: next.id };
  }
  return "messages";
}

function ThreadEntries({ thread, zone }: { thread: ThreadDetail; zone: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const resources = useResources();
  const canApprove = useCan(APPROVE_REPLIES);
  const canDraft = useCan("inbox.drafts");
  const agentId = useAgentActorId();
  const intents = useIntentKey();
  const now = useNowMinute() ?? Date.now();
  const messages = useRef<HTMLOListElement>(null);
  // The step whose buttons just went away: focus follows it once the thread has reloaded.
  const [landing, setLanding] = useState<Step | null>(null);

  const step = useMutation({
    mutationFn: (input: Step) => {
      const options = { idempotencyKey: intents.keyFor(input) };
      return input.kind === "approve" ? api.approveReply(input.replyId, options) : api.discardReply(input.replyId, options);
    },
    onSettled: async (_reply, error, input) => {
      intents.settle(input, error);
      await queryClient.invalidateQueries({ queryKey: keys.inboxAll });
    },
    onSuccess: (_reply, input) => {
      setLanding(input);
      toast(input.kind === "approve" ? QUEUED_MESSAGE : "Draft discarded.", input.kind === "approve" ? "success" : "info");
    },
  });

  useEffect(() => {
    if (!landing) return;
    const target = focusAfterStep(landing.kind, landing.replyId, thread.entries);
    if (target === null) return;
    setLanding(null);
    if (target === "messages") messages.current?.focus();
    else messages.current?.querySelector<HTMLElement>(`[data-reply-id="${target.replyId}"]`)?.focus();
  }, [landing, thread.entries]);

  const notice = step.isError ? stepNotice(step.error, thread, step.variables.replyId, agentId) : null;
  const noEmailRecord = thread.email === null && thread.contactId ? `/customers/${thread.contactId}` : null;
  return (
    <>
      {thread.olderEntries ? <p className="pb-3 text-xs text-meta">Older messages are not shown. This shows the latest 200.</p> : null}
      {notice ? (
        <div className="pb-3" data-testid="reply-step-error">
          {notice.tone === "info" ? (
            <p role="status" className="flex items-start gap-2 rounded-md bg-info-tint p-3 text-sm text-fg-2">
              <Info size={20} aria-hidden className="mt-px shrink-0 text-info" />
              <span>{notice.message}</span>
            </p>
          ) : (
            <ErrorNote error={step.error} message={notice.message} />
          )}
        </div>
      ) : null}
      <ol ref={messages} tabIndex={-1} aria-label="Messages" className="flex-1 space-y-5 px-1 py-1 outline-none lg:px-2">
        {thread.entries.map((entry) => entry.type === "request" ? (
          <RequestBubble key={`r-${entry.id}`} entry={entry} zone={zone} resources={resources.data} now={now} />
        ) : (
          <ReplyBubble key={`m-${entry.reply.id}`} reply={entry.reply} zone={zone} agentId={agentId}>
            {entry.reply.status === "draft" ? (
              <DraftActions
                reply={entry.reply}
                canApprove={canApprove}
                canDiscard={canDraft}
                noEmailRecord={noEmailRecord}
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
 * discard it; staff may discard, and see that an owner approves it. A customer with no email
 * cannot be approved yet (I-6 `no_email`): the button is off and says where to add one.
 */
export function DraftActions({ reply, canApprove, canDiscard, noEmailRecord = null, busy, onStep }: {
  reply: ReplyRecord;
  canApprove: boolean;
  canDiscard: boolean;
  /** The customer record's address when the customer has no email address yet. */
  noEmailRecord?: string | null;
  busy: boolean;
  onStep: (kind: "approve" | "discard") => void;
}) {
  const note = `draft-note-${reply.id}`;
  const noEmail = canApprove && noEmailRecord !== null;
  return (
    <div className="mt-2 flex max-w-[85%] flex-col items-end gap-2">
      <div id={note} className="text-right text-xs text-muted">
        {!canApprove ? (
          <p>Waiting for an owner to approve it before it is queued to send.</p>
        ) : noEmail ? (
          <>
            <p>Add an email address to the customer record to approve it.</p>
            <Link href={noEmailRecord} className="-mb-2 inline-flex min-h-11 items-center font-bold text-accent-ink underline-offset-4 hover:underline">Open customer record</Link>
          </>
        ) : (
          <p>Approving queues it for delivery by email.</p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {canDiscard ? (
          <Button variant="secondary" disabled={busy} aria-busy={busy} onClick={() => onStep("discard")}>Discard</Button>
        ) : null}
        {canApprove ? (
          <Button disabled={busy || noEmail} aria-busy={busy} aria-describedby={note} onClick={() => onStep("approve")}>
            <PaperPlaneTilt aria-hidden />Approve and queue
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a press of Save draft does: nothing while a save is in flight, nothing for an empty form
 * right after a save emptied it (a double tap), "Write a reply first" for any other empty form.
 */
export function composerSubmit({ body, pending, justSaved }: { body: string; pending: boolean; justSaved: boolean }): "ignore" | "empty" | "save" {
  if (pending) return "ignore";
  if (body.trim() === "") return justSaved ? "ignore" : "empty";
  return "save";
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
  const [justSaved, setJustSaved] = useState(false);
  const reply = useRef<HTMLTextAreaElement>(null);
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
      setEmpty(false);
      setJustSaved(true);
      toast(canApprove ? "Draft saved. Approve it to queue it for delivery." : "Draft saved. An owner approves it before it is queued to send.");
    },
  });

  const edit = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setJustSaved(false);
    if (patch.body !== undefined) setEmpty(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const action = composerSubmit({ body: form.body, pending: save.isPending, justSaved });
    if (action === "ignore") return;
    if (action === "empty") {
      setEmpty(true);
      reply.current?.focus();
      return;
    }
    setEmpty(false);
    save.mutate({ contactId, subject: form.subject.trim() || null, body: form.body.trim() });
  };

  const help = canApprove
    ? "Saved as a draft first. You approve it before it is queued to send."
    : "Saved as a draft. An owner approves it before it is queued to send.";
  return (
    <form className="card space-y-3 p-4 lg:px-5" onSubmit={submit} noValidate>
      {thread.email === null ? (
        <p className="flex items-start gap-2 rounded-md bg-warn-tint p-3 text-sm text-fg-2">
          <Info size={20} aria-hidden className="mt-px shrink-0 text-warn" />
          <span>This customer has no email address yet. You can draft a reply, but it can only be approved once their record has an email.</span>
        </p>
      ) : null}
      <div>
        <Label htmlFor="reply-subject">Subject (optional)</Label>
        <Input id="reply-subject" maxLength={200} aria-describedby="reply-subject-help" value={form.subject} onChange={(event) => edit({ subject: event.target.value })} />
        {/* The server fills "Message from <business name>" (I-5); no business is named here. */}
        <p id="reply-subject-help" className="mt-1 text-xs text-meta">Leave it empty to use “Message from” and your business name.</p>
      </div>
      <div>
        {/* With a draft already waiting, say this one is another reply, not an edit of it. */}
        <Label htmlFor="reply">{thread.drafts > 0 ? `Write another reply to ${thread.name}` : `Reply to ${thread.name}`}</Label>
        <Textarea
          ref={reply}
          id="reply"
          rows={3}
          maxLength={5000}
          className="min-h-20 aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]"
          value={form.body}
          aria-invalid={empty || isApiError(save.error, "validation") || undefined}
          aria-describedby={empty ? "reply-error reply-help" : "reply-help"}
          onChange={(event) => edit({ body: event.target.value })}
        />
      </div>
      {empty ? <p id="reply-error" role="alert" className="text-sm text-danger">Write a reply first.</p> : null}
      {save.isError ? <ErrorNote error={save.error} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="reply-help" className="min-w-0 flex-1 basis-56 text-xs text-meta">{help}</p>
        <Button type="submit" className="ml-auto" disabled={save.isPending} aria-busy={save.isPending}>Save draft</Button>
      </div>
    </form>
  );
}

/** I-1, P-7: a visitor's request joins a customer's thread only once the owner links it. */
function VisitorNotice({ thread }: { thread: ThreadDetail }) {
  const request = thread.entries.find((entry): entry is RequestEntry => entry.type === "request");
  const rejected = request?.status === "rejected";
  return (
    <div className="card flex items-start gap-3 p-4 text-sm text-fg-2 lg:px-5" data-testid="visitor-notice">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-ink"><Info size={20} /></span>
      <div>
        {rejected ? (
          <p>You kept this visitor apart from your customers. Replies go to customers, so there is nothing to reply to here.</p>
        ) : (
          <>
            <p>This website request is not linked to a customer yet. Review it in Customers before replying: linking it moves it into that customer&apos;s thread.</p>
            <Button asChild className="mt-3">
              <Link href="/customers">Review in Customers <ArrowRight aria-hidden /></Link>
            </Button>
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
  if (thread.isPending) return <div className="tray"><div className="card p-4"><LoadingRows rows={4} label="Loading conversation" /></div></div>;
  if (thread.isError) {
    // The list beside it (or "Inbox" above it on a phone) is the way back.
    return <div className="tray"><ErrorNote error={thread.error} retry={isApiError(thread.error, "not_found") ? undefined : () => thread.refetch()} /></div>;
  }
  const data = thread.data;
  return (
    <article aria-labelledby="thread-title" className="tray flex flex-col gap-1.5 lg:gap-2" data-thread-kind={data.kind}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-2 pt-2 pb-2 lg:px-4 lg:pt-3">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar name={data.name} size="lg" />
          <div className="min-w-0">
          {/* Focus lands here when a thread opens; it is a landing point, not a control, so no ring. */}
          <h2 id="thread-title" ref={heading} tabIndex={-1} className="text-xl leading-tight font-extrabold tracking-[-0.02em] break-words outline-none">{data.name}</h2>
          {data.email || data.phone ? (
            <p className="mt-0.5 text-caption break-words text-muted">
              {data.email}
              {data.email && data.phone ? " · " : null}
              {data.phone ? <span className="whitespace-nowrap">{formatPhone(data.phone)}</span> : null}
            </p>
          ) : null}
          <p className="mt-2 flex flex-wrap gap-1.5 empty:hidden"><ThreadBadges thread={data} /></p>
          </div>
        </div>
        {data.contactId ? (
          <Link href={`/customers/${data.contactId}`} className="-my-1 inline-flex min-h-11 items-center text-sm font-bold text-accent-ink underline-offset-4 hover:underline">
            Customer record
          </Link>
        ) : null}
      </header>
      <section aria-label="Conversation" className="card p-4 lg:p-5"><ThreadEntries thread={data} zone={zone} /></section>
      {data.kind === "customer" ? <Composer key={data.id} thread={data} /> : <VisitorNotice thread={data} />}
    </article>
  );
}

const DESCRIPTION = "Website requests and your replies, one thread per customer.";

export function InboxView({ selectedId }: { selectedId: string | null }) {
  const threads = useThreads();
  return (
    <>
      {/* One visible h1 at every width, also with a conversation open on a phone; there the description gives way to the thread. */}
      <PageHeader title="Inbox" description={selectedId ? <span className="hidden lg:inline">{DESCRIPTION}</span> : DESCRIPTION} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <div className={cn(selectedId && "hidden lg:block")}><ThreadList selectedId={selectedId} /></div>
        <div className={cn(!selectedId && "hidden lg:block")}>
          {selectedId ? (
            <>
              <Link href="/inbox" className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-bold text-muted hover:bg-tray hover:text-fg lg:hidden">
                <ArrowLeft size={16} aria-hidden /> Inbox
              </Link>
              <ThreadPane id={selectedId} />
            </>
          ) : (
            <div className="tray flex min-h-[520px] flex-col items-center justify-center gap-3 px-6 text-center">
              <span aria-hidden className="flex size-12 items-center justify-center rounded-md bg-surface text-accent-ink shadow-card"><ChatCircleDots size={24} /></span>
              {/* With no list beside it (it failed to load), there is nothing to pick yet. */}
              {threads.isError && !threads.data ? (
                <>
                  <p className="font-bold text-fg">No conversations to show</p>
                  <p className="max-w-64 text-sm text-muted">Conversations show here once they load.</p>
                </>
              ) : (
                <>
                  <p className="font-bold text-fg">Pick a conversation</p>
                  <p className="max-w-64 text-sm text-muted">Select a conversation to read it and reply.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
