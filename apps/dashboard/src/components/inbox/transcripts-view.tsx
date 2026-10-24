"use client";

import { ArrowLeft, Microphone, VoicemailIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import type { TranscriptionDetail, TranscriptionSummary } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Tray, TrayBody, TrayHeader, TrayTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useDisplayZone, useTranscription, useTranscriptions } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/** What the person sees for each state; a dead letter is a failure they can act on (re-upload). */
export const TRANSCRIPT_STATUS: Record<TranscriptionSummary["status"], { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  queued: { label: "Waiting for the worker", tone: "neutral" },
  running: { label: "Transcribing", tone: "info" },
  completed: { label: "Ready", tone: "success" },
  failed: { label: "Retrying", tone: "info" },
  dead_letter: { label: "Could not transcribe", tone: "danger" },
};

const ERROR_TEXT: Record<string, string> = {
  audio_too_large: "The file is larger than 100 MB.",
  audio_too_long: "The recording is longer than 60 minutes.",
  audio_format: "This file type is not supported. Use wav, mp3, m4a, ogg, webm or flac.",
};

/** "Speaker 1" for S1; the model's label only says the same voice came back. */
export const speakerName = (label: string | null) => (label === null ? "Unknown speaker" : `Speaker ${label.slice(1)}`);

export function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const sourceLabel = (job: { sourceKind: TranscriptionSummary["sourceKind"] }) => (job.sourceKind === "voicemail" ? "Voicemail" : "Uploaded audio");

function JobList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const jobs = useTranscriptions();
  const zone = useDisplayZone();
  return (
    <Tray aria-labelledby="transcripts-list-title">
      <TrayHeader><TrayTitle id="transcripts-list-title">Recordings</TrayTitle></TrayHeader>
      <TrayBody className="px-2 pb-2">
        {jobs.isPending ? <LoadingRows label="Loading recordings" /> : null}
        {jobs.isError ? <ErrorNote error={jobs.error} retry={() => void jobs.refetch()} /> : null}
        {jobs.data && jobs.data.length === 0 ? <EmptyState title="No recordings yet">Voicemails and uploaded audio show here once they are transcribed.</EmptyState> : null}
        {jobs.data?.map((job) => {
          const status = TRANSCRIPT_STATUS[job.status];
          const Icon = job.sourceKind === "voicemail" ? VoicemailIcon : Microphone;
          return (
            <button
              key={job.id}
              type="button"
              data-job={job.id}
              aria-pressed={job.id === selectedId}
              onClick={() => onSelect(job.id)}
              className={cn(
                "flex min-h-14 w-full items-center gap-3 rounded-md bg-surface p-3 text-left shadow-card",
                job.id === selectedId && "outline-2 outline-accent",
              )}
            >
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-tray text-accent-ink"><Icon size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-fg">{sourceLabel(job)}</span>
                <span className="block text-sm text-muted">{formatDay(job.createdAt, zone)}, {formatTime(job.createdAt, zone)}</span>
              </span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </button>
          );
        })}
      </TrayBody>
    </Tray>
  );
}

function Segments({ detail }: { detail: TranscriptionDetail & { transcript: NonNullable<TranscriptionDetail["transcript"]> } }) {
  const { transcript } = detail;
  const zone = useDisplayZone();
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {formatClock(transcript.durationMs)} long, {transcript.speakers.length === 1 ? "1 speaker" : `${transcript.speakers.length} speakers`}.
        Kept until {formatDay(transcript.expiresAt, zone)}.
      </p>
      <ol className="space-y-3" aria-label="Transcript">
        {transcript.segments.map((segment, index) => (
          <li key={index} data-segment className="rounded-md bg-surface p-3 shadow-card">
            <p className="mb-1 flex items-center gap-2 text-xs font-bold text-muted">
              <span data-speaker>{speakerName(segment.speaker)}</span>
              <span aria-hidden>·</span>
              <span>{formatClock(segment.startMs)}</span>
            </p>
            <p className="text-fg">{segment.text}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

function JobPane({ id }: { id: string }) {
  const job = useTranscription(id);
  return (
    <Tray aria-labelledby="transcript-title" aria-busy={job.isPending}>
      <TrayHeader><TrayTitle id="transcript-title">Transcript</TrayTitle></TrayHeader>
      <div className="px-3 pb-3 lg:px-4 lg:pb-4">
        {job.isPending ? <LoadingRows rows={4} label="Loading transcript" /> : null}
        {job.isError ? <ErrorNote error={job.error} retry={() => void job.refetch()} /> : null}
        {job.data?.transcript ? <Segments detail={{ ...job.data, transcript: job.data.transcript }} /> : null}
        {job.data && !job.data.transcript ? (
          <EmptyState title={TRANSCRIPT_STATUS[job.data.status].label}>
            {job.data.status === "dead_letter"
              ? ERROR_TEXT[job.data.lastErrorCode ?? ""] ?? "The worker could not read this recording. Upload it again."
              : "The transcript shows here when the worker finishes."}
          </EmptyState>
        ) : null}
      </div>
    </Tray>
  );
}

export function TranscriptsView() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Transcripts"
        description="Voicemails and uploaded recordings, written out with who said what."
        actions={
          <Link href="/inbox" className="inline-flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-bold text-muted hover:bg-tray hover:text-fg">
            <ArrowLeft size={16} aria-hidden /> Inbox
          </Link>
        }
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <JobList selectedId={selected} onSelect={setSelected} />
        {selected ? (
          <JobPane id={selected} />
        ) : (
          <div className="tray flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-bold text-fg">Pick a recording</p>
            <p className="max-w-64 text-sm text-muted">Select a recording to read its transcript.</p>
          </div>
        )}
      </div>
    </>
  );
}
