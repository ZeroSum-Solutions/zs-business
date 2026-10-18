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
 * A direct runtime insert of the email stays uncommitted while the handler creates or
 * finds the same email, then commits. The index makes the handler wait, lose with 23505,
 * and find the winner; without it both rows commit.
 */
async function raceSameEmail(harness: Harness) {
  const tenantId = harness.fixture.a.tenantId;
  const email = `race-${randomUUID()}@example.test`;
  let pending: Promise<Awaited<ReturnType<typeof createOrFindContact>>> | undefined;
  let settled = false;
  let blocked = false;
  await harness.fixture.a.run(async (tx) => {
    await tx.query(
      "INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at) VALUES ($1,$2,NULL,$3,NULL,now(),now())",
      [tenantId, randomUUID(), email],
    );
    pending = createOrFindContact(contactCommand(tenantId, { email }), harness.ctx(tenantId));
    pending.then(() => { settled = true; }, () => { settled = true; });
    // Commit once the handler is blocked on our row, or has already finished without blocking.
    for (let i = 0; i < 250 && !settled; i += 1) {
      // The superuser pool can see other roles' wait events.
      const waiting = (await harness.database.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )).rowCount;
      if (waiting) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  const result = await pending!;
  const contacts = await harness.fixture.service(async (tx) => (await tx.query(
    "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [tenantId, email],
  )).rowCount);
  return { blocked, created: result.result.created, contacts };
}

it("C-8: the unique email index exists and concurrent create/find of one email yields one contact", async () => {
  const index = await h.fixture.service(async (tx) => (await tx.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='crm_contacts_tenant_email'",
  )).rows);
  expect(index).toEqual([{
    indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX .* \(tenant_id, normalized_email\) WHERE \(normalized_email IS NOT NULL\)$/),
  }]);
  expect(await raceSameEmail(h)).toEqual({ blocked: true, created: false, contacts: 1 });
});

it("mutation: without the unique email index the same race stores a duplicate contact", async () => {
  expect(await raceSameEmail(mutant)).toEqual({ blocked: false, created: true, contacts: 2 });
});
