import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { storedInstantSchema } from "./instant.js";

// Root re-exports this module, so the shared root schemas are reached lazily, as in business.ts.
const idSchema = z.lazy(() => uuidSchema);

// Transcription (docs/requirements/transcription.md X-1..X-9): request, worker and record
// shapes for the jobs a local worker pulls and the transcripts it returns.

export const TRANSCRIPTION_ENQUEUE_ACTION = "transcription.job.enqueue";
export const TRANSCRIPTION_COMPLETE_ACTION = "transcription.job.complete";
export const TRANSCRIPTION_FAIL_ACTION = "transcription.job.fail";
export const TRANSCRIPTION_JOB_TARGET = "transcription_job";

/** X-9: an upload is at most 100 MiB and 60 minutes. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_MS = 60 * 60 * 1000;
/** X-9: the containers the worker accepts. */
export const AUDIO_CONTAINERS = ["wav", "mp3", "m4a", "ogg", "webm", "flac"] as const;
/** X-3: a job gets this many attempts, then it is a dead letter. */
export const TRANSCRIPTION_MAX_ATTEMPTS = 3;
/** X-3: a claim holds the job for this long; a heartbeat extends it. */
export const TRANSCRIPTION_LEASE_MS = 10 * 60 * 1000;
/** X-9: failures no retry can fix. */
export const TRANSCRIPTION_FINAL_ERRORS: readonly string[] = Object.freeze(["audio_too_large", "audio_too_long", "audio_format"]);
/** X-7 bounds. */
// The contract (X-4) allows 5000, but a completion travels as an action payload, and the shared
// JSON rule allows 10000 nodes and 262144 text units. At five nodes a segment that is 1500; the
// first slice holds that line and the open risks name it.
export const MAX_TRANSCRIPT_SEGMENTS = 1500;
export const MAX_TRANSCRIPT_TEXT = 200_000;
export const MAX_SEGMENT_TEXT = 2000;
/** X-4: the worker's routes. */
export const WORKER_ROUTE_PREFIX = "/worker/v1/transcription";
/** The header that carries the lease token on every route after claim. */
export const LEASE_TOKEN_HEADER = "X-Lease-Token";

/**
 * A request refused at the door with a status the shared error codes do not have: 413 (too
 * large) and 422 (health data). The HTTP body keeps code ValidationFailed and names the
 * documented `reason` in its details. A plain Error: it is not an action error and nothing is stored.
 */
export class Refused extends Error {
  constructor(readonly status: 413 | 422, readonly reason: string, message = "Request refused") {
    super(message);
    this.name = "Refused";
  }
}

export const transcriptionSourceKindSchema = z.enum(["media_upload", "voicemail"]);
export type TranscriptionSourceKind = z.infer<typeof transcriptionSourceKindSchema>;
export const transcriptionStatusSchema = z.enum(["queued", "running", "completed", "failed", "dead_letter"]);
export type TranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;

/** X-1: the signed upload URL for one job. */
export const createUploadRequestSchema = z.strictObject({});
export const uploadTicketSchema = z.strictObject({
  jobId: idSchema,
  /** The tenant's object path, `audio/<tenantId>/<jobId>`. */
  path: z.string(),
  uploadUrl: z.string(),
  method: z.literal("PUT"),
  expiresAt: storedInstantSchema,
  maxBytes: z.number().int(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

const declaredBytes = z.number().int().min(1);
/** X-1, X-2: the enqueue request after the door checks; the literals are the owner's attestations. */
export const enqueueUploadPayloadSchema = z.strictObject({
  sourceKind: z.literal("media_upload"),
  jobId: idSchema,
  declaredBytes: declaredBytes.max(MAX_AUDIO_BYTES),
  rightsConfirmed: z.literal(true),
  containsHealthData: z.literal(false),
});
export const enqueueVoicemailPayloadSchema = z.strictObject({
  sourceKind: z.literal("voicemail"),
  voicemailId: idSchema,
});
export const enqueuePayloadSchema = z.discriminatedUnion("sourceKind", [enqueueUploadPayloadSchema, enqueueVoicemailPayloadSchema]);
export type EnqueuePayload = z.infer<typeof enqueuePayloadSchema>;

/** The enqueue request as a member sends it (X-1); the core door applies the refusals in the contract's order. */
export const enqueueRequestSchema = z.looseObject({ sourceKind: z.enum(["media_upload", "voicemail", "recorded_call"]) });

export const enqueueCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(TRANSCRIPTION_ENQUEUE_ACTION),
  target: targetSchema.extend({ type: z.literal(TRANSCRIPTION_JOB_TARGET) }),
  payload: enqueuePayloadSchema,
}));
export const enqueueResultSchema = z.strictObject({
  jobId: idSchema,
  status: transcriptionStatusSchema,
});
export type EnqueueResult = z.infer<typeof enqueueResultSchema>;
export const enqueueOutputSchema = z.lazy(() => actionResultSchema.extend({ result: enqueueResultSchema }));

/** X-7: segments in time order; the speaker is null or S1..S9. */
export const transcriptSegmentSchema = z.strictObject({
  startMs: z.number().int().min(0).max(MAX_AUDIO_MS),
  endMs: z.number().int().min(0).max(MAX_AUDIO_MS),
  speaker: z.string().regex(/^S[1-9]$/).nullable(),
  text: z.string().min(1).max(MAX_SEGMENT_TEXT),
}).refine((segment) => segment.endMs >= segment.startMs, { path: ["endMs"], message: "A segment ends after it starts" });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

const modelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._\/:@+-]*$/, "Not a model ID");
export const transcriptBodySchema = z.strictObject({
  modelIds: z.strictObject({ asr: modelId, align: modelId, diarize: modelId }),
  language: z.string().regex(/^[a-z]{2,8}$/),
  durationMs: z.number().int().min(0).max(MAX_AUDIO_MS),
  segments: z.array(transcriptSegmentSchema).max(MAX_TRANSCRIPT_SEGMENTS).superRefine((segments, ctx) => {
    for (let i = 1; i < segments.length; i += 1)
      if (segments[i]!.startMs < segments[i - 1]!.startMs)
        ctx.addIssue({ code: "custom", path: [i, "startMs"], message: "Segments are in time order" });
    if (segments.reduce((total, segment) => total + segment.text.length, 0) > MAX_TRANSCRIPT_TEXT)
      ctx.addIssue({ code: "custom", message: "Transcript text is too long" });
  }),
});
export type TranscriptBody = z.infer<typeof transcriptBodySchema>;

/** X-4: what the dispatcher stores for a completion; the server adds the lease token and attempt. */
export const completePayloadSchema = z.strictObject({
  jobId: idSchema,
  attempt: z.number().int().min(1).max(TRANSCRIPTION_MAX_ATTEMPTS),
  leaseToken: idSchema,
  transcript: transcriptBodySchema,
});
export type CompletePayload = z.infer<typeof completePayloadSchema>;
export const completeCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(TRANSCRIPTION_COMPLETE_ACTION),
  target: targetSchema.extend({ type: z.literal(TRANSCRIPTION_JOB_TARGET) }),
  payload: completePayloadSchema,
}));

export const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const failRequestSchema = z.strictObject({ errorCode: errorCodeSchema });
export const failPayloadSchema = z.strictObject({
  jobId: idSchema,
  attempt: z.number().int().min(1).max(TRANSCRIPTION_MAX_ATTEMPTS),
  leaseToken: idSchema,
  errorCode: errorCodeSchema,
});
export type FailPayload = z.infer<typeof failPayloadSchema>;
export const failCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(TRANSCRIPTION_FAIL_ACTION),
  target: targetSchema.extend({ type: z.literal(TRANSCRIPTION_JOB_TARGET) }),
  payload: failPayloadSchema,
}));

export const completeResultSchema = z.strictObject({
  jobId: idSchema,
  transcriptId: idSchema,
  status: z.literal("completed"),
});
export type CompleteResult = z.infer<typeof completeResultSchema>;
export const failResultSchema = z.strictObject({
  jobId: idSchema,
  status: z.enum(["failed", "dead_letter"]),
  nextAttemptAt: storedInstantSchema.nullable(),
});
export type FailResult = z.infer<typeof failResultSchema>;

/** X-4: what a claim hands the worker. */
export const claimedJobSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  sourceKind: transcriptionSourceKindSchema,
  attempt: z.number().int(),
  declaredBytes: z.number().int().nullable(),
  leaseToken: idSchema,
  leaseExpiresAt: storedInstantSchema,
  audioPath: z.string(),
});
export type ClaimedJob = z.infer<typeof claimedJobSchema>;
export const claimResponseSchema = z.strictObject({ job: claimedJobSchema.nullable() });
export type ClaimResponse = z.infer<typeof claimResponseSchema>;
export const heartbeatResponseSchema = z.strictObject({ leaseExpiresAt: storedInstantSchema });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/** X-7: the owner's reads. */
export const transcriptionJobFields = {
  id: idSchema,
  sourceKind: transcriptionSourceKindSchema,
  sourceId: idSchema.nullable(),
  status: transcriptionStatusSchema,
  attempts: z.number().int(),
  lastErrorCode: z.string().nullable(),
  createdAt: storedInstantSchema,
  completedAt: storedInstantSchema.nullable(),
};
export const transcriptionSummarySchema = z.strictObject({
  ...transcriptionJobFields,
  transcript: z.strictObject({
    id: idSchema,
    language: z.string(),
    durationMs: z.number().int(),
    speakerCount: z.number().int(),
    segmentCount: z.number().int(),
    createdAt: storedInstantSchema,
    expiresAt: storedInstantSchema,
  }).nullable(),
});
export type TranscriptionSummary = z.infer<typeof transcriptionSummarySchema>;
export const transcriptionListSchema = z.strictObject({ items: z.array(transcriptionSummarySchema) });
export type TranscriptionList = z.infer<typeof transcriptionListSchema>;
export const listTranscriptionsQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export const transcriptionDetailSchema = z.strictObject({
  ...transcriptionJobFields,
  transcript: z.strictObject({
    id: idSchema,
    modelIds: z.strictObject({ asr: z.string(), align: z.string(), diarize: z.string() }),
    language: z.string(),
    durationMs: z.number().int(),
    speakers: z.array(z.string()),
    segments: z.array(transcriptSegmentSchema),
    createdAt: storedInstantSchema,
    expiresAt: storedInstantSchema,
  }).nullable(),
});
export type TranscriptionDetail = z.infer<typeof transcriptionDetailSchema>;
