import { describe, expect, it } from "vitest";
import {
  claimedJobSchema,
  completePayloadSchema,
  enqueuePayloadSchema,
  failPayloadSchema,
  MAX_TRANSCRIPT_SEGMENTS,
  Refused,
  SERVER_IDEMPOTENCY_PREFIXES,
  transcriptBodySchema,
  transcriptSegmentSchema,
} from "../src/index.js";

const ID = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const models = { asr: "large-v3", align: "wav2vec2-en", diarize: "pyannote/speaker-diarization-community-1" };
const segment = (startMs: number, speaker: string | null = "S1") => ({ startMs, endMs: startMs + 500, speaker, text: "hi" });
const body = (segments: unknown[]) => ({ modelIds: models, language: "en", durationMs: 9000, segments });

describe("transcript body", () => {
  it("accepts ordered segments with S1..S9 or no speaker", () => {
    expect(transcriptBodySchema.safeParse(body([segment(0), segment(600, "S2"), segment(1200, null)])).success).toBe(true);
  });
  it("refuses out-of-order segments, bad speaker labels and a segment that ends before it starts", () => {
    expect(transcriptBodySchema.safeParse(body([segment(600), segment(0)])).success).toBe(false);
    expect(transcriptSegmentSchema.safeParse(segment(0, "S0")).success).toBe(false);
    expect(transcriptSegmentSchema.safeParse(segment(0, "speaker1")).success).toBe(false);
    expect(transcriptSegmentSchema.safeParse({ startMs: 10, endMs: 5, speaker: null, text: "x" }).success).toBe(false);
  });
  it("holds the segment count and the model ID shape", () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_SEGMENTS + 1 }, (_, i) => segment(i));
    expect(transcriptBodySchema.safeParse(body(many)).success).toBe(false);
    expect(transcriptBodySchema.safeParse({ ...body([]), modelIds: { ...models, asr: "bad id!" } }).success).toBe(false);
  });
});

describe("enqueue and worker payloads", () => {
  it("requires the owner's attestations on an upload", () => {
    const base = { sourceKind: "media_upload", jobId: ID, declaredBytes: 10, rightsConfirmed: true, containsHealthData: false };
    expect(enqueuePayloadSchema.safeParse(base).success).toBe(true);
    expect(enqueuePayloadSchema.safeParse({ ...base, rightsConfirmed: false }).success).toBe(false);
    expect(enqueuePayloadSchema.safeParse({ ...base, containsHealthData: true }).success).toBe(false);
    expect(enqueuePayloadSchema.safeParse({ ...base, declaredBytes: 100 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(enqueuePayloadSchema.safeParse({ sourceKind: "voicemail", voicemailId: ID }).success).toBe(true);
  });
  it("shapes complete, fail and claim", () => {
    expect(completePayloadSchema.safeParse({ jobId: ID, attempt: 1, leaseToken: ID, transcript: body([segment(0)]) }).success).toBe(true);
    expect(failPayloadSchema.safeParse({ jobId: ID, attempt: 1, leaseToken: ID, errorCode: "Bad Code" }).success).toBe(false);
    expect(claimedJobSchema.safeParse({ id: ID, tenantId: ID, sourceKind: "voicemail", attempt: 1, declaredBytes: null,
      leaseToken: ID, leaseExpiresAt: "2026-10-19T08:00:00.000Z", audioPath: `audio/${ID}/${ID}` }).success).toBe(true);
  });
});

describe("refusals and keys", () => {
  it("carries a status and a reason", () => {
    const refused = new Refused(413, "audio_too_large");
    expect(refused).toMatchObject({ status: 413, reason: "audio_too_large" });
  });
  it("lists the transcript idempotency prefix as server-only", () => {
    expect(SERVER_IDEMPOTENCY_PREFIXES).toContain("transcript:");
  });
});
