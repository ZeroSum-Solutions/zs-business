// A read that must agree with itself (plans.md PL-26: the plan row, the runners' beats, the agent switches and the
// template approval in one answer) opens its transaction at REPEATABLE READ. A change committed by another session
// in the middle of the work is then not seen, where at the default level the second statement sees it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScopedDatabase } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

describe("tenant transaction isolation", () => {
  const runtime = () => createScopedDatabase(database.runtimePool);
  const beat = (at: string) => fixture.service((tx) => tx.query(
    `INSERT INTO runner_heartbeats (runner, beat_at, fresh_for_seconds) VALUES ('followup', $1, 1800)
     ON CONFLICT (runner) DO UPDATE SET beat_at = $1`, [at]));
  const read = async (tx: { query: (sql: string) => Promise<{ rows: { beat_at: Date }[] }> }) =>
    (await tx.query("SELECT beat_at FROM runner_heartbeats WHERE runner='followup'")).rows[0]!.beat_at.toISOString();

  it("reads one snapshot at repeatable read: a commit in the middle is not seen", async () => {
    await beat("2026-11-20T00:00:00.000Z");
    const seen = await runtime().tenant(fixture.a.tenantId, async (tx) => {
      const first = await read(tx);
      await beat("2026-11-20T00:10:00.000Z");
      return [first, await read(tx)];
    }, { isolation: "repeatable read" });
    expect(seen).toEqual(["2026-11-20T00:00:00.000Z", "2026-11-20T00:00:00.000Z"]);
  });

  it("reads each statement fresh by default", async () => {
    await beat("2026-11-20T00:00:00.000Z");
    const seen = await runtime().tenant(fixture.a.tenantId, async (tx) => {
      const first = await read(tx);
      await beat("2026-11-20T00:10:00.000Z");
      return [first, await read(tx)];
    });
    expect(seen).toEqual(["2026-11-20T00:00:00.000Z", "2026-11-20T00:10:00.000Z"]);
  });

  it("lets the tenant's session read the heartbeats but not write them", async () => {
    await expect(runtime().tenant(fixture.a.tenantId, (tx) => tx.query(
      "INSERT INTO runner_heartbeats (runner, beat_at, fresh_for_seconds) VALUES ('followup', now(), 1800) ON CONFLICT (runner) DO UPDATE SET beat_at = now()"),
    )).rejects.toMatchObject({ code: "42501" });
    await expect(runtime().tenant(fixture.a.tenantId, (tx) => tx.query("SELECT count(*) FROM runner_heartbeats"))).resolves.toBeDefined();
  });
});
