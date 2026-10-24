/**
 * The demo adapter's transcripts (transcription.md X-7). Three jobs: a finished voicemail with
 * two speakers, an upload that waits for the local worker, and an upload that failed its last
 * attempt. Reads match the API: newest first, an unknown ID is a 404. The demo has no worker,
 * so nothing changes after the seed.
 */
import { transcriptionDetailSchema, transcriptionSummarySchema, type TranscriptSegment, type TranscriptionDetail, type TranscriptionSummary } from "@zs/contracts";
import { ApiError } from "../errors";
import type { TranscriptionApi } from "../types";
import type { DemoClock } from "./adapter";

export const DEMO_TRANSCRIPT_JOB_ID = "7d1e4c20-5a3b-4f6e-9d28-0c5b7a9e1f31";
export const DEMO_QUEUED_JOB_ID = "7d1e4c20-5a3b-4f6e-9d28-0c5b7a9e1f32";
export const DEMO_DEAD_JOB_ID = "7d1e4c20-5a3b-4f6e-9d28-0c5b7a9e1f33";
const TRANSCRIPT_ID = "8e2f5d31-6b4c-4a7f-8e39-1d6c8bae2042";
const VOICEMAIL_ID = "9f3a6e42-7c5d-4b80-9f4a-2e7d9cbf3153";
const DAY = 86_400_000;

const SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 4200, speaker: "S1", text: "Hi, this is Linnea. I am calling about the sapphire halo ring." },
  { startMs: 4600, endMs: 7800, speaker: "S2", text: "Thanks for calling Halden and Rowe. Which size are you after?" },
  { startMs: 8100, endMs: 11000, speaker: "S1", text: "A size six. Could I come in on Saturday?" },
];

export function createDemoTranscripts(options: { clock?: DemoClock; latencyMs?: number } = {}): TranscriptionApi {
  const clock = options.clock ?? { now: () => new Date() };
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const ago = (ms: number) => new Date(clock.now().getTime() - ms).toISOString();

  const details = (): TranscriptionDetail[] => [
    transcriptionDetailSchema.parse({
      id: DEMO_QUEUED_JOB_ID, sourceKind: "media_upload", sourceId: null, status: "queued", attempts: 0,
      lastErrorCode: null, createdAt: ago(60_000), completedAt: null, transcript: null,
    }),
    transcriptionDetailSchema.parse({
      id: DEMO_TRANSCRIPT_JOB_ID, sourceKind: "voicemail", sourceId: VOICEMAIL_ID, status: "completed", attempts: 1,
      lastErrorCode: null, createdAt: ago(3_600_000), completedAt: ago(3_540_000),
      transcript: {
        id: TRANSCRIPT_ID,
        modelIds: { asr: "large-v3", align: "wav2vec2-large-960h-lv60-self", diarize: "pyannote/speaker-diarization-community-1" },
        language: "en", durationMs: 11_000, speakers: ["S1", "S2"], segments: SEGMENTS,
        createdAt: ago(3_540_000), expiresAt: ago(-90 * DAY + 3_540_000),
      },
    }),
    transcriptionDetailSchema.parse({
      id: DEMO_DEAD_JOB_ID, sourceKind: "media_upload", sourceId: null, status: "dead_letter", attempts: 3,
      lastErrorCode: "audio_format", createdAt: ago(2 * DAY), completedAt: null, transcript: null,
    }),
  ];

  return {
    async listTranscriptions() {
      await wait();
      return details().map((detail): TranscriptionSummary => transcriptionSummarySchema.parse({
        id: detail.id, sourceKind: detail.sourceKind, sourceId: detail.sourceId, status: detail.status, attempts: detail.attempts,
        lastErrorCode: detail.lastErrorCode, createdAt: detail.createdAt, completedAt: detail.completedAt,
        transcript: detail.transcript && {
          id: detail.transcript.id, language: detail.transcript.language, durationMs: detail.transcript.durationMs,
          speakerCount: detail.transcript.speakers.length, segmentCount: detail.transcript.segments.length,
          createdAt: detail.transcript.createdAt, expiresAt: detail.transcript.expiresAt,
        },
      }));
    },
    async getTranscription(id) {
      await wait();
      const found = details().find((detail) => detail.id === id);
      if (!found) throw new ApiError("not_found", "We could not find that transcript.", 404, "NotFound");
      return found;
    },
  };
}
