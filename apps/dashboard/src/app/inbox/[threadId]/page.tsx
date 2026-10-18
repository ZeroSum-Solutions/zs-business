import type { Metadata } from "next";
import { InboxView } from "@/components/inbox/inbox-view";

export const metadata: Metadata = { title: "Inbox" };

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return <InboxView selectedId={threadId} />;
}
