import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_AUDIO_BYTES,
  apiErrorBodySchema,
  claimResponseSchema,
  transcriptionDetailSchema,
  transcriptionListSchema,
  uploadTicketSchema,
  type ClaimedJob,
} from "@zs/contracts";
import {
  FAKE_TRANSCRIPT,
  FakeTranscriptionWorker,
  createTranscriptionSession,
  type AudioObject,
  type TranscriptionWorkerApi,
} from "@zs/core";
import { call, createApiHarness, NOW, WORKER_TOKEN, type ApiHarness, type TenantSetup } from "./helpers.js";

// transcription.md "Acceptance test", over HTTP as zs_runtime on a real database, with the fake
// worker standing in for WhisperX. The clock moves by hand so a lease can lapse and a retry can
// come due; every member token stays inside its hour.
let nowMs = new Date(NOW).getTime();
const clock = { now: () => new Date(nowMs) };
const advance = (ms: number) => { nowMs += ms; };
let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness({ transcription: true, clock }); });
afterAll(async () => { await h?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

const asOwner = (tenant: TenantSetup, method: string, path: string, body?: unknown, key: string | null = randomUUID()) =>
  call(h.app, method, `/v1/transcriptions${path}`, { token: tenant.token, ...(body === undefined ? {} : { body }), ...(key === null ? {} : { key }) });

/** An owner uploads: asks for the signed URL, puts the bytes, and enqueues. */
async function upload(tenant: TenantSetup, bytes = AUDIO) {
  const ticketResponse = await asOwner(tenant, "POST", "/uploads", {});
  expect(ticketResponse.status, JSON.stringify(ticketResponse.body)).toBe(201);
  const ticket = uploadTicketSchema.parse(ticketResponse.body);
  expect(ticket.path).toBe(`audio/${tenant.tenantId}/${ticket.jobId}`);
  h.transcription!.audio.put(ticket.path, bytes);
  const enqueued = await asOwner(tenant, "POST", "", {
    sourceKind: "media_upload", jobId: ticket.jobId, declaredBytes: bytes.byteLength, rightsConfirmed: true, containsHealthData: false,
  });
  return { ticket, enqueued };
}

const worker = (path: string, options: { method?: string; token?: string | null; lease?: string; body?: unknown } = {}) =>
  call(h.app, options.method ?? "POST", `/worker/v1/transcription${path}`, {
    ...(options.token === null ? {} : { token: options.token ?? WORKER_TOKEN }),
    ...(options.lease ? { headers: { "X-Lease-Token": options.lease } } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
  });

const claim = async (): Promise<ClaimedJob | null> => claimResponseSchema.parse((await worker("/claim")).body).job;

/** The worker's job interface over HTTP, which is how the Python worker reaches the system. */
const httpWorker: TranscriptionWorkerApi = {
  claim,
  async audio(jobId, leaseToken): Promise<AudioObject> {
    const response = await h.app.request(`/worker/v1/transcription/jobs/${jobId}/audio`, {
      headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "X-Lease-Token": leaseToken },
    });
    if (response.status !== 200) throw new Error(`audio ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { body: bytes, bytes: bytes.byteLength, contentType: response.headers.get("Content-Type") ?? "" };
  },
  async complete(jobId, leaseToken, transcript) {
    const response = await worker(`/jobs/${jobId}/complete`, { lease: leaseToken, body: transcript });
    if (response.status !== 200) throw new Error(`complete ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  },
  async fail(jobId, leaseToken, body) {
    const response = await worker(`/jobs/${jobId}/fail`, { lease: leaseToken, body });
    if (response.status !== 200) throw new Error(`fail ${response.status}`);
    return response.body;
  },
};

const countRows = (table: "transcripts" | "transcription_jobs", tenantId: string, jobColumn: "job_id" | "id", jobId: string) =>
  h.fixture.service(async (tx) => Number((await tx.query(
    `SELECT count(*) AS n FROM ${table} WHERE tenant_id=$1 AND ${jobColumn}=$2`, [tenantId, jobId])).rows[0]!.n));

describe("enqueue refusals (X-1, X-2, X-9)", () => {
  it("refuses a recorded call with 409 consent_required, and stores nothing", async () => {
    const response = await asOwner(h.a, "POST", "", { sourceKind: "recorded_call", jobId: randomUUID() });
    expect(response.status).toBe(409);
    expect(errorOf(response)).toMatchObject({ code: "Conflict", details: { reason: "consent_required" } });
    expect((await asOwner(h.a, "GET", "", undefined, null)).body).toEqual({ items: [] });
  });

  it("answers 404 for an unknown source", async () => {
    const response = await asOwner(h.a, "POST", "", { sourceKind: "bogus", jobId: randomUUID() });
    expect(response.status).toBe(404);
  });

  it("refuses an upload that does not say it holds no health data with 422 health_data_forbidden", async () => {
    const jobId = randomUUID();
    h.transcription!.audio.put(`audio/${h.a.tenantId}/${jobId}`, AUDIO);
    const base = { sourceKind: "media_upload", jobId, declaredBytes: AUDIO.byteLength, rightsConfirmed: true };
    for (const flag of [{}, { containsHealthData: true }, { containsHealthData: "no" }]) {
      const response = await asOwner(h.a, "POST", "", { ...base, ...flag });
      expect(response.status, JSON.stringify(flag)).toBe(422);
      expect(errorOf(response)).toMatchObject({ code: "ValidationFailed", details: { reason: "health_data_forbidden" } });
    }
  });

  it("refuses a missing rights attestation, an oversize upload and an upload that was never put", async () => {
    const jobId = randomUUID();
    const base = { sourceKind: "media_upload", jobId, declaredBytes: AUDIO.byteLength, containsHealthData: false };
    const rights = await asOwner(h.a, "POST", "", { ...base });
    expect(rights.status).toBe(400);
    expect(errorOf(rights)).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "rightsConfirmed" }] } });
    const big = await asOwner(h.a, "POST", "", { ...base, rightsConfirmed: true, declaredBytes: MAX_AUDIO_BYTES + 1 });
    expect(big.status).toBe(413);
    expect(errorOf(big)).toMatchObject({ details: { reason: "audio_too_large" } });
    const missing = await asOwner(h.a, "POST", "", { ...base, rightsConfirmed: true });
    expect(missing.status).toBe(404);
    // The bytes put are more than the owner declared.
    h.transcription!.audio.put(`audio/${h.a.tenantId}/${jobId}`, AUDIO);
    const lied = await asOwner(h.a, "POST", "", { ...base, rightsConfirmed: true, declaredBytes: 2 });
    expect(lied.status).toBe(413);
    expect((await asOwner(h.a, "GET", "", undefined, null)).body).toEqual({ items: [] });
  });

  it("gives a member no way to enqueue a voicemail, and a missing key is a 400", async () => {
    const voicemail = await asOwner(h.a, "POST", "", { sourceKind: "voicemail", voicemailId: randomUUID() });
    expect(voicemail.status).toBe(403);
    expect((await asOwner(h.a, "POST", "", { sourceKind: "media_upload" }, null)).status).toBe(400);
  });
});

describe("the worker's job interface (X-3, X-4, X-7)", () => {
  it("enqueues a Halden & Rowe upload; the fake worker claims, fetches its audio and completes it; the owner reads two speakers in order", async () => {
    const { ticket, enqueued } = await upload(h.a);
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(201);
    expect(enqueued.body.result).toEqual({ jobId: ticket.jobId, status: "queued" });

    const queued = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(queued).toMatchObject({ id: ticket.jobId, status: "queued", attempts: 0, transcript: null });

    const run = await new FakeTranscriptionWorker(httpWorker).runOnce();
    expect(run?.job).toMatchObject({ id: ticket.jobId, tenantId: h.a.tenantId, attempt: 1, sourceKind: "media_upload" });
    expect(run?.audioBytes).toBe(AUDIO.byteLength);

    const detail = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(detail).toMatchObject({ status: "completed", attempts: 1, completedAt: NOW });
    expect(detail.transcript).toMatchObject({
      language: "en", durationMs: 9000, speakers: ["S1", "S2"], modelIds: FAKE_TRANSCRIPT.modelIds,
      expiresAt: new Date(nowMs + 90 * 24 * 3600 * 1000).toISOString(),
    });
    expect(detail.transcript!.segments).toEqual(FAKE_TRANSCRIPT.segments);
    expect(detail.transcript!.segments.map((segment) => segment.speaker)).toEqual(["S1", "S2", "S1"]);

    const list = transcriptionListSchema.parse((await asOwner(h.a, "GET", "", undefined, null)).body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: ticket.jobId, status: "completed", transcript: { speakerCount: 2, segmentCount: 3 } });
    // X-8: the audio is gone once the job ends.
    expect(h.transcription!.audio.objects.has(ticket.path)).toBe(false);
    expect(await claim()).toBeNull();
  });

  it("replays a repeated enqueue with its key, and refuses the job ID under another key", async () => {
    const jobId = randomUUID();
    h.transcription!.audio.put(`audio/${h.a.tenantId}/${jobId}`, AUDIO);
    const body = { sourceKind: "media_upload", jobId, declaredBytes: AUDIO.byteLength, rightsConfirmed: true, containsHealthData: false };
    const key = randomUUID();
    const first = await asOwner(h.a, "POST", "", body, key);
    const again = await asOwner(h.a, "POST", "", body, key);
    expect(first.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const other = await asOwner(h.a, "POST", "", body);
    expect(other.status).toBe(409);
    expect(await countRows("transcription_jobs", h.a.tenantId, "id", jobId)).toBe(1);
    const job = (await claim())!;
    await worker(`/jobs/${job.id}/fail`, { lease: job.leaseToken, body: { errorCode: "audio_format" } });
  });

  it("writes nothing for a stale lease token; a replayed completion writes no second row", async () => {
    const { ticket } = await upload(h.a);
    const first = (await claim())!;
    expect(first.id).toBe(ticket.jobId);
    // The worker stalls past its lease; the job is leased again under a new token.
    advance(10 * 60_000 + 1_000);
    const second = (await claim())!;
    expect(second).toMatchObject({ id: ticket.jobId, attempt: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const stale = await worker(`/jobs/${first.id}/complete`, { lease: first.leaseToken, body: FAKE_TRANSCRIPT });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "lease_lost" } });
    expect((await worker(`/jobs/${first.id}/heartbeat`, { lease: first.leaseToken })).status).toBe(409);
    expect((await worker(`/jobs/${first.id}/audio`, { method: "GET", lease: first.leaseToken })).status).toBe(404);
    expect(await countRows("transcripts", h.a.tenantId, "job_id", first.id)).toBe(0);

    const beat = await worker(`/jobs/${second.id}/heartbeat`, { lease: second.leaseToken });
    expect(beat.status).toBe(200);
    expect(beat.body.leaseExpiresAt).toBe(new Date(nowMs + 10 * 60_000).toISOString());

    const done = await worker(`/jobs/${second.id}/complete`, { lease: second.leaseToken, body: FAKE_TRANSCRIPT });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const replay = await worker(`/jobs/${second.id}/complete`, { lease: second.leaseToken, body: FAKE_TRANSCRIPT });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(done.body);
    expect(await countRows("transcripts", h.a.tenantId, "job_id", second.id)).toBe(1);
    // After completion the lease is no longer a lease: no heartbeat, no audio.
    expect((await worker(`/jobs/${second.id}/heartbeat`, { lease: second.leaseToken })).status).toBe(409);
    expect((await worker(`/jobs/${second.id}/audio`, { method: "GET", lease: second.leaseToken })).status).toBe(404);
  });

  it("makes a dead letter of a job that fails three times, waiting between attempts", async () => {
    const { ticket } = await upload(h.a);
    const failing = new FakeTranscriptionWorker(httpWorker);
    failing.failWith = "model_crash";

    expect((await failing.runOnce())?.job).toMatchObject({ id: ticket.jobId, attempt: 1 });
    const afterOne = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(afterOne).toMatchObject({ status: "failed", attempts: 1, lastErrorCode: "model_crash" });
    expect(await claim()).toBeNull();
    advance(30_000);
    expect((await failing.runOnce())?.job).toMatchObject({ id: ticket.jobId, attempt: 2 });
    expect(await claim()).toBeNull();
    advance(59_000);
    expect(await claim()).toBeNull();
    advance(1_000);
    expect((await failing.runOnce())?.job).toMatchObject({ id: ticket.jobId, attempt: 3 });

    const dead = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(dead).toMatchObject({ status: "dead_letter", attempts: 3, lastErrorCode: "model_crash", transcript: null });
    advance(60_000);
    expect(await claim()).toBeNull();
    // X-8: the audio of a dead letter is deleted too.
    expect(h.transcription!.audio.objects.has(ticket.path)).toBe(false);
  });

  it("ends at once a job that no retry can fix", async () => {
    const { ticket } = await upload(h.a);
    const failing = new FakeTranscriptionWorker(httpWorker);
    failing.failWith = "audio_too_long";
    await failing.runOnce();
    const detail = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(detail).toMatchObject({ status: "dead_letter", attempts: 1, lastErrorCode: "audio_too_long" });
  });

  it("dead-letters a job whose third lease lapses", async () => {
    const { ticket } = await upload(h.a);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await claim())).toMatchObject({ id: ticket.jobId, attempt });
      advance(10 * 60_000 + 1_000);
    }
    expect(await claim()).toBeNull();
    const detail = transcriptionDetailSchema.parse((await asOwner(h.a, "GET", `/${ticket.jobId}`, undefined, null)).body);
    expect(detail).toMatchObject({ status: "dead_letter", attempts: 3, lastErrorCode: "lease_expired" });
    // X-8: the audio goes with it.
    expect(h.transcription!.audio.objects.has(ticket.path)).toBe(false);
  });

  it("refuses a transcript that breaks the schema", async () => {
    const { ticket } = await upload(h.a);
    const job = (await claim())!;
    for (const bad of [
      { ...FAKE_TRANSCRIPT, segments: [...FAKE_TRANSCRIPT.segments].reverse() },
      { ...FAKE_TRANSCRIPT, segments: [{ startMs: 0, endMs: 1, speaker: "S10", text: "x" }] },
      { ...FAKE_TRANSCRIPT, segments: [{ startMs: 0, endMs: 1, speaker: null, text: "x".repeat(2001) }] },
      { ...FAKE_TRANSCRIPT, durationMs: 3_600_001 },
      { ...FAKE_TRANSCRIPT, extra: true },
    ]) {
      const response = await worker(`/jobs/${job.id}/complete`, { lease: job.leaseToken, body: bad });
      expect(response.status).toBe(400);
    }
    expect(await countRows("transcripts", h.a.tenantId, "job_id", ticket.jobId)).toBe(0);
    await httpWorker.complete(job.id, job.leaseToken, FAKE_TRANSCRIPT);
  });
});

describe("worker authentication (X-4)", () => {
  it("answers 401 to a wrong or missing worker token on every worker route", async () => {
    const id = randomUUID();
    const routes: [string, string][] = [
      ["POST", "/claim"], ["GET", `/jobs/${id}/audio`], ["POST", `/jobs/${id}/heartbeat`],
      ["POST", `/jobs/${id}/complete`], ["POST", `/jobs/${id}/fail`],
    ];
    for (const [method, path] of routes) {
      for (const token of ["wrong-token-" + "x".repeat(32), "", null]) {
        const response = await worker(path, { method, token: token === "" ? "" : token, body: method === "POST" ? {} : undefined });
        expect(response.status, `${method} ${path} ${String(token)}`).toBe(401);
        expect(errorOf(response).code).toBe("Unauthorized");
      }
    }
  });

  it("does not accept a member's token as the worker's, nor the worker's as a member's", async () => {
    expect((await worker("/claim", { token: h.a.token })).status).toBe(401);
    expect((await call(h.app, "GET", "/v1/transcriptions", { token: WORKER_TOKEN })).status).toBe(401);
  });
});

describe("tenant isolation (X-4)", () => {
  it("keeps tenant B from reading tenant A's job or transcript, and a lease from reaching another tenant's audio", async () => {
    const a = await upload(h.a);
    const b = await upload(h.b);
    expect(a.enqueued.status).toBe(201);
    expect(b.enqueued.status).toBe(201);

    // B cannot read A's job, and its own list holds only its own job.
    expect((await asOwner(h.b, "GET", `/${a.ticket.jobId}`, undefined, null)).status).toBe(404);
    const listB = transcriptionListSchema.parse((await asOwner(h.b, "GET", "", undefined, null)).body);
    expect(listB.items.map((item) => item.id)).toEqual([b.ticket.jobId]);

    const first = (await claim())!;
    const second = (await claim())!;
    const leaseA = [first, second].find((job) => job.tenantId === h.a.tenantId)!;
    const leaseB = [first, second].find((job) => job.tenantId === h.b.tenantId)!;
    expect(leaseA.id).toBe(a.ticket.jobId);
    expect(leaseB.id).toBe(b.ticket.jobId);

    // A's lease token cannot fetch B's audio, or touch B's job.
    expect((await worker(`/jobs/${leaseB.id}/audio`, { method: "GET", lease: leaseA.leaseToken })).status).toBe(404);
    expect((await worker(`/jobs/${leaseB.id}/complete`, { lease: leaseA.leaseToken, body: FAKE_TRANSCRIPT })).status).toBe(409);
    expect((await worker(`/jobs/${leaseB.id}/heartbeat`, { lease: leaseA.leaseToken })).status).toBe(409);
    expect((await httpWorker.audio(leaseA.id, leaseA.leaseToken)).bytes).toBe(AUDIO.byteLength);

    await httpWorker.complete(leaseA.id, leaseA.leaseToken, FAKE_TRANSCRIPT);
    await httpWorker.complete(leaseB.id, leaseB.leaseToken, FAKE_TRANSCRIPT);

    // The finished transcript is still A's alone.
    expect((await asOwner(h.b, "GET", `/${leaseA.id}`, undefined, null)).status).toBe(404);
    const detailB = transcriptionDetailSchema.parse((await asOwner(h.b, "GET", `/${leaseB.id}`, undefined, null)).body);
    expect(detailB.status).toBe("completed");
  });
});

describe("voicemail jobs (X-1)", () => {
  it("lets the server enqueue a voicemail the tenant has, once, and the worker fetch its audio", async () => {
    const edge = { db: h.database.db, clock, generateId: randomUUID };
    const session = createTranscriptionSession(edge, { audio: h.transcription!.audio, voicemails: h.transcription!.voicemails });
    const voicemailId = randomUUID();
    // Not this tenant's voicemail: nothing is queued.
    h.transcription!.voicemails.add(h.b.tenantId, voicemailId, AUDIO);
    await expect(session.enqueueVoicemail(h.a.tenantId, voicemailId)).rejects.toMatchObject({ code: "NotFound" });
    h.transcription!.voicemails.add(h.a.tenantId, voicemailId, AUDIO);
    // X-2: without the opt-in and the attestation nothing is queued.
    await expect(session.enqueueVoicemail(h.a.tenantId, voicemailId)).rejects.toMatchObject({ code: "Conflict", details: { reason: "consent_required" } });
    h.transcription!.voicemails.allow(h.a.tenantId);
    const first = await session.enqueueVoicemail(h.a.tenantId, voicemailId);
    const again = await session.enqueueVoicemail(h.a.tenantId, voicemailId);
    expect(again).toEqual(first);

    const run = await new FakeTranscriptionWorker(httpWorker).runOnce();
    expect(run).toMatchObject({ job: { sourceKind: "voicemail", tenantId: h.a.tenantId }, audioBytes: AUDIO.byteLength });
    const list = transcriptionListSchema.parse((await asOwner(h.a, "GET", "", undefined, null)).body);
    expect(list.items.find((item) => item.sourceId === voicemailId)).toMatchObject({ sourceKind: "voicemail", status: "completed" });
  });
});
