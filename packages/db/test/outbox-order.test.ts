// N4: outbox `seq` comes from a sequence, which hands out numbers at INSERT, not at COMMIT.
// A delivery worker must therefore select unprocessed rows, never "everything after the
// highest seq I have seen": that high-water mark skips a lower seq that commits later.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const insertEvent = (tenantId: string) => `WITH a AS (
    INSERT INTO actions(tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
    VALUES ('${tenantId}','${randomUUID()}','${randomUUID()}','test.order','{}','{}','${randomUUID()}','{}',now())
    RETURNING tenant_id, id)
  INSERT INTO outbox(tenant_id,id,action_id,event_type,payload,created_at)
  SELECT tenant_id, '${randomUUID()}', id, 'test.order', '{}', now() FROM a RETURNING seq`;

it("commits outbox rows out of seq order, so only processed_at marks delivery progress", async () => {
  const early = await database.pool.connect();
  const late = await database.pool.connect();
  try {
    await early.query("BEGIN");
    const low = Number((await early.query<{ seq: string }>(insertEvent(fixture.a.tenantId))).rows[0]!.seq);
    await late.query("BEGIN");
    const high = Number((await late.query<{ seq: string }>(insertEvent(fixture.a.tenantId))).rows[0]!.seq);
    await late.query("COMMIT");
    expect(low).toBeLessThan(high);

    // A worker polling now sees the higher seq while the lower one is still uncommitted.
    const visible = (await database.pool.query<{ seq: string }>(
      "SELECT seq FROM outbox WHERE processed_at IS NULL AND seq IN ($1,$2) ORDER BY seq", [low, high])).rows.map((row) => Number(row.seq));
    expect(visible).toEqual([high]);
    await database.pool.query("UPDATE outbox SET processed_at = now() WHERE seq = $1", [high]);

    await early.query("COMMIT");
    // A high-water mark taken at `high` would skip `low` forever ...
    const afterHighWater = (await database.pool.query("SELECT seq FROM outbox WHERE seq > $1 AND seq IN ($2,$3)", [high, low, high])).rows;
    expect(afterHighWater).toEqual([]);
    // ... selecting unprocessed rows finds it.
    const pending = (await database.pool.query<{ seq: string }>(
      "SELECT seq FROM outbox WHERE processed_at IS NULL AND seq IN ($1,$2)", [low, high])).rows.map((row) => Number(row.seq));
    expect(pending).toEqual([low]);
  } finally {
    await early.query("ROLLBACK").catch(() => undefined);
    await late.query("ROLLBACK").catch(() => undefined);
    early.release();
    late.release();
  }
});
