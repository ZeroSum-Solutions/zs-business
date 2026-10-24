// Transcription actions (docs/requirements/transcription.md X-1..X-4, X-7) through the shared
// dispatcher: enqueue a job, record the worker's transcript, record a failed attempt. The member
// and the worker reach them through the transcription session, which authorizes each principal for
// the actions it may run. A completion or failure whose lease token, attempt or status no longer
// match throws Conflict, which rolls back: a stale worker writes nothing (X-3).
import {
  Conflict,
  NotFound,
  TRANSCRIPTION_COMPLETE_ACTION,
  TRANSCRIPTION_ENQUEUE_ACTION,
  TRANSCRIPTION_FAIL_ACTION,
  TRANSCRIPTION_FINAL_ERRORS,
  TRANSCRIPTION_JOB_TARGET,
  TRANSCRIPTION_MAX_ATTEMPTS,
  TenantDenied,
  ValidationFailed,
  completeCommandSchema,
  enqueueCommandSchema,
  failCommandSchema,
  type JsonValue,
  type Target,
  type TranscriptSegment,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail, pgCode, tenantVisible } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import type { VoicemailSource } from "./ports.js";

/** X-8: a transcript is kept 90 days. */
export const TRANSCRIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** X-3: the wait after a failed attempt doubles from 30 s. */
export const RETRY_BASE_MS = 30_000;

/** The principal that runs the worker's completions and a voicemail's enqueue (agents.md G-1 pattern). */
export const transcriptionActorId = (tenantId: string): string => derivedId(tenantId, "transcription-worker", "actor");
/** The job a voicemail gets: derived, so a second enqueue of the same voicemail is the same job (X-3). */
export const voicemailJobId = (tenantId: string, voicemailId: string): string => derivedId(tenantId, voicemailId, "transcription_job");

export interface TranscriptionDispatchConfig {
  readonly voicemails?: VoicemailSource;
}

async function resolveJob(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== TRANSCRIPTION_JOB_TARGET) throw new ValidationFailed("Transcription actions require a transcription_job target");
  if (!(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: TRANSCRIPTION_JOB_TARGET, id: target.id };
}

export const enqueueTranscriptionHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(enqueueCommandSchema, command);
    const at = clockInstant(now);
    let jobId: string;
    let sourceId: string | null = null;
    let declaredBytes: number | null = null;
    if (payload.sourceKind === "voicemail") {
      // X-1: only the server enqueues a voicemail, and only one this tenant has.
      if (binding.actorId !== transcriptionActorId(binding.tenantId)) throw new TenantDenied();
      const voicemails = (config as TranscriptionDispatchConfig).voicemails;
      if (!voicemails || !(await voicemails.find(tx, binding.tenantId, payload.voicemailId))) throw new NotFound();
      jobId = voicemailJobId(binding.tenantId, payload.voicemailId);
      sourceId = payload.voicemailId;
    } else {
      jobId = payload.jobId;
      declaredBytes = payload.declaredBytes;
    }
    if (command.target.id !== jobId) throw new ValidationFailed("The job ID does not match the request");
    try {
      await tx.query(
        `INSERT INTO transcription_jobs (tenant_id,id,source_kind,source_id,declared_bytes,status,attempts,next_attempt_at,requested_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'queued',0,$6,$7,$6,$6)`,
        [binding.tenantId, jobId, payload.sourceKind, sourceId, declaredBytes, at, binding.actorId],
      );
    } catch (error) {
      if (pgCode(error) === "23505") throw new Conflict("The job ID is already in use", { reason: "id_in_use" });
      throw error;
    }
    return { result: { jobId, status: "queued" } as JsonValue, event: { type: "transcription.job.queued", payload: { jobId } } };
  },
};

interface LeasedJob {
  status: string;
  attempts: number;
  lease_token: string | null;
}

/** Lock the job and check the worker still holds the lease for this attempt. */
async function lockLeased(tx: Transaction, tenantId: string, jobId: string, leaseToken: string, attempt: number): Promise<LeasedJob> {
  const job = (await tx.query<LeasedJob>(
    "SELECT status, attempts, lease_token FROM transcription_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenantId, jobId],
  )).rows[0];
  if (!job) throw new NotFound();
  if (job.status !== "running" || job.lease_token !== leaseToken || job.attempts !== attempt)
    throw new Conflict("The lease is no longer held", { reason: "lease_lost" });
  return job;
}

/** X-7: a speaker count is the number of distinct labels. */
const speakersOf = (segments: readonly TranscriptSegment[]): string[] =>
  [...new Set(segments.flatMap((segment) => (segment.speaker === null ? [] : [segment.speaker])))].sort();

export const completeTranscriptionHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now, generateId }) {
    if (binding.actorId !== transcriptionActorId(binding.tenantId)) throw new TenantDenied();
    const { payload } = parseOrFail(completeCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const at = clockInstant(now);
    await lockLeased(tx, binding.tenantId, payload.jobId, payload.leaseToken, payload.attempt);
    const job = (await tx.query<{ source_kind: string; source_id: string | null }>(
      "SELECT source_kind, source_id FROM transcription_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.jobId],
    )).rows[0]!;
    const { transcript } = payload;
    const transcriptId = generateId();
    await tx.query(
      `INSERT INTO transcripts (tenant_id,id,job_id,source_kind,source_id,attempt,model_ids,language,duration_ms,speaker_count,segments,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13)`,
      [
        binding.tenantId, transcriptId, payload.jobId, job.source_kind, job.source_id, payload.attempt,
        JSON.stringify(transcript.modelIds), transcript.language, transcript.durationMs, speakersOf(transcript.segments).length,
        JSON.stringify(transcript.segments), at, new Date(now.getTime() + TRANSCRIPT_RETENTION_MS).toISOString(),
      ],
    );
    await tx.query(
      "UPDATE transcription_jobs SET status='completed', last_error_code=NULL, completed_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
      [binding.tenantId, payload.jobId, at],
    );
    return {
      result: { jobId: payload.jobId, transcriptId, status: "completed" } as JsonValue,
      event: { type: "transcription.job.completed", payload: { jobId: payload.jobId, transcriptId } },
    };
  },
};

export const failTranscriptionHandler: ActionHandler = {
  resolveTarget: resolveJob,
  async handle({ tx, command, binding, now }) {
    if (binding.actorId !== transcriptionActorId(binding.tenantId)) throw new TenantDenied();
    const { payload } = parseOrFail(failCommandSchema, command);
    if (command.target.id !== payload.jobId) throw new ValidationFailed("The job ID does not match the request");
    const at = clockInstant(now);
    const job = await lockLeased(tx, binding.tenantId, payload.jobId, payload.leaseToken, payload.attempt);
    // X-9: a failure no retry can fix, or the third failure, ends the job.
    const dead = TRANSCRIPTION_FINAL_ERRORS.includes(payload.errorCode) || job.attempts >= TRANSCRIPTION_MAX_ATTEMPTS;
    const status = dead ? "dead_letter" : "failed";
    const nextAttemptAt = dead ? null : new Date(now.getTime() + RETRY_BASE_MS * 2 ** (job.attempts - 1)).toISOString();
    await tx.query(
      `UPDATE transcription_jobs SET status=$3, last_error_code=$4, next_attempt_at=coalesce($5::timestamptz, next_attempt_at),
         lease_expires_at=$6, updated_at=$6 WHERE tenant_id=$1 AND id=$2`,
      [binding.tenantId, payload.jobId, status, payload.errorCode, nextAttemptAt, at],
    );
    return {
      result: { jobId: payload.jobId, status, nextAttemptAt } as JsonValue,
      event: { type: dead ? "transcription.job.dead_letter" : "transcription.job.failed", payload: { jobId: payload.jobId, errorCode: payload.errorCode } },
    };
  },
};

export const transcriptionHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [TRANSCRIPTION_ENQUEUE_ACTION]: enqueueTranscriptionHandler,
  [TRANSCRIPTION_COMPLETE_ACTION]: completeTranscriptionHandler,
  [TRANSCRIPTION_FAIL_ACTION]: failTranscriptionHandler,
});
