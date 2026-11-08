// Connections C-4: the receipt/refund migration must be safe for the hosted runner, which applies every pending
// file in one transaction with lock_timeout 5s and statement_timeout 15s: idempotent, and one short transaction.
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

const file = new URL("../../../supabase/migrations/20261108900000_rate_limit_receipt_refund.sql", import.meta.url);
let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); }, 120_000);
afterAll(async () => { await database?.close(); });

it("can be applied again over an applied database and changes nothing", async () => {
  const sql = await readFile(file, "utf8");
  const shape = async () => (await database.pool.query<{ shape: string }>(
    `SELECT string_agg(x, '|' ORDER BY x) AS shape FROM (
       SELECT 'fn:' || p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text AS x
         FROM pg_proc p WHERE p.proname IN ('rate_limit_receipt_take','rate_limit_refund') AND p.pronamespace = 'public'::regnamespace
       UNION ALL SELECT 'policy:' || policyname FROM pg_policies WHERE tablename = 'rate_limit_receipts'
       UNION ALL SELECT 'index:' || indexname FROM pg_indexes WHERE tablename = 'rate_limit_receipts'
       UNION ALL SELECT 'rls:' || relrowsecurity::text || relforcerowsecurity::text FROM pg_class WHERE oid = 'public.rate_limit_receipts'::regclass
     ) t`)).rows[0]!.shape;
  const before = await shape();
  expect(before).toContain("fn:rate_limit_receipt_take(");
  expect(before).toContain("fn:rate_limit_refund(");
  await database.pool.query(`BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'; ${sql}; COMMIT;`);
  expect(await shape()).toBe(before);
});

it("creates no object an existing caller already holds a lock on: only new objects, plus the two functions' grants", async () => {
  const sql = await readFile(file, "utf8");
  // No ALTER TABLE or DROP on an existing table, and no rewrite of rate_limit_take or rate_limit_buckets.
  expect(sql).not.toMatch(/ALTER TABLE (?!public\.rate_limit_receipts)/);
  expect(sql).not.toMatch(/(CREATE OR REPLACE|DROP) FUNCTION public\.rate_limit_take/);
  expect(sql).not.toMatch(/\bLOCK TABLE\b/i);
});
