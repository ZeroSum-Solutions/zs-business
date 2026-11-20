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

// plans.md PL-10 migration: plan_invoices.resolved_at and plan_subscriptions.recovered_at, backfilled for rows stored
// before. A legacy resolution is dated by the migration, not by the old worker's `updated_at` (the start of its pass).

const MIGRATION = "20261120100000_plan_invoice_resolved_at.sql";

it.each([
  ["the superuser", false],
  // Hosted Supabase's postgres owns the tables but is not a superuser, so FORCE ROW LEVEL SECURITY would hide every row
  // from the backfill unless the migration lifts it for the copy.
  ["a migrator that is not a superuser", true],
])("dates rows stored before the migration at the migration time and refuses an undated resolution (%s)", async (_, nonSuperuserMigrator) => {
  const earlier = await mkdtemp(join(tmpdir(), "zs-before-plan-resolved-"));
  const source = new URL("../../../supabase/migrations/", import.meta.url);
  try {
    for (const name of (await readdir(source)).filter((file) => file.endsWith(".sql") && file < MIGRATION))
      await copyFile(new URL(name, source), join(earlier, name));
    const old = await createTestDatabase(undefined, { migrations: pathToFileURL(`${earlier}/`), nonSuperuserMigrator });
    try {
      const tenantId = randomUUID();
      const [recovered, failedOnly, paidOnly] = ["sub_recovered", "sub_failed_only", "sub_paid_only"];
      await asService(old.servicePool, async (tx) => {
        await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Halden & Rowe')", [tenantId]);
        for (const id of [recovered, failedOnly, paidOnly])
          await tx.query(
            `INSERT INTO plan_subscriptions (tenant_id,id,status,started_at,status_since,created_at,updated_at)
             VALUES ($1,$2,'active','2026-01-01T00:00Z','2026-01-01T00:00Z','2026-01-01T00:00Z','2026-01-01T00:00Z')`, [tenantId, id]);
        // The old worker's `updated_at` for a resolution is the start of its pass: long before the migration.
        for (const [id, subscription, status] of [["in_resolved", recovered, "resolved"], ["in_failed", failedOnly, "failed"], ["in_paid", paidOnly, "paid"]] as const)
          await tx.query(
            `INSERT INTO plan_invoices (tenant_id,id,stripe_subscription_id,status,first_failed_at,paid_at,created_at,updated_at)
             VALUES ($1,$2,$3,$4,'2026-02-01T00:00Z',CASE WHEN $4='paid' THEN '2026-02-02T00:00Z'::timestamptz END,'2026-02-01T00:00Z','2026-02-03T00:00Z')`,
            [tenantId, id, subscription, status]);
      });

      const url = new URL(old.url);
      if (old.migrator) url.username = old.migrator;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      const startedAt = new Date();
      try {
        expect((await migrate(migrator)).map((applied) => applied.name)).toContain(MIGRATION);
      } finally {
        await migrator.end();
      }

      const invoices = (await asService(old.servicePool, (tx) => tx.query<{ id: string; resolved_at: Date | null }>(
        "SELECT id, resolved_at FROM plan_invoices WHERE tenant_id=$1 ORDER BY id", [tenantId]))).rows;
      const byId = Object.fromEntries(invoices.map((row) => [row.id, row.resolved_at]));
      // A delayed failure created after the old worker's pass started but before it saw the recovery is stale: the
      // watermark is no earlier than the migration, never the stored updated_at.
      expect(byId.in_resolved!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 5_000);
      expect(byId.in_failed).toBeNull();
      expect(byId.in_paid).toBeNull();
      const subscriptions = (await asService(old.servicePool, (tx) => tx.query<{ id: string; recovered_at: Date | null }>(
        "SELECT id, recovered_at FROM plan_subscriptions WHERE tenant_id=$1 ORDER BY id", [tenantId]))).rows;
      const bySub = Object.fromEntries(subscriptions.map((row) => [row.id, row.recovered_at]));
      // A subscription with a resolved or a failed invoice is covered, so an old failure copy cannot restore its first_failed_at.
      expect(bySub[recovered]!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 5_000);
      expect(bySub[failedOnly]!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 5_000);
      expect(bySub[paidOnly]).toBeNull();

      // A resolution that leaves resolved_at empty (the worker from before this migration) is refused, not stored undated.
      await expect(old.pool.query(
        "UPDATE plan_invoices SET status='resolved', resolved_at=NULL WHERE tenant_id=$1 AND id='in_failed'", [tenantId]))
        .rejects.toMatchObject({ constraint: "plan_invoices_resolved_dated" });
      // Forced row-level security is back after the copy.
      expect((await old.pool.query(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN ('public.plan_invoices'::regclass, 'public.plan_subscriptions'::regclass) ORDER BY relname`)).rows)
        .toEqual([{ relname: "plan_invoices", relforcerowsecurity: true }, { relname: "plan_subscriptions", relforcerowsecurity: true }]);
    } finally {
      await old.close();
    }
  } finally {
    await rm(earlier, { recursive: true, force: true });
  }
}, 60000);
