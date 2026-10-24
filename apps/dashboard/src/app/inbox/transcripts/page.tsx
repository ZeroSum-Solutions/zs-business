import type { Metadata } from "next";
import { TranscriptsView } from "@/components/inbox/transcripts-view";

export const metadata: Metadata = { title: "Transcripts" };

export default function TranscriptsPage() {
  return <TranscriptsView />;
}
