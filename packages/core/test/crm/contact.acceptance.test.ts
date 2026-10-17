import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conflict, ValidationFailed, type ContactConsent } from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, createOrFindContact, crmHandlers, type DispatchContext } from "../../src/index.js";
import { shouldWriteConsent } from "../../src/crm/contact.js";
import { contactCommand, createHarness, NOW, rejection, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h?.close(); });

const granted = (recordedAt: string, source = "form") => ({ status: "granted" as const, source, recordedAt });
const denied = (recordedAt: string, source = "reply") => ({ status: "denied" as const, source, recordedAt });
const T1 = "2026-10-01T08:00:00.000Z";
const T2 = "2026-10-10T08:00:00.000Z";

describe("contact create/find on the runtime database", () => {
  it("C-2/C-5/C-12: creates with normalized email and injected timestamps", async () => {
    const a = h.fixture.a.tenantId;
    const command = contactCommand(a, { displayName: "Ana", email: "  Ana@Example.Test ", phone: "+14155550100" });
    const out = await createOrFindContact(command, h.ctx(a));
    expect(out.result).toEqual({
      created: true,
      contact: {
        id: command.payload.contactId, tenantId: a, displayName: "Ana", email: "ana@example.test",
        phone: "+14155550100", consent: { email: null, sms: null }, createdAt: NOW, updatedAt: NOW,
      },
    });
  });

  it("C-6/C-12: finds by one identity, fills absent phone and name, bumps updatedAt only on change", async () => {
    const a = h.fixture.a.tenantId;
    const first = await createOrFindContact(contactCommand(a, { email: "fill@example.test" }), h.ctx(a, T1));
    const candidate = randomUUID();
    const found = await createOrFindContact(
      contactCommand(a, { contactId: candidate, email: "fill@example.test", phone: "+14155550101", displayName: "Fill" }),
      h.ctx(a, T2));
    expect(found.result.created).toBe(false);
    expect(found.result.contact).toMatchObject({
      id: first.result.contact.id, phone: "+14155550101", displayName: "Fill", createdAt: T1, updatedAt: T2,
    });
    expect(await h.fixture.service(async (tx) => (await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [a, candidate])).rowCount)).toBe(0);
    // Unchanged find keeps the prior updatedAt but still records one action and event.
    const actionsBefore = await h.count("actions", a);
    const again = await createOrFindContact(contactCommand(a, { phone: "+14155550101", displayName: "Other" }), h.ctx(a, NOW));
    expect(again.result.contact).toMatchObject({ displayName: "Fill", updatedAt: T2 });
    expect(await h.count("actions", a)).toBe(actionsBefore + 1);
    expect(await h.count("outbox", a)).toBe(actionsBefore + 1);
  });

  it("C-7/C-19: split identity is a typed Conflict with no writes", async () => {
    const a = h.fixture.a.tenantId;
    await createOrFindContact(contactCommand(a, { email: "split-a@example.test" }), h.ctx(a));
    await createOrFindContact(contactCommand(a, { phone: "+14155550102" }), h.ctx(a));
    const [actions, consent] = [await h.count("actions", a), await h.count("crm_contact_consent", a)];
    const error = await rejection(createOrFindContact(contactCommand(a, {
      email: "split-a@example.test", phone: "+14155550102", consent: { email: granted(T1), sms: null },
    }), h.ctx(a)));
    expect(error).toBeInstanceOf(Conflict);
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "split_identity" } });
    expect(await h.count("actions", a)).toBe(actions);
    expect(await h.count("outbox", a)).toBe(actions);
    expect(await h.count("crm_contact_consent", a)).toBe(consent);
  });

  it("C-6: a supplied identity that differs from the matched row is identity_mismatch", async () => {
    const a = h.fixture.a.tenantId;
    await createOrFindContact(contactCommand(a, { email: "mm@example.test", phone: "+14155550103" }), h.ctx(a));
    const error = await rejection(createOrFindContact(contactCommand(a, { email: "mm@example.test", phone: "+14155550104" }), h.ctx(a)));
    expect(error).toMatchObject({ code: "Conflict", details: { reason: "identity_mismatch" } });
  });

  it("C-5/C-18: an existing candidate ID that is not the match is id_in_use", async () => {
    const a = h.fixture.a.tenantId;
    const existing = await createOrFindContact(contactCommand(a, { email: "owner@example.test" }), h.ctx(a));
    const id = existing.result.contact.id;
    expect(await rejection(createOrFindContact(contactCommand(a, { contactId: id, email: "new@example.test" }), h.ctx(a))))
      .toMatchObject({ code: "Conflict", details: { reason: "id_in_use" } });
    await createOrFindContact(contactCommand(a, { email: "matched@example.test" }), h.ctx(a));
    expect(await rejection(createOrFindContact(contactCommand(a, { contactId: id, email: "matched@example.test" }), h.ctx(a))))
      .toMatchObject({ code: "Conflict", details: { reason: "id_in_use" } });
    // The candidate being the match itself is fine.
    const self = await createOrFindContact(contactCommand(a, { contactId: id, email: "owner@example.test" }), h.ctx(a));
    expect(self.result).toMatchObject({ created: false, contact: { id } });
  });

  it("C-1: identical identities and IDs in another tenant are independent", async () => {
    const { a, b } = h.fixture;
    const inA = await createOrFindContact(contactCommand(a.tenantId, { email: "shared@example.test" }), h.ctx(a.tenantId));
    const inB = await createOrFindContact(
      contactCommand(b.tenantId, { contactId: inA.result.contact.id, email: "shared@example.test" }), h.ctx(b.tenantId));
    expect(inB.result).toMatchObject({ created: true, contact: { id: inA.result.contact.id, tenantId: b.tenantId } });
  });

  it("C-4/C-11: future-dated evidence is ValidationFailed before identity conflicts", async () => {
    const a = h.fixture.a.tenantId;
    await createOrFindContact(contactCommand(a, { email: "fut-a@example.test" }), h.ctx(a));
    await createOrFindContact(contactCommand(a, { phone: "+14155550105" }), h.ctx(a));
    const error = await rejection(createOrFindContact(contactCommand(a, {
      email: "fut-a@example.test", phone: "+14155550105", mode: "import",
      consent: { email: null, sms: granted("2026-10-19T08:00:00.001Z") },
    }), h.ctx(a)));
    expect(error).toBeInstanceOf(ValidationFailed);
  });

  it("C-2/C-3/C-17: invalid identities never reach dispatch", async () => {
    const a = h.fixture.a.tenantId;
    for (const payload of [{ email: "   " }, { email: "ánа@example.test" }, { phone: " +14155550123" }, { phone: "+1 415 555" }]) {
      let called = false;
      const command = { ...contactCommand(a, { email: "ok@example.test" }) };
      const raw = { ...command, payload: { ...command.payload, ...payload } };
      const error = await rejection(createOrFindContact(raw as never, { dispatch: async () => { called = true; throw new Error(); } }));
      expect(error).toBeInstanceOf(ValidationFailed);
      expect(called).toBe(false);
    }
  });

  it("C-10: import preserves existing evidence byte-for-byte and fills null channels", async () => {
    const a = h.fixture.a.tenantId;
    const created = await createOrFindContact(contactCommand(a, {
      email: "imp@example.test", consent: { email: granted(T1, "opt-in"), sms: null },
    }), h.ctx(a, T1));
    const imported = await createOrFindContact(contactCommand(a, {
      email: "imp@example.test", mode: "import",
      consent: { email: denied(T2, "import-file"), sms: denied(T2, "import-file") },
    }), h.ctx(a, NOW));
    expect(imported.result.contact.consent).toEqual({ email: granted(T1, "opt-in"), sms: denied(T2, "import-file") });
    expect(imported.result.contact.id).toBe(created.result.contact.id);
    expect(imported.result.contact.updatedAt).toBe(NOW);
  });

  it("C-11: interactive consent takes later evidence, ignores older, denial wins ties", async () => {
    const a = h.fixture.a.tenantId;
    const email = "ia@example.test";
    const run = (consent: ContactConsent) =>
      createOrFindContact(contactCommand(a, { email, consent }), h.ctx(a));
    await run({ email: denied(T1), sms: null });
    expect((await run({ email: granted(T1), sms: null })).result.contact.consent.email).toEqual(denied(T1));
    expect((await run({ email: granted("2026-09-01T00:00:00.000Z"), sms: null })).result.contact.consent.email).toEqual(denied(T1));
    expect((await run({ email: denied(T1, "other"), sms: null })).result.contact.consent.email).toEqual(denied(T1));
    expect((await run({ email: granted(T2, "later"), sms: null })).result.contact.consent.email).toEqual(granted(T2, "later"));
    expect((await run({ email: null, sms: null })).result.contact.consent.email).toEqual(granted(T2, "later"));
    expect((await run({ email: denied(T2), sms: null })).result.contact.consent.email).toEqual(denied(T2));
  });

  it("C-11: merge decision table", () => {
    const at = (iso: string) => (BigInt(new Date(iso).getTime()) * 1000n).toString();
    expect(shouldWriteConsent("import", { status: "granted", recorded_us: at(T1) }, denied(T2))).toBe(false);
    expect(shouldWriteConsent("import", undefined, denied(T2))).toBe(true);
    expect(shouldWriteConsent("interactive", { status: "denied", recorded_us: at(T1) }, granted(T1))).toBe(false);
    expect(shouldWriteConsent("interactive", { status: "granted", recorded_us: at(T1) }, denied(T1))).toBe(true);
    expect(shouldWriteConsent("interactive", { status: "granted", recorded_us: at(T1) }, granted(T1, "x"))).toBe(false);
    expect(shouldWriteConsent("interactive", { status: "denied", recorded_us: at(T1) }, null)).toBe(false);
  });

  it("C-8: concurrent different-key creates of one identity yield one created and one found", async () => {
    const a = h.fixture.a.tenantId;
    const results = await Promise.all([0, 1, 2].map(() =>
      createOrFindContact(contactCommand(a, { email: "race@example.test", phone: "+14155550106" }), h.ctx(a))));
    expect(results.filter((r) => r.result.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.result.contact.id)).size).toBe(1);
  });

  it("C-7/C-8: opposite-order split identities fail with split_identity and never deadlock", async () => {
    const a = h.fixture.a.tenantId;
    const tag = randomUUID().slice(0, 8);
    const [emailP, phoneP, emailQ, phoneQ] = [`p-${tag}@example.test`, "+14155550201", `q-${tag}@example.test`, "+14155550202"];
    await createOrFindContact(contactCommand(a, { email: emailP, phone: phoneP }), h.ctx(a));
    await createOrFindContact(contactCommand(a, { email: emailQ, phone: phoneQ }), h.ctx(a));
    // First command: email matches P, phone matches Q. Second: email matches Q, phone matches P.
    const commands = [
      contactCommand(a, { email: emailP, phone: phoneQ }),
      contactCommand(a, { email: emailQ, phone: phoneP }),
    ];
    // Hold each command after its first contact-row lock query until its peer either has run its own first
    // lock query or is blocked on a lock. With per-identity row locks in opposite orders this deadlocks every
    // time; with one ordered lock query the peer blocks, which releases the barrier.
    const peers = [{ pid: undefined as number | undefined, arrived: false }, { pid: undefined as number | undefined, arrived: false }];
    const peerArrivedOrBlocked = async (peer: (typeof peers)[number]) => {
      for (;;) {
        if (peer.arrived) return;
        if (peer.pid !== undefined && (await h.database.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [peer.pid])).rowCount) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const dbFor = (me: number): ScopedDatabase => ({
      tenant: (tenantId, work) => h.database.db.tenant(tenantId, (tx) => {
        const run = tx.query.bind(tx) as (...args: unknown[]) => Promise<unknown>;
        let held = false;
        const query = async (...args: unknown[]) => {
          const text = String(typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text);
          if (held || !/crm_contacts/.test(text) || !/FOR UPDATE/.test(text)) return run(...args);
          held = true;
          peers[me]!.pid = ((await run("SELECT pg_backend_pid() AS pid")) as { rows: { pid: number }[] }).rows[0]!.pid;
          const result = await run(...args);
          peers[me]!.arrived = true;
          await peerArrivedOrBlocked(peers[1 - me]!);
          return result;
        };
        return work({ query } as unknown as Transaction);
      }),
    });
    const dispatch = createDispatcher({ ...crmHandlers });
    const actorId = randomUUID();
    const run = (me: number) => {
      const { idempotencyKey: _key, ...binding } = commands[me]!;
      const ctx: DispatchContext = {
        tenantId: a, actor: { tenantId: a, id: actorId }, db: dbFor(me),
        clock: { now: () => new Date(NOW) }, config: {}, generateId: randomUUID,
        resolveApproval: async () => ({ ...binding, tenantId: a, actorId }),
      };
      return createOrFindContact(commands[me]!, { dispatch: (command) => dispatch(ctx, command) });
    };
    const results = await Promise.allSettled([run(0), run(1)]);
    for (const result of results)
      expect(result).toMatchObject({ status: "rejected", reason: { code: "Conflict", details: { reason: "split_identity" } } });
  });

  it("C-8: a competing insert after the lookup rolls back to the savepoint and returns the winner", async () => {
    const a = h.fixture.a.tenantId;
    const email = `savepoint-${randomUUID()}@example.test`;
    const winnerId = randomUUID();
    let raced = 0;
    // Commit a competing contact on another connection after the handler's lookup and before its insert,
    // so only the unique index (23505) can arbitrate. The advisory identity locks do not stop this writer.
    const db: ScopedDatabase = {
      tenant: (tenantId, work) => h.database.db.tenant(tenantId, (tx) => {
        const run = tx.query.bind(tx) as (...args: unknown[]) => Promise<unknown>;
        const query = async (...args: unknown[]) => {
          if (typeof args[0] === "string" && /^\s*INSERT INTO crm_contacts/.test(args[0]) && raced++ === 0) {
            await h.fixture.service((service) => service.query(
              `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
               VALUES ($1,$2,'Winner',$3,NULL,$4,$4)`, [a, winnerId, email, NOW]));
          }
          return run(...args);
        };
        return work({ query } as unknown as Transaction);
      }),
    };
    const actionsBefore = await h.count("actions", a);
    const outboxBefore = await h.count("outbox", a);
    const command = contactCommand(a, { email, displayName: "Loser" });
    const actorId = randomUUID();
    const { idempotencyKey: _key, ...binding } = command;
    const ctx: DispatchContext = {
      tenantId: a, actor: { tenantId: a, id: actorId }, db, clock: { now: () => new Date(NOW) }, config: {},
      generateId: randomUUID, resolveApproval: async () => ({ ...binding, tenantId: a, actorId }),
    };
    const out = await createOrFindContact(command, { dispatch: (c) => createDispatcher({ ...crmHandlers })(ctx, c) });
    expect(raced).toBe(1);
    expect(out.result.created).toBe(false);
    expect(out.result.contact).toMatchObject({ id: winnerId, email, displayName: "Winner" });
    expect(await h.count("actions", a)).toBe(actionsBefore + 1);
    expect(await h.count("outbox", a)).toBe(outboxBefore + 1);
    expect(await h.fixture.service(async (tx) => (await tx.query(
      "SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [a, email])).rowCount)).toBe(1);
  });

  it("C-16/C-19: an exact replay returns the stored result without a second action", async () => {
    const a = h.fixture.a.tenantId;
    const command = contactCommand(a, { email: "replay@example.test" });
    const ctx = h.ctx(a);
    const first = await createOrFindContact(command, ctx);
    const actions = await h.count("actions", a);
    expect(await createOrFindContact(command, ctx)).toEqual(first);
    expect(await h.count("actions", a)).toBe(actions);
  });

  it.each([
    ["normalized_email", (n: string) => ({ email: `${n}@example.test`, phone: null })],
    ["e164_phone", (n: string) => ({ email: null, phone: `+1415555${n.slice(0, 4)}` })],
  ])("C-3: the unique index on %s rejects a duplicate in one tenant but allows it in another", async (_column, identity) => {
    const { a, b } = h.fixture;
    const value = identity(String(Math.floor(1000 + Math.random() * 9000)));
    const insert = (tenantId: string) => h.fixture.service((tx) => tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$5)`, [tenantId, randomUUID(), value.email, value.phone, NOW]));
    await insert(a.tenantId);
    await expect(insert(a.tenantId)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(b.tenantId)).resolves.toBeDefined();
  });

  it("C-21/C-24: runtime may insert only its own tenant's contact rows", async () => {
    const { a, b } = h.fixture;
    const insert = (tenantId: string) => a.run((tx) => tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,NULL,$3,NULL,$4,$4)`, [tenantId, randomUUID(), `rls-${randomUUID()}@example.test`, NOW]));
    await expect(insert(a.tenantId)).resolves.toBeDefined();
    await expect(insert(b.tenantId)).rejects.toMatchObject({ code: "42501" });
    expect(await b.run(async (tx) => (await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1", [a.tenantId])).rowCount)).toBe(0);
  });

  it("C-21: every CRM table has tenant_id, enabled and forced RLS, and a tenant policy", async () => {
    const rows = (await h.fixture.service((tx) => tx.query<{ name: string; rls: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
         (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) AS policies
       FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnotnull
       WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'crm\\_%' ORDER BY 1`))).rows;
    expect(rows).toEqual(["crm_contact_consent", "crm_contacts", "crm_deals", "crm_pipelines", "crm_stages"]
      .map((name) => ({ name, rls: true, forced: true, policies: 1 })));
  });
});
