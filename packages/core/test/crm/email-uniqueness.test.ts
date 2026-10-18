import { randomUUID } from "node:crypto";
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

/**
 * Waits for the handler started after the holder's write to reach an explicit outcome:
 * "blocked" once its backend (the other active runtime backend in this database) waits on
 * the holder's PID, "settled" once it finished without blocking. Anything else throws, so
 * a slow scheduler fails loudly instead of committing the holder early.
 */
async function handlerOutcome(
  harness: Harness, holderPid: number, settled: () => boolean, timeoutMs = 10_000,
): Promise<"blocked" | "settled"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled()) return "settled";
    // The superuser pool sees other roles' backends and their blockers.
    const { rows } = await harness.database.pool.query<{ pid: number; blocked: boolean }>(
      `SELECT pid, $1::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity
       WHERE datname=current_database() AND usename='zs_runtime' AND state <> 'idle'
         AND pid NOT IN ($1, pg_backend_pid())`, [holderPid],
    );
    if (rows.length > 1) throw new Error(`Expected one handler backend, found ${rows.length}`);
    if (rows[0]?.blocked) return "blocked";
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
  let pending: Promise<Awaited<ReturnType<typeof createOrFindContact>>> | undefined;
  let settled = false;
  let outcome: "blocked" | "settled" | undefined;
  await harness.fixture.a.run(async (tx) => {
    const holderPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await tx.query(
      "INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at) VALUES ($1,$2,NULL,$3,NULL,now(),now())",
      [tenantId, randomUUID(), email],
    );
    pending = createOrFindContact(contactCommand(tenantId, { email }), harness.ctx(tenantId));
    pending.then(() => { settled = true; }, () => { settled = true; });
    outcome = await handlerOutcome(harness, holderPid, () => settled);
  });
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
    indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX .* \(tenant_id, normalized_email\) WHERE \(normalized_email IS NOT NULL\)$/),
  }]);
  expect(await raceSameEmail(h)).toEqual({ outcome: "blocked", created: false, contacts: 1 });
});

it("mutation: without the unique email index the same race stores a duplicate contact", async () => {
  expect(await raceSameEmail(mutant)).toEqual({ outcome: "settled", created: true, contacts: 2 });
});

it("sync: a handler that neither blocks on the holder nor settles fails with a sync timeout", async () => {
  const sleeper = await h.database.runtimePool.connect();
  try {
    const slow = sleeper.query("SELECT pg_sleep(1)");
    await expect(h.fixture.a.run(async (tx) => {
      const holderPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      return handlerOutcome(h, holderPid, () => false, 300);
    })).rejects.toThrow(/^sync timeout: /);
    await slow;
  } finally {
    sleeper.release();
  }
});
