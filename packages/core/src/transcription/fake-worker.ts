// The TypeScript stand-in for the Python WhisperX worker (docs/requirements/transcription.md,
// "First slice"): it claims a job, fetches the audio, and completes it with fixed segments, so
// `pnpm -r test` needs no Python, no model and no network. It talks to the system through the same
// job interface the real worker uses; a test points it at the session or at the HTTP routes.
import type { ClaimedJob, CompleteResult, FailResult, TranscriptBody } from "@zs/contracts";
import type { AudioObject } from "./ports.js";

/** The worker's side of X-4. The session's `worker` object and an HTTP client both fit it. */
export interface TranscriptionWorkerApi {
  claim(): Promise<ClaimedJob | null>;
  audio(jobId: string, leaseToken: string): Promise<AudioObject>;
  complete(jobId: string, leaseToken: string, transcript: TranscriptBody): Promise<CompleteResult>;
  fail(jobId: string, leaseToken: string, body: { errorCode: string }): Promise<FailResult>;
}

/** Two speakers, in time order: what the acceptance test reads back. */
export const FAKE_TRANSCRIPT: TranscriptBody = Object.freeze({
  modelIds: { asr: "fake-asr", align: "fake-align", diarize: "fake-diarize" },
  language: "en",
  durationMs: 9000,
  segments: [
    { startMs: 0, endMs: 3000, speaker: "S1", text: "Hello, Halden and Rowe." },
    { startMs: 3200, endMs: 6000, speaker: "S2", text: "Hi, I would like a fitting on Monday." },
    { startMs: 6200, endMs: 9000, speaker: "S1", text: "Monday at nine works." },
  ],
}) as TranscriptBody;

export interface FakeWorkerRun {
  readonly job: ClaimedJob;
  /** Bytes of audio it fetched. */
  readonly audioBytes: number;
}

export class FakeTranscriptionWorker {
  /** When set, the next run fails with this code instead of completing. */
  failWith: string | null = null;
  constructor(
    private readonly api: TranscriptionWorkerApi,
    private readonly transcript: TranscriptBody = FAKE_TRANSCRIPT,
  ) {}

  /** Claim one job and finish it. Null when nothing is due. */
  async runOnce(): Promise<FakeWorkerRun | null> {
    const job = await this.api.claim();
    if (!job) return null;
    const audio = await this.api.audio(job.id, job.leaseToken);
    if (this.failWith !== null) {
      await this.api.fail(job.id, job.leaseToken, { errorCode: this.failWith });
      return { job, audioBytes: audio.bytes };
    }
    await this.api.complete(job.id, job.leaseToken, this.transcript);
    return { job, audioBytes: audio.bytes };
  }
}
