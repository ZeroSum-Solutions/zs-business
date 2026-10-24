import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { asService } from "../src/scoped.js";
import { createTestDatabase } from "../src/testing.js";

// delivery.md D-11 migration: wallet_reservations gains job_kind and job_id, backfilled from
// delivery_id on rows that existed before, then NOT NULL.

const MIGRATION = "20261023300000_wallet_job_reservations.sql";

it.each([
  ["the superuser", false],
  // Hosted Supabase's postgres owns the tables but is not a superuser, so FORCE ROW LEVEL SECURITY
  // would hide every row from the backfill unless the migration lifts it for the copy.
  ["a migrator that is not a superuser", true],
])("backfills reservations stored before the migration as message_delivery jobs and moves the unique indexes (%s)", async (_, nonSuperuserMigrator) => {
  const earlier = await mkdtemp(join(tmpdir(), "zs-before-job-reservations-"));
  const source = new URL("../../../supabase/migrations/", import.meta.url);
  try {
    for (const name of (await readdir(source)).filter((file) => file.endsWith(".sql") && file < MIGRATION))
      await copyFile(new URL(name, source), join(earlier, name));
    const old = await createTestDatabase(undefined, { migrations: pathToFileURL(`${earlier}/`), nonSuperuserMigrator });
    try {
      const tenantId = randomUUID();
      const [held, captured, released] = [randomUUID(), randomUUID(), randomUUID()];
      const [heldId, capturedId, releasedId] = [randomUUID(), randomUUID(), randomUUID()];
      await asService(old.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Halden & Rowe')", [tenantId]));
      // The owner skips the foreign keys to deliveries (replica role) so the rows need no outbox chain.
      const owner = await old.pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query("SET LOCAL session_replication_role = replica");
        for (const [id, deliveryId, status] of [[held, heldId, "held"], [captured, capturedId, "captured"], [released, releasedId, "released"]] as const)
          await owner.query(
            `INSERT INTO wallet_reservations (tenant_id,id,delivery_id,amount,status,created_at,settled_at)
             VALUES ($1,$2,$3,5,$4,'2026-10-20T09:00Z',CASE WHEN $4='held' THEN NULL ELSE '2026-10-20T09:01Z'::timestamptz END)`,
            [tenantId, id, deliveryId, status]);
        await owner.query("COMMIT");
      } finally {
        owner.release();
      }
      expect((await old.pool.query(
        "SELECT 1 FROM pg_attribute WHERE attrelid='public.wallet_reservations'::regclass AND attname IN ('job_kind','job_id')")).rowCount).toBe(0);

      const url = new URL(old.url);
      if (old.migrator) url.username = old.migrator;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      try {
        expect((await migrate(migrator)).map((applied) => applied.name)).toContain(MIGRATION);
      } finally {
        await migrator.end();
      }

      const rows = (await asService(old.servicePool, (tx) => tx.query(
        "SELECT status, job_kind, job_id, delivery_id FROM wallet_reservations WHERE tenant_id=$1 ORDER BY status", [tenantId]))).rows;
      expect(rows).toEqual([
        { status: "captured", job_kind: "message_delivery", job_id: capturedId, delivery_id: capturedId },
        { status: "held", job_kind: "message_delivery", job_id: heldId, delivery_id: heldId },
        { status: "released", job_kind: "message_delivery", job_id: releasedId, delivery_id: releasedId },
      ]);
      expect((await old.pool.query(
        `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid='public.wallet_reservations'::regclass
           AND attname IN ('job_kind','job_id','delivery_id') ORDER BY attname`)).rows).toEqual([
        { attname: "delivery_id", attnotnull: false },
        { attname: "job_id", attnotnull: true },
        { attname: "job_kind", attnotnull: true },
      ]);
      // The two partial unique indexes name the job now, not the delivery.
      const indexes = (await old.pool.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='wallet_reservations' AND indexname LIKE 'wallet_reservations_one_%' ORDER BY 1")).rows;
      expect(indexes.map((index) => index.indexname)).toEqual(["wallet_reservations_one_capture", "wallet_reservations_one_held"]);
      for (const index of indexes) {
        expect(index.indexdef).toContain("UNIQUE");
        expect(index.indexdef).toContain("(tenant_id, job_kind, job_id)");
        expect(index.indexdef).not.toContain("delivery_id");
      }
      // Forced row-level security is back after the copy, and the delivery foreign key stays.
      expect((await old.pool.query(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.wallet_reservations'::regclass")).rows)
        .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      expect((await old.pool.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid='public.wallet_reservations'::regclass AND contype='f'
           AND confrelid='public.message_deliveries'::regclass`)).rowCount).toBe(1);
    } finally {
      await old.close();
    }
  } finally {
    await rm(earlier, { recursive: true, force: true });
  }
}, 60000);
