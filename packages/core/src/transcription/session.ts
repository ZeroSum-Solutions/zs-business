// Transcription edge (docs/requirements/transcription.md X-1..X-4, X-7, X-9). Two doors:
//  - the member's: signed upload, enqueue, list, read. Owners and staff with inbox.drafts.
//  - the worker's: claim, heartbeat, audio, complete, fail. The route has already checked the
//    worker token. Every call after the claim names a job and a lease token; the token alone says
//    which tenant the job belongs to, so a worker never names a tenant (X-4).
// The worker's writes dispatch as a server-built principal that may run only complete and fail.
import {
  Conflict,
  MAX_AUDIO_BYTES,
  NotFound,
  Refused,
  TRANSCRIPTION_COMPLETE_ACTION,
  TRANSCRIPTION_ENQUEUE_ACTION,
  TRANSCRIPTION_FAIL_ACTION,
  TRANSCRIPTION_JOB_TARGET,
  TRANSCRIPTION_LEASE_MS,
  TRANSCRIPTION_MAX_ATTEMPTS,
  TenantDenied,
  claimedJobSchema,
  completePayloadSchema,
  createUploadRequestSchema,
  enqueuePayloadSchema,
  enqueueRequestSchema,
  failPayloadSchema,
  failRequestSchema,
  transcriptBodySchema,
  uuidSchema,
  type ActionResult,
  type JsonValue,
  type ClaimedJob,
  type CompleteResult,
  type EnqueueResult,
  type FailResult,
  type HeartbeatResponse,
  type TranscriptionDetail,
  type TranscriptionSummary,
  type UploadTicket,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { Authorize, EdgeDependencies, Principal } from "../edge/session.js";
import { directDispatch, parseInput } from "../edge/session.js";
import { validationError } from "../edge/errors.js";
import { derivedId } from "../edge/ids.js";
import { iso } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import { transcriptionActorId, voicemailJobId } from "./handlers.js";
import { audioPath, type AudioObject, type TranscriptionAudioStore, type VoicemailSource } from "./ports.js";

export interface TranscriptionConfig {
  readonly audio: TranscriptionAudioStore;
  /** Absent: voicemail jobs are off (the missed-call slice wires it). */
  readonly voicemails?: VoicemailSource;
}

/** The lease a worker presents, resolved to the tenant it belongs to. */
interface Lease {
  readonly tenantId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: string;
  readonly sourceKind: "media_upload" | "voicemail";
  readonly sourceId: string | null;
}

const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

/** A member enqueues an owner upload only: a voicemail job is the server's. */
const memberUploads = (tenantId: string, actorId: string): Authorize => async (tx, binding) => {
  if (binding.actionType !== TRANSCRIPTION_ENQUEUE_ACTION) throw new TenantDenied();
  const kind = (binding.payload as { sourceKind?: unknown } | null)?.sourceKind;
  if (kind !== "media_upload") throw new TenantDenied();
  await requireMember(tx, tenantId, actorId, "inbox.drafts");
};

/** The payload as the JSON the dispatcher stores. */
const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const approvalFor = (tenantId: string, key: string) => ({ tenantId, id: derivedId(tenantId, key, "approval") });

type DetailTranscript = NonNullable<TranscriptionDetail["transcript"]>;
interface JobRow {
  id: string;
  source_kind: "media_upload" | "voicemail";
  source_id: string | null;
  status: TranscriptionSummary["status"];
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  t_id: string | null;
  t_model_ids: DetailTranscript["modelIds"];
  t_language: string | null;
  t_duration_ms: number | null;
  t_speaker_count: number | null;
  t_segments: DetailTranscript["segments"];
  t_created_at: Date | null;
  t_expires_at: Date | null;
}
const jobColumns = `j.id, j.source_kind, j.source_id, j.status, j.attempts, j.last_error_code, j.created_at, j.completed_at,
  t.id AS t_id, t.model_ids AS t_model_ids, t.language AS t_language, t.duration_ms AS t_duration_ms,
  t.speaker_count AS t_speaker_count, t.segments AS t_segments, t.created_at AS t_created_at, t.expires_at AS t_expires_at`;
const jobFrom = "FROM transcription_jobs j LEFT JOIN transcripts t ON t.tenant_id=j.tenant_id AND t.job_id=j.id";

function jobFields(row: JobRow) {
  return {
    id: row.id, sourceKind: row.source_kind, sourceId: row.source_id, status: row.status, attempts: row.attempts,
    lastErrorCode: row.last_error_code, createdAt: iso(row.created_at), completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

export function createTranscriptionSession(deps: EdgeDependencies, config: TranscriptionConfig) {
  const now = () => new Date(deps.clock.now());

  async function readOne(tenantId: string, jobId: string): Promise<JobRow | undefined> {
    return deps.db.tenant(tenantId, async (tx) => (await tx.query<JobRow>(
      `SELECT ${jobColumns} ${jobFrom} WHERE j.tenant_id=$1 AND j.id=$2`, [tenantId, jobId])).rows[0]);
  }

  /** The lease for this job and token, if the token is the one the job holds. */
  async function lease(jobId: string, token: string): Promise<Lease | null> {
    const ids = uuidSchema.safeParse(jobId);
    const secret = uuidSchema.safeParse(token);
    if (!ids.success || !secret.success) return null;
    if (!deps.db.platform) throw new Error("The transcription worker needs the platform transaction");
    const row = await deps.db.platform(async (tx) => (await tx.query<{
      tenant_id: string; attempts: number; status: string; source_kind: Lease["sourceKind"]; source_id: string | null;
    }>(
      "SELECT tenant_id, attempts, status, source_kind, source_id FROM transcription_jobs WHERE id=$1 AND lease_token=$2",
      [ids.data, secret.data])).rows[0]);
    return row
      ? { tenantId: row.tenant_id, jobId: ids.data, attempt: row.attempts, status: row.status, sourceKind: row.source_kind, sourceId: row.source_id }
      : null;
  }

  function enqueue(tenantId: string, run: ReturnType<typeof directDispatch>, jobId: string, key: string, payload: unknown): Promise<ActionResult> {
    return run({
      actionType: TRANSCRIPTION_ENQUEUE_ACTION,
      target: { tenantId, type: TRANSCRIPTION_JOB_TARGET, id: jobId },
      approvalReference: approvalFor(tenantId, key),
      idempotencyKey: key,
      payload: toJson(payload),
    });
  }

  /** Delete the audio after a job ends. Best effort: the daily sweep (X-8) is the backstop. */
  async function dropAudio(l: Lease): Promise<void> {
    if (l.sourceKind !== "media_upload") return;
    try { await config.audio.delete(audioPath(l.tenantId, l.jobId)); } catch { /* the sweep removes it */ }
  }

  return {
    /** The member door. */
    forMember(principal: Principal) {
      const tenantId = uuidSchema.parse(principal.tenantId);
      const actorId = uuidSchema.parse(principal.actorId);
      const asMember = <T>(work: (tx: Transaction) => Promise<T>) =>
        deps.db.tenant(tenantId, async (tx) => { await requireMember(tx, tenantId, actorId, "inbox.drafts"); return work(tx); });
      const run = directDispatch(deps, tenantId, actorId, memberUploads(tenantId, actorId), { voicemails: config.voicemails });
      return {
        /** X-1: a signed URL for one upload. The same key gives the same job ID. */
        async createUpload(body: unknown, key: string): Promise<UploadTicket> {
          parseInput(createUploadRequestSchema, body);
          await asMember(async () => undefined);
          const jobId = derivedId(tenantId, key, "transcription_upload");
          const path = audioPath(tenantId, jobId);
          const signed = await config.audio.signUpload({ path, maxBytes: MAX_AUDIO_BYTES, now: now() });
          return { jobId, path, uploadUrl: signed.uploadUrl, method: signed.method, expiresAt: iso(signed.expiresAt), maxBytes: MAX_AUDIO_BYTES };
        },
        /**
         * X-1, X-2, X-9: the door, in the contract's order. A recorded call is refused; an upload
         * must say it holds no health data and that the owner has the rights; the size and the
         * stored object must fit. Only then does the dispatcher run.
         */
        async enqueue(body: unknown, key: string): Promise<ActionResult & { result: EnqueueResult }> {
          const loose = parseInput(enqueueRequestSchema, body);
          if (loose.sourceKind === "recorded_call")
            throw new Conflict("Recording calls is not available", { reason: "consent_required" });
          if (loose.sourceKind === "voicemail") throw new TenantDenied();
          if (loose.containsHealthData !== false) throw new Refused(422, "health_data_forbidden", "No health or medical audio");
          if (loose.rightsConfirmed !== true)
            throw validationError("Invalid request", [{ path: ["rightsConfirmed"], message: "Confirm you have the right to transcribe this audio" }]);
          if (typeof loose.declaredBytes === "number" && loose.declaredBytes > MAX_AUDIO_BYTES)
            throw new Refused(413, "audio_too_large", "Audio is over the size limit");
          const payload = parseInput(enqueuePayloadSchema, loose);
          if (payload.sourceKind !== "media_upload") throw new TenantDenied();
          await asMember(async () => undefined);
          // A replay finds the job and skips the object check; the dispatcher then replays the result.
          const existing = await readOne(tenantId, payload.jobId);
          if (!existing) {
            const stored = await config.audio.head(audioPath(tenantId, payload.jobId));
            if (!stored) throw new NotFound();
            if (stored.bytes > MAX_AUDIO_BYTES || stored.bytes > payload.declaredBytes)
              throw new Refused(413, "audio_too_large", "Audio is over the size limit");
          }
          return await enqueue(tenantId, run, payload.jobId, key, payload) as ActionResult & { result: EnqueueResult };
        },
        async list(limit: number): Promise<TranscriptionSummary[]> {
          return asMember(async (tx) => (await tx.query<JobRow>(
            `SELECT ${jobColumns} ${jobFrom} WHERE j.tenant_id=$1 ORDER BY j.created_at DESC, j.id DESC LIMIT $2`, [tenantId, limit],
          )).rows.map((row) => ({
            ...jobFields(row),
            transcript: row.t_id === null ? null : {
              id: row.t_id, language: row.t_language!, durationMs: row.t_duration_ms!, speakerCount: row.t_speaker_count!,
              segmentCount: row.t_segments.length, createdAt: iso(row.t_created_at!), expiresAt: iso(row.t_expires_at!),
            },
          })));
        },
        async get(jobId: string): Promise<TranscriptionDetail> {
          const id = uuidSchema.safeParse(jobId);
          if (!id.success) throw new NotFound();
          const row = await asMember(async (tx) => (await tx.query<JobRow>(
            `SELECT ${jobColumns} ${jobFrom} WHERE j.tenant_id=$1 AND j.id=$2`, [tenantId, id.data])).rows[0]);
          if (!row) throw new NotFound();
          return {
            ...jobFields(row),
            transcript: row.t_id === null ? null : {
              id: row.t_id, modelIds: row.t_model_ids, language: row.t_language!, durationMs: row.t_duration_ms!,
              speakers: [...new Set(row.t_segments.flatMap((s) => (s.speaker === null ? [] : [s.speaker])))].sort(),
              segments: row.t_segments, createdAt: iso(row.t_created_at!), expiresAt: iso(row.t_expires_at!),
            },
          };
        },
      };
    },

    /** The server door for a voicemail (X-1); the missed-call slice calls it when a voicemail lands. */
    async enqueueVoicemail(tenantId: string, voicemailId: string): Promise<ActionResult> {
      const tenant = uuidSchema.parse(tenantId);
      const voicemail = uuidSchema.parse(voicemailId);
      const run = directDispatch(deps, tenant, transcriptionActorId(tenant), only(TRANSCRIPTION_ENQUEUE_ACTION), { voicemails: config.voicemails });
      return enqueue(tenant, run, voicemailJobId(tenant, voicemail), `transcript:${voicemail}`, { sourceKind: "voicemail", voicemailId: voicemail });
    },

    /** The worker door. */
    worker: {
      /**
       * X-3, X-4: lease the oldest due job across all tenants, or nothing. A running job whose
       * lease ended is taken again, and one that has used its third attempt becomes a dead letter.
       */
      async claim(): Promise<ClaimedJob | null> {
        if (!deps.db.platform) throw new Error("The transcription worker needs the platform transaction");
        const at = now();
        const stamp = iso(at);
        const claimed = await deps.db.platform(async (tx) => {
          await tx.query(
            `UPDATE transcription_jobs SET status='dead_letter', last_error_code='lease_expired', updated_at=$1
              WHERE status='running' AND lease_expires_at <= $1 AND attempts >= $2`,
            [stamp, TRANSCRIPTION_MAX_ATTEMPTS]);
          const due = (await tx.query<{ tenant_id: string; id: string }>(
            `SELECT tenant_id, id FROM transcription_jobs
              WHERE (status IN ('queued','failed') AND next_attempt_at <= $1)
                 OR (status='running' AND lease_expires_at <= $1 AND attempts < $2)
              ORDER BY next_attempt_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [stamp, TRANSCRIPTION_MAX_ATTEMPTS])).rows[0];
          if (!due) return null;
          const leaseToken = deps.generateId();
          const expires = iso(new Date(at.getTime() + TRANSCRIPTION_LEASE_MS));
          const row = (await tx.query<{ tenant_id: string; id: string; source_kind: ClaimedJob["sourceKind"]; declared_bytes: number | null; attempts: number }>(
            `UPDATE transcription_jobs SET status='running', attempts=attempts+1, lease_token=$3, lease_expires_at=$4, updated_at=$5
              WHERE tenant_id=$1 AND id=$2 RETURNING tenant_id, id, source_kind, declared_bytes, attempts`,
            [due.tenant_id, due.id, leaseToken, expires, stamp])).rows[0]!;
          return { row, leaseToken, expires };
        });
        if (!claimed) return null;
        const { row, leaseToken, expires } = claimed;
        return claimedJobSchema.parse({
          id: row.id, tenantId: row.tenant_id, sourceKind: row.source_kind, attempt: row.attempts, declaredBytes: row.declared_bytes,
          leaseToken, leaseExpiresAt: expires, audioPath: `/worker/v1/transcription/jobs/${row.id}/audio`,
        });
      },

      /** X-3: extend the lease while the work runs. A lost lease is a 409. */
      async heartbeat(jobId: string, token: string): Promise<HeartbeatResponse> {
        const held = await lease(jobId, token);
        if (!held || held.status !== "running") throw new Conflict("The lease is no longer held", { reason: "lease_lost" });
        const at = now();
        const expires = iso(new Date(at.getTime() + TRANSCRIPTION_LEASE_MS));
        const updated = await deps.db.tenant(held.tenantId, async (tx) => (await tx.query(
          `UPDATE transcription_jobs SET lease_expires_at=$4, updated_at=$5
            WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='running'`,
          [held.tenantId, held.jobId, token, expires, iso(at)])).rowCount);
        if (updated !== 1) throw new Conflict("The lease is no longer held", { reason: "lease_lost" });
        return { leaseExpiresAt: expires };
      },

      /** X-4: the job's audio, for the holder of a running lease on that exact job. */
      async audio(jobId: string, token: string): Promise<AudioObject> {
        const held = await lease(jobId, token);
        if (!held || held.status !== "running") throw new NotFound();
        const found = held.sourceKind === "voicemail"
          ? held.sourceId && config.voicemails ? await config.voicemails.open(held.tenantId, held.sourceId) : null
          : await config.audio.read(audioPath(held.tenantId, held.jobId));
        if (!found) throw new NotFound();
        return found;
      },

      /** X-4, X-7: one transcript per job; a replay of the same completion returns the first result. */
      async complete(jobId: string, token: string, body: unknown): Promise<CompleteResult> {
        const transcript = parseInput(transcriptBodySchema, body, "transcript");
        const held = await lease(jobId, token);
        if (!held) throw new Conflict("The lease is no longer held", { reason: "lease_lost" });
        const key = `transcript:${held.jobId}:${held.attempt}`;
        const payload = completePayloadSchema.parse({ jobId: held.jobId, attempt: held.attempt, leaseToken: token, transcript });
        const run = directDispatch(deps, held.tenantId, transcriptionActorId(held.tenantId), only(TRANSCRIPTION_COMPLETE_ACTION));
        const done = await run({
          actionType: TRANSCRIPTION_COMPLETE_ACTION,
          target: { tenantId: held.tenantId, type: TRANSCRIPTION_JOB_TARGET, id: held.jobId },
          approvalReference: approvalFor(held.tenantId, key),
          idempotencyKey: key,
          payload: toJson(payload),
        });
        await dropAudio(held);
        return done.result as CompleteResult;
      },

      /** X-3, X-9: record a failed attempt; the job retries later or becomes a dead letter. */
      async fail(jobId: string, token: string, body: unknown): Promise<FailResult> {
        const { errorCode } = parseInput(failRequestSchema, body);
        const held = await lease(jobId, token);
        if (!held) throw new Conflict("The lease is no longer held", { reason: "lease_lost" });
        const key = `transcript:${held.jobId}:${held.attempt}:fail`;
        const payload = failPayloadSchema.parse({ jobId: held.jobId, attempt: held.attempt, leaseToken: token, errorCode });
        const run = directDispatch(deps, held.tenantId, transcriptionActorId(held.tenantId), only(TRANSCRIPTION_FAIL_ACTION));
        const done = await run({
          actionType: TRANSCRIPTION_FAIL_ACTION,
          target: { tenantId: held.tenantId, type: TRANSCRIPTION_JOB_TARGET, id: held.jobId },
          approvalReference: approvalFor(held.tenantId, key),
          idempotencyKey: key,
          payload: toJson(payload),
        });
        const result = done.result as FailResult;
        if (result.status === "dead_letter") await dropAudio(held);
        return result;
      },
    },
  };
}
export type TranscriptionSession = ReturnType<typeof createTranscriptionSession>;
