"use client";

import { ArrowLeft, ChatCircleText, EnvelopeSimple, Globe, InstagramLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import type { Channel } from "@/lib/api";
import { useThread, useThreads } from "@/lib/queries";
import { formatTime } from "@/lib/time";
import { cn, initials, relativeTime } from "@/lib/utils";

const CHANNELS: Record<Channel, { label: string; icon: typeof ChatCircleText }> = {
  sms: { label: "Text", icon: ChatCircleText },
  email: { label: "Email", icon: EnvelopeSimple },
  instagram: { label: "Instagram", icon: InstagramLogo },
  webchat: { label: "Web chat", icon: Globe },
};

function ThreadList({ selectedId }: { selectedId: string | null }) {
  const threads = useThreads();
  if (threads.isPending) return <LoadingRows rows={6} label="Loading conversations" />;
  if (threads.isError) return <ErrorNote error={threads.error} retry={() => threads.refetch()} />;
  if (threads.data.length === 0) return <EmptyState title="No conversations yet">New texts, emails and DMs land here.</EmptyState>;
  return (
    <ul className="divide-y divide-border-soft overflow-hidden rounded-md bg-surface shadow-ring">
      {threads.data.map((thread) => {
        const channel = CHANNELS[thread.channel];
        const active = thread.id === selectedId;
        return (
          <li key={thread.id}>
            <Link
              href={`/inbox/${thread.id}`}
              aria-current={active ? "true" : undefined}
              className={cn("flex gap-3 px-4 py-3 transition-quick hover:bg-surface-warm", active && "bg-surface-warm shadow-[inset_2px_0_0_var(--accent)]")}
            >
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-surface-warm text-sm font-semibold text-fg-2">
                {initials(thread.contactName)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm text-fg", thread.unread ? "font-semibold" : "font-medium")}>{thread.contactName}</span>
                  <span className="shrink-0 text-xs text-meta">{relativeTime(thread.updatedAt)}</span>
                </span>
                <span className={cn("block truncate text-sm", thread.unread ? "text-fg-2" : "text-muted")}>{thread.preview}</span>
                <span className="mt-1 flex items-center gap-2 text-xs text-meta">
                  <channel.icon size={14} aria-hidden />{channel.label}
                  {thread.unread ? <Badge tone="accent">Unread</Badge> : null}
                  {thread.needsReply && !thread.unread ? <Badge tone="warn">Needs reply</Badge> : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ThreadPane({ id }: { id: string }) {
  const thread = useThread(id);
  if (thread.isPending) return <LoadingRows rows={4} label="Loading conversation" />;
  if (thread.isError) return <ErrorNote error={thread.error} retry={() => thread.refetch()} />;
  const channel = CHANNELS[thread.data.channel];
  return (
    <article aria-labelledby="thread-title" className="flex flex-col rounded-md bg-surface shadow-ring">
      <header className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-3">
        <div>
          <h2 id="thread-title" className="text-base font-semibold">{thread.data.contactName}</h2>
          <p className="flex items-center gap-1.5 text-xs text-meta"><channel.icon size={14} aria-hidden />{channel.label}</p>
        </div>
      </header>
      <ol className="flex-1 space-y-4 px-4 py-4">
        {thread.data.messages.map((message) => {
          const mine = message.from !== "customer";
          return (
            <li key={message.id} className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
              <div className={cn("max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm", mine ? "bg-accent/10 text-fg" : "bg-surface-warm text-fg")}>
                {message.body}
              </div>
              <p className="mt-1 text-xs text-meta">
                {message.from === "agent" ? `${message.author}, sent for you` : message.author} at {formatTime(message.sentAt, "America/New_York")}
              </p>
            </li>
          );
        })}
      </ol>
      <form className="border-t border-border-soft p-3" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="reply" className="sr-only">Reply to {thread.data.contactName}</label>
        <Textarea id="reply" rows={2} placeholder={`Reply by ${channel.label.toLowerCase()}`} className="min-h-16" />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-meta">Replies send in the next release.</p>
          <Button type="submit" disabled>Send</Button>
        </div>
      </form>
    </article>
  );
}

export function InboxView({ selectedId }: { selectedId: string | null }) {
  return (
    <>
      <div className={cn(selectedId && "hidden lg:block")}>
        <PageHeader title="Inbox" description="Texts, email, Instagram and web chat in one list." />
      </div>
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
