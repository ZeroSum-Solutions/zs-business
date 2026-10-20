import { randomUUID } from "node:crypto";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOrFindContact } from "../../src/index.js";
import { contactCommand, createHarness, type Harness } from "./helpers.js";

// The handler's advisory locks serialize its own calls; only the unique index stops a
// concurrent writer that skips them (runtime may INSERT contacts directly).
let h: Harness;
let mutant: Harness;
beforeAll(async () => {
  [h, mutant] = await Promise.all([createHarness(), createHarness()]);
  // Throwaway database for the mutation: the same schema without the email index.
  await mutant.database.pool.query("DROP INDEX public.crm_contacts_tenant_email");
});
afterAll(async () => { await Promise.all([h?.close(), mutant?.close()]); });

/** Runs each transaction under an application_name only it carries, so its backend is identifiable. */
const stamped = (harness: Harness, stamp: string): ScopedDatabase => ({
  ...harness.database.db,
  tenant: (tenantId, work) => harness.database.db.tenant(tenantId, async (tx) => {
    await tx.query("SELECT pg_catalog.set_config('application_name', $1, true)", [stamp]);
    return work(tx);
  }),
});

/**
 * Waits for the stamped handler to reach an explicit outcome: "blocked" once its backend
 * waits on a row lock (transactionid or tuple) held by the holder's PID, "settled" once it
 * finished with that wait never seen. A wait of any other kind on the holder, more than one
 * stamped backend, or a timeout throws, so the holder never commits early. The observer is
 * a superuser client reserved before the race: it sees every backend's wait and cannot
 * starve the runtime pool.
 */
async function handlerOutcome(
  observer: Transaction, holderPid: number, stamp: string, settled: () => boolean, timeoutMs = 10_000,
): Promise<"blocked" | "settled"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled()) return "settled";
    const { rows } = await observer.query<{ wait_type: string | null; wait: string | null; by_holder: boolean }>(
      `SELECT wait_event_type AS wait_type, wait_event AS wait, $1::int = ANY(pg_blocking_pids(pid)) AS by_holder
       FROM pg_stat_activity WHERE application_name = $2`, [holderPid, stamp],
    );
    if (rows.length > 1) throw new Error(`Expected one handler backend, found ${rows.length}`);
    const row = rows[0];
    if (row?.by_holder && row.wait_type === "Lock") {
      if (row.wait === "transactionid" || row.wait === "tuple") return "blocked";
      throw new Error(`handler waits on the holder for a ${row.wait} lock, not a row lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`sync timeout: handler neither blocked on backend ${holderPid} nor settled in ${timeoutMs} ms`);
}

/**
 * A direct runtime insert of the email stays uncommitted while the handler creates or
 * finds the same email, then commits. The index makes the handler wait, lose with 23505,
 * and find the winner; without it both rows commit.
 */
async function raceSameEmail(harness: Harness) {
  const tenantId = harness.fixture.a.tenantId;
  const email = `race-${randomUUID()}@example.test`;
  const stamp = `zs-race-${randomUUID()}`;
  let pending: Promise<Awaited<ReturnType<typeof createOrFindContact>>> | undefined;
  let settled = false;
  let outcome: "blocked" | "settled" | undefined;
  const observer = await harness.database.pool.connect();
  try {
    await harness.fixture.a.run(async (tx) => {
      const holderPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await tx.query(
        "INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at) VALUES ($1,$2,NULL,$3,NULL,now(),now())",
        [tenantId, randomUUID(), email],
      );
      pending = createOrFindContact(contactCommand(tenantId, { email }), harness.ctx(tenantId, undefined, stamped(harness, stamp)));
      pending.then(() => { settled = true; }, () => { settled = true; });
      outcome = await handlerOutcome(observer, holderPid, stamp, () => settled);
    });
  } finally {
    observer.release();
  }
  const result = await pending!;
  const contacts = await harness.fixture.service(async (tx) => (await tx.query(
    "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [tenantId, email],
  )).rowCount);
  return { outcome, created: result.result.created, contacts };
}

it("C-8: the unique email index exists and concurrent create/find of one email yields one contact", async () => {
  const index = await h.fixture.service(async (tx) => (await tx.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='crm_contacts_tenant_email'",
  )).rows);
  expect(index).toEqual([{
    indexdef: expect.stringMatching(
      /^CREATE UNIQUE INDEX crm_contacts_tenant_email ON public\.crm_contacts USING btree \(tenant_id, normalized_email\) WHERE \(normalized_email IS NOT NULL\)$/,
    ),
  }]);
  expect(await raceSameEmail(h)).toEqual({ outcome: "blocked", created: false, contacts: 1 });
});

it("mutation: without the unique email index the same race stores a duplicate contact", async () => {
  expect(await raceSameEmail(mutant)).toEqual({ outcome: "settled", created: true, contacts: 2 });
});

/** Holds a transaction with advisory lock 42 and runs `probe` in a second, stamped one meanwhile. */
async function withStampedProbe(probe: string, check: (holderPid: number, stamp: string) => Promise<unknown>) {
  const stamp = `zs-race-${randomUUID()}`;
  const prober = await h.database.runtimePool.connect();
  let running: Promise<unknown> | undefined;
  try {
    await h.fixture.a.run(async (tx) => {
      const holderPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await tx.query("SELECT pg_advisory_xact_lock(42)");
      await prober.query("BEGIN");
      await prober.query("SELECT pg_catalog.set_config('application_name', $1, true)", [stamp]);
      running = prober.query(probe);
      await check(holderPid, stamp);
    });
    // The holder's commit released the lock, so the probe finishes.
    await running;
    await prober.query("COMMIT");
  } catch (error) {
    await prober.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    prober.release();
  }
}

for (const [name, probe, expected] of [
  ["neither blocks on the holder nor settles fails with a sync timeout", "SELECT pg_sleep(0.5)", /^sync timeout: /],
  ["waits on the holder for a non-row lock fails at once", "SELECT pg_advisory_xact_lock(42)", /advisory lock, not a row lock/],
] as const) {
  it(`sync: a stamped backend that ${name}`, async () => {
    const observer = await h.database.pool.connect();
    try {
      await withStampedProbe(probe, (holderPid, stamp) =>
        expect(handlerOutcome(observer, holderPid, stamp, () => false, 300)).rejects.toThrow(expected));
    } finally { observer.release(); }
  });
}
