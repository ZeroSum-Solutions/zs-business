# Transcription

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: turn a tenant's audio into a speaker-labelled transcript that an owner reads in the
Inbox. Two sources in v1: voicemails left after a missed call (`twilio.md` T-13), and audio an
owner uploads (a podcast or a video's sound, for site copy ideas). The work runs on the pilot Mac
in a Python worker built on WhisperX: speech to text, word alignment, then speaker diarization.
The worker pulls jobs from the API; zs-business stays the system of record. A transcript is
data. Anything done with it (a reply, a post) goes through the normal draft and approval path.

Out of scope: live calls (`voice-receptionist.md`), recording calls, summaries and drafts made
from a transcript (they use the Cerebras lane in `docs/integrations.md` and their own
contract), languages whose alignment model is not under a commercial-use licence, and any
hosted or serverless GPU.

## Evidence and decisions

- `docs/integrations.md`: WhisperX is "Build: local Mac worker, pyannote licence accepted as a
  setup step", step 6 of the build order, owned by the Inbox.
- Research report R2 (2026-10-22), checked against the repo. WhisperX code is BSD-2-Clause; it
  chains faster-whisper (CTranslate2), a wav2vec2 aligner and pyannote.audio. CTranslate2 has
  CPU and CUDA backends only, so on the Mac stage 1 runs on the CPU. The English aligner
  (`WAV2VEC2_ASR_BASE_960H`) ships with torchaudio (BSD-2-Clause) and its weights come from
  fairseq (MIT); some aligners for other languages carry
  non-commercial weights. `docs/licenses.md` lists WhisperX (BSD-2-Clause) and the pyannote
  weights (CC-BY-4.0, attribution in `NOTICE`) in its 2026-10-22 table.
- Model sizes from the report (to be measured, X-10): `large-v3-turbo` is about 0.85 GB in
  int8, the aligner about 0.36 GB, diarization about 1.5 to 1.8 GB peak. All three fit in the
  pilot Mac's memory with room to spare.
- Transcription and the voice receptionist run on the local pilot Mac only; no hosted GPU, no
  serverless GPU: decided 2026-10-22 (coordinator, standing approval).
- Speech-to-text is local (whisper on the Mac). Deepgram, Cartesia, ElevenLabs and other
  speech vendors are not used: decided 2026-10-22 (coordinator, standing approval).
- `pyannote/speaker-diarization-community-1` (CC-BY-4.0) is approved. Accepting its Hugging Face
  gate and storing a read-only token in the vault is a setup step the repo owner runs, not
  part of any build slice; the worker runs with local weights only: decided 2026-10-22
  (coordinator, standing approval).
- The Mac worker may use mlx-whisper (Metal) for stage 1 when faster-whisper on the CPU misses
  the real-time-factor target (X-10), behind the same port: decided 2026-10-22 (supervisor
  brief).
- The Mac worker pulls jobs from the API over HTTPS with a scoped token and exposes no inbound
  port: decided 2026-10-22 (supervisor brief).
- No health or medical audio, from any source: decided 2026-10-22 (supervisor brief).

## Rules

**X-1. Sources.** `transcription.job.enqueue` takes a `sourceKind`:
- `voicemail`: names a `voicemails` row of the tenant (`twilio.md` T-13) whose recording has
  not expired. The server enqueues it when the tenant's `transcribe_voicemails` setting is on
  (default off), keyed `transcript:<voicemailId>`.
- `media_upload`: an owner or staff member with `inbox.drafts` asks
  `POST /v1/transcriptions/uploads` for a short-lived signed upload URL to the tenant's path
  `audio/<tenantId>/<jobId>`, uploads, then enqueues with `{ jobId, declaredBytes,
  rightsConfirmed: true, containsHealthData: false }`.
- `recorded_call`: refused with 409 `consent_required` until a contract that records calls,
  with a disclosure the caller heard first, adds it. No contract records calls today.
An unknown source, a voicemail of another tenant or an expired one is 404 `NotFound`.

**X-2. No health or medical audio.** A `media_upload` without `containsHealthData: false` is
422 `health_data_forbidden`. Turning `transcribe_voicemails` on needs the owner's attestation
that the business does not take health or medical information by phone; without it the
setting stays off (422 `health_data_forbidden`). Nothing in this file screens audio content;
the refusal is at the door.

**X-3. Jobs and leases.** `transcription_jobs` moves `queued` → `running` → `completed`, or to
`failed` (retry) and `dead_letter`. The worker claims the oldest due job with
`FOR UPDATE SKIP LOCKED`, setting a fresh lease token and an expiry 10 minutes ahead; a
heartbeat extends it. Every later write checks the token, so a worker that lost its lease
writes nothing (`delivery.md` D-3). A job gets 3 attempts; then it is a dead letter with the
last error code. Time comes from the injected clock, never SQL `now()`.

**X-4. The worker's reach.** The worker holds one token, `TRANSCRIPTION_WORKER_TOKEN`, and
calls only these API routes over HTTPS, with Bearer auth compared in constant time:
`POST /worker/v1/transcription/claim`, `GET /worker/v1/transcription/jobs/:id/audio`,
`POST .../jobs/:id/heartbeat`, `POST .../jobs/:id/complete` and `POST .../jobs/:id/fail`.
Each route after claim needs the job's current lease token. The audio route serves only the
leased job's audio: from the tenant's storage path, or streamed from Twilio for a voicemail.
Completion runs through the dispatcher as a server-built principal per tenant,
`derivedId(tenantId, "transcription-worker", "actor")`, that may run
`transcription.job.complete` and `transcription.job.fail` only, keyed
`transcript:<jobId>:<attempt>`. `transcript:` joins `SERVER_IDEMPOTENCY_PREFIXES`
(`approvals.md` A-14). The worker cannot read contacts, bookings, slots or replies. The Mac
opens no inbound port.

**X-5. Tenancy and scratch.** `transcription_jobs` and `transcripts` have `tenant_id`, forced
RLS with `tenant_scope`, tenant-qualified foreign keys, and are in the catalog isolation test.
On the Mac, a job's files live under `<scratch_root>/<tenantId>/<jobId>/`, removed when the
job ends (success or error) and swept at worker start. Model caches are shared because they
hold no tenant data. A two-tenant test proves that tenant B cannot read tenant A's jobs or
transcripts and that a lease token for A's job cannot fetch B's audio.

**X-6. Local weights only.** The worker starts with Hugging Face offline mode on and loads
models from a local model folder only. A missing weight file, a model not on the allow list
(stage 1: `large-v3-turbo`, `large-v3`, `small.en`, or their mlx-whisper builds; the English
aligner; `pyannote/speaker-diarization-community-1`), or an aligner whose licence forbids
commercial use stops the worker at start with a named error. The Hugging Face token is used
only by the owner's one-time download; the running worker never reads it.

**X-7. The transcript.** `complete` carries `{ modelIds: { asr, align, diarize }, language,
durationMs, segments: [{ startMs, endMs, speaker, text }] }`, checked by a strict schema:
segments in time order, `speaker` null or `S1`..`S9`, each text at most 2000 characters, at
most 5000 segments. It inserts one `transcripts` row per job. The Inbox shows it under its
voicemail, and an upload's transcript under Transcripts (owner routes `GET /v1/transcriptions`
and `GET /v1/transcriptions/:id`, permission `inbox.drafts`). Transcript text is data: it is
never run as an instruction, and any draft built from it needs an owner's approval
(`approvals.md` A-6, `inbox-home.md` I-6).

**X-8. Retention.** Uploaded audio is deleted 30 days after upload, or when its job completes
or dead-letters, whichever comes first. Voicemail audio follows `twilio.md` T-13. Transcripts
carry `expires_at` 90 days after creation, and a daily job deletes expired rows. Erasing a
contact deletes the transcripts of that contact's voicemails in the same transaction.

**X-9. Bounds.** An upload's `declaredBytes` is at most 100 MiB (413 otherwise). Before
decoding, the worker probes the file: more than 100 MiB, more than 60 minutes, or a container
other than WAV, MP3, M4A, OGG, WebM or FLAC fails the job without retry (`audio_too_large`,
`audio_too_long`, `audio_format`).

**X-10. Speed target.** On the pilot Mac, a 5-minute two-speaker call finishes all three stages
with a real-time factor (wall time divided by audio length) of at most 0.25. A benchmark script
measures 30-second voicemail, 5-minute call and 30-minute podcast samples and records RTF, p95,
peak memory and word error rate per model. If faster-whisper on the CPU misses the target,
stage 1 switches to mlx-whisper behind the same routes; the job records which ran in
`modelIds.asr`.

**X-11. Cost.** Transcription runs on the Mac at no per-job price, so it reserves nothing in the
wallet. A priced lane would need a new revision that reserves through `delivery.md` D-11.

## First slice

Migration (`transcription_jobs`, `transcripts`, forced RLS), `transcription.job.enqueue` for
`media_upload` and `voicemail`, the five worker routes with token and lease checks, and a
TypeScript `FakeTranscriptionWorker` that claims a job and completes it with fixed segments.
`pnpm -r test` needs no Python. The Python worker and the benchmark follow in their own slice.

Acceptance test (real Postgres under `zs_runtime`): a `recorded_call` enqueue is 409
`consent_required`; an upload with `containsHealthData` missing is 422
`health_data_forbidden`; a Halden & Rowe upload enqueues, the fake worker claims it, fetches its
audio, and completes it; `GET /v1/transcriptions/:id` returns two speakers' segments in order. A
complete with a stale lease token writes nothing. A replayed complete writes no second row.
Three failures make a dead letter. A wrong worker token is 401. Tenant B cannot read A's job or
transcript, and A's lease token cannot fetch B's audio.

## Known limits

- The pyannote attribution must be in `NOTICE` before the Python worker lands.
  `docs/licenses.md` lists the aligner, faster-whisper and mlx-whisper.
- The voicemail entry in the Inbox depends on the `inbox-home.md` revision named in
  `twilio.md` Known limits (revision 3).
- Signed upload URLs need a storage bucket for tenant audio; none exists yet. Its choice and
  setup belong to this file's first slice.
- One worker on one Mac: when the Mac is off, jobs wait. There is no hosted fallback by
  decision.
- English only in v1. Other languages wait for an aligner with a commercial-use licence.
- The health refusal relies on attestations. A caller can still say health details in a
  voicemail; the business's attestation is what keeps such a line off.
