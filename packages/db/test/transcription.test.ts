import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// transcription.md X-3, X-4, X-8 at the database, as the runtime role: tenant B sees and changes
// nothing of tenant A's jobs and transcripts; only the platform transaction (the claim) reaches
// across tenants; a job has one transcript; a job leaves its states in the stated range.

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const AT = "2026-10-19T08:00:00.000Z";
const asTenant = (tenantId: string) => (tenantId === fixture.a.tenantId ? fixture.a : fixture.b).run;
const addJob = (tenantId: string, id = randomUUID()) => asTenant(tenantId)(async (tx) => {
  await tx.query(
    `INSERT INTO transcription_jobs (tenant_id,id,source_kind,declared_bytes,next_attempt_at,created_at,updated_at)
     VALUES ($1,$2,'media_upload',10,$3,$3,$3)`, [tenantId, id, AT]);
  return id;
});
const addTranscript = (tenantId: string, jobId: string) => asTenant(tenantId)(async (tx) => {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO transcripts (tenant_id,id,job_id,source_kind,attempt,language,duration_ms,created_at,expires_at)
     VALUES ($1,$2,$3,'media_upload',1,'en',1000,$4,$4)`, [tenantId, id, jobId, AT]);
  return id;
});

describe("tenant isolation", () => {
  it("shows tenant B none of tenant A's jobs or transcripts, and lets it change none", async () => {
    const job = await addJob(fixture.a.tenantId);
    const transcript = await addTranscript(fixture.a.tenantId, job);
    await addJob(fixture.b.tenantId);

    const jobsB = (await fixture.b.run((tx) => tx.query("SELECT id FROM transcription_jobs"))).rows.map((row) => row.id);
    expect(jobsB).not.toContain(job);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM transcripts"))).rows).toEqual([]);
    expect((await fixture.a.run((tx) => tx.query("SELECT id FROM transcripts"))).rows).toEqual([{ id: transcript }]);

    // An update or delete aimed at A's row finds nothing under B's scope.
    expect((await fixture.b.run((tx) => tx.query("UPDATE transcription_jobs SET status='dead_letter' WHERE id=$1", [job]))).rowCount).toBe(0);
    await expect(fixture.b.run((tx) => tx.query("DELETE FROM transcription_jobs WHERE id=$1", [job]))).rejects.toMatchObject({ code: "42501" });
    // B cannot write a row for A, nor a transcript for A's job.
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO transcription_jobs (tenant_id,id,source_kind,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,'media_upload',$3,$3,$3)`, [fixture.a.tenantId, randomUUID(), AT]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO transcripts (tenant_id,id,job_id,source_kind,attempt,language,duration_ms,created_at,expires_at)
       VALUES ($1,$2,$3,'media_upload',1,'en',1,$4,$4)`, [fixture.b.tenantId, randomUUID(), job, AT]))).rejects.toMatchObject({ code: "23503" });
    expect((await fixture.service((tx) => tx.query("SELECT status FROM transcription_jobs WHERE id=$1", [job]))).rows).toEqual([{ status: "queued" }]);
  });

  it("hides every job from a runtime transaction with no tenant, and shows all of them only to the platform transaction", async () => {
    const a = await addJob(fixture.a.tenantId);
    const b = await addJob(fixture.b.tenantId);
    expect((await database.db.withoutTenant((tx) => tx.query("SELECT id FROM transcription_jobs"))).rows).toEqual([]);
    const seen = (await database.db.platform!((tx) => tx.query("SELECT id FROM transcription_jobs"))).rows.map((row) => row.id);
    expect(seen).toEqual(expect.arrayContaining([a, b]));
    // The platform transaction leases a job of any tenant; it cannot insert, delete or read transcripts.
    expect((await database.db.platform!((tx) => tx.query(
      "UPDATE transcription_jobs SET status='running', attempts=1, lease_token=$2 WHERE id=$1", [a, randomUUID()]))).rowCount).toBe(1);
    await expect(database.db.platform!((tx) => tx.query(
      `INSERT INTO transcription_jobs (tenant_id,id,source_kind,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,'media_upload',$3,$3,$3)`, [fixture.a.tenantId, randomUUID(), AT]))).rejects.toMatchObject({ code: "42501" });
    await expect(database.db.platform!((tx) => tx.query("DELETE FROM transcription_jobs WHERE id=$1", [a]))).rejects.toMatchObject({ code: "42501" });
    expect((await database.db.platform!((tx) => tx.query("SELECT id FROM transcripts"))).rows).toEqual([]);
  });
});

describe("rows", () => {
  it("allows one transcript per job", async () => {
    const job = await addJob(fixture.a.tenantId);
    await addTranscript(fixture.a.tenantId, job);
    await expect(addTranscript(fixture.a.tenantId, job)).rejects.toMatchObject({ code: "23505" });
  });

  it("allows one job per voicemail, and requires a voicemail job to name it", async () => {
    const voicemail = randomUUID();
    const insert = (id: string, sourceId: string | null, kind = "voicemail") => fixture.a.run((tx) => tx.query(
      `INSERT INTO transcription_jobs (tenant_id,id,source_kind,source_id,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$5,$5)`, [fixture.a.tenantId, id, kind, sourceId, AT]));
    await insert(randomUUID(), voicemail);
    await expect(insert(randomUUID(), voicemail)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(randomUUID(), null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(randomUUID(), randomUUID(), "media_upload")).rejects.toMatchObject({ code: "23514" });
  });

  it("holds attempts to three, sizes to the upload cap, and error codes to a shape", async () => {
    const job = await addJob(fixture.a.tenantId);
    const set = (column: string, value: unknown) => fixture.service((tx) =>
      tx.query(`UPDATE transcription_jobs SET ${column}=$1 WHERE id=$2`, [value, job]));
    await expect(set("attempts", 4)).rejects.toMatchObject({ code: "23514" });
    await expect(set("declared_bytes", 104857601)).rejects.toMatchObject({ code: "23514" });
    await expect(set("last_error_code", "Bad Code")).rejects.toMatchObject({ code: "23514" });
    await expect(set("status", "lost")).rejects.toMatchObject({ code: "22P02" });
  });
});
