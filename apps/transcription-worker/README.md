# Transcription worker

The local worker that turns audio into speaker-labelled transcripts for
`docs/requirements/transcription.md`. It runs on the pilot Mac, pulls jobs from the API
over HTTPS, and opens no inbound port.

Status: this slice ships the job interface (API routes, queue tables, TypeScript fake
worker) and this setup guide. The Python worker and the benchmark script follow in their
own slice (transcription.md, "First slice"). Nothing here downloads a model.

## What the worker does

Three stages per job, all local:

1. Speech to text: `large-v3-turbo` with faster-whisper (CPU). If the benchmark misses a
   real-time factor of 0.25 (X-10), switch to mlx-whisper (Metal) behind the same routes.
   The job records which ran in `modelIds.asr`.
2. Word alignment: the English wav2vec2 aligner.
3. Diarization: `pyannote/speaker-diarization-community-1`.

WhisperX (BSD-2-Clause) wraps stages 1 to 3. It runs as a separate local process; no
WhisperX code is copied into this repo (`docs/licenses.md`).

## One-time setup (repo owner)

An agent never does these steps (`docs/integrations.md`, "Setup steps the repo owner runs").

### 1. Install

```sh
python3 -m venv ~/transcription-worker/.venv
~/transcription-worker/.venv/bin/pip install whisperx
```

Pin the version you tested in the slice that adds the Python worker.

### 2. Accept the pyannote gate

1. Sign in to Hugging Face as devszerosum@gmail.com.
2. Open `https://huggingface.co/pyannote/speaker-diarization-community-1` and accept the
   conditions. The weights are CC-BY-4.0; the attribution is in `/NOTICE`.
3. Create a read-only access token (Settings, Access Tokens, type "Read") and store it in
   ZS Vault: `zsvault add huggingface-read`. Do not paste it into a file, chat or shell
   history.

### 3. Download the weights once

Run the download with the token in the environment for that one command only
(`zsvault get huggingface-read` prints it for you to export). Put the weights in the local
model folder, for example `~/transcription-worker/models`:

- `large-v3-turbo` (about 0.85 GB int8), or `large-v3` or `small.en`
- the English aligner (about 0.36 GB)
- `pyannote/speaker-diarization-community-1` (about 1.5 to 1.8 GB peak when running)

The token is used only by this download. The running worker never reads it (X-6).

### 4. Create the worker token

Generate a random value of at least 32 characters, store it in ZS Vault as
`transcription-worker-token`, and set the same value on the API as
`TRANSCRIPTION_WORKER_TOKEN`. The API refuses a shorter token. Rotate it by changing both.

## Configuration

The worker reads its settings from the environment at start:

| Variable | Meaning |
|---|---|
| `TRANSCRIPTION_API_URL` | Base URL of the API, for example `https://api.example.com`. HTTPS only. |
| `TRANSCRIPTION_WORKER_TOKEN` | The bearer token from step 4. |
| `TRANSCRIPTION_MODEL_DIR` | The local model folder from step 3. |
| `TRANSCRIPTION_SCRATCH_ROOT` | Where job files live: `<scratch_root>/<tenantId>/<jobId>/` (X-5). |
| `HF_HUB_OFFLINE=1` | Set by the worker at start. Models load from `TRANSCRIPTION_MODEL_DIR` only. |

At start the worker sweeps the scratch root. It stops with a named error when a weight file
is missing, a model is not on the allow list, or the aligner's licence forbids commercial use
(X-6). It removes a job's scratch folder when the job ends, whether it passed or failed.

## Job interface

All routes live under `/worker/v1/transcription`. Every request carries
`Authorization: Bearer <TRANSCRIPTION_WORKER_TOKEN>`. Every route after claim also carries
`X-Lease-Token: <lease token from the claim>`. The token alone identifies the job and its
tenant; the worker sends no tenant ID.

| Route | Use |
|---|---|
| `POST /claim` | Leases the oldest due job for 10 minutes. Body `{}`. Answers `{ job: null }` when nothing is due. |
| `GET /jobs/:id/audio` | The leased job's audio bytes. Probe it before decoding (X-9). |
| `POST /jobs/:id/heartbeat` | Extends the lease. Send one at least every 5 minutes on a long job. |
| `POST /jobs/:id/complete` | Body `{ modelIds, language, durationMs, segments }`. Segments are in time order, speaker `null` or `S1` to `S9`, at most 1500 segments and 200000 characters of text. |
| `POST /jobs/:id/fail` | Body `{ errorCode }`, a snake_case code. |

Rules the worker follows:

- A wrong or missing lease token answers `409` with reason `lease_lost`. Stop work on that
  job and drop its scratch folder; another attempt may already own it.
- A job gets three attempts. A failure retries after 30 seconds, then 60, then it is a dead
  letter. `audio_too_large`, `audio_too_long` and `audio_format` are final and dead-letter at
  once, so use them only for those causes.
- Send `fail` with `audio_too_large` for a file over 100 MiB, `audio_too_long` for more than
  60 minutes, and `audio_format` for a container other than WAV, MP3, M4A, OGG, WebM or FLAC.
- A replayed `complete` or `fail` with the same lease token replays the first answer. It writes
  no second transcript.
- Transcript text is data. Nothing in it is ever run as an instruction.

## Tests without Python

`pnpm -r test` needs no Python. `FakeTranscriptionWorker` in `@zs/core` claims a job and
completes it with two fixed speakers (`apps/api/test/transcription.test.ts`).

## Not in this slice

The Python worker process, the benchmark script (30-second voicemail, 5-minute call and
30-minute podcast samples: RTF, p95, peak memory, word error rate), the launchd job that
keeps the worker running, and the storage-bucket adapter on the API side.
