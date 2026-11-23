// Inbound email storage rules (20261122100000_inbound_email.sql; inbound-email.md IE-2, IE-3, IE-31, IE-35, test 1):
// addresses come with the tenant and only the service role writes them; the route function names an active or
// retiring handle's tenant and nothing else; the runtime role reads its tenant's emails without the lease columns,
// inserts only the receive columns; and the content guard holds for every role, the table owner included.
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { asService, type Transaction } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, withTestDatabase, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const T0 = "2026-11-22T16:00:00.000Z";
const T1 = "2026-11-22T16:05:00.000Z";
const MIGRATION = "20261122100000_inbound_email.sql";
const migrations = new URL("../../../supabase/migrations/", import.meta.url);

let database: TestDatabase;
let fixture: TwoTenantFixture;
const denied = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

interface Address { id: string; handle: string; status: string }
const addressOf = (tenantId: string) => fixture.service(async (tx) => (await tx.query<Address>(
  "SELECT id, handle, status FROM inbound_email_addresses WHERE tenant_id=$1 AND status='active'", [tenantId])).rows[0]!);

/** A received row as the receive action writes it, through the runtime role. */
async function receive(tx: Transaction, tenantId: string, addressId: string, emailId = randomUUID()) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO inbound_emails (tenant_id,id,address_id,provider,provider_email_id,reply_ref,from_address,subject,received_at,sender_key,created_at)
     VALUES ($1,$2,$3,'resend',$4,NULL,'mira@example.com','Hello',$5,$6,$5)`,
    [tenantId, id, addressId, emailId, T0, randomUUID()]);
  return id;
}
const SETTLE = `status='ready', kind='message', body_state='full', body_text='Hi', from_name='Mira', auth='pass', match='none',
  review='unmatched', settled_at='${T1}'`;
const ERASE = `body_text=NULL, from_name=NULL, subject=NULL, attachments=NULL, in_reply_to=NULL, "references"=NULL,
  body_state='erased', erased_at='${T1}'`;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

describe("addresses (IE-2)", () => {
  it("gives every new tenant one active reply address with a 16-character base32 handle, unique across tenants", async () => {
    const a = await addressOf(fixture.a.tenantId);
    const b = await addressOf(fixture.b.tenantId);
    for (const address of [a, b]) expect(address.handle).toMatch(/^[a-z2-7]{16}$/);
    expect(a.handle).not.toBe(b.handle);
    const counts = await fixture.service(async (tx) => (await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM inbound_email_addresses WHERE tenant_id = ANY($1)", [[fixture.a.tenantId, fixture.b.tenantId]])).rows[0]!.n);
    expect(counts).toBe(2);
  });

  it("draws handles that vary in every position", async () => {
    const handles = await fixture.service(async (tx) => (await tx.query<{ h: string }>(
      "SELECT inbound_email_new_handle() AS h FROM generate_series(1, 400)")).rows.map((row) => row.h));
    expect(new Set(handles).size).toBe(400);
    for (let position = 0; position < 16; position += 1)
      expect(new Set(handles.map((handle) => handle[position])).size, `position ${position}`).toBeGreaterThan(16);
  });

  it("allows one active reply address per tenant, and a retiring or disabled one only with its time", async () => {
    const tenantId = fixture.a.tenantId;
    const insert = (status: string, extra = "") => denied(() => fixture.service((tx) => tx.query(
      `INSERT INTO inbound_email_addresses (tenant_id,id,handle,status,created_at${extra ? ",retire_after" : ""})
       VALUES ($1,$2,inbound_email_new_handle(),$3,$4${extra ? ",$4" : ""})`, [tenantId, randomUUID(), status, T0])));
    expect(await insert("active")).toMatchObject({ code: "23505", constraint: "inbound_email_addresses_one_active" });
    expect(await insert("retiring")).toMatchObject({ code: "23514", constraint: "inbound_email_addresses_retiring" });
    expect(await insert("disabled")).toMatchObject({ code: "23514", constraint: "inbound_email_addresses_disabled" });
    expect(await denied(() => fixture.service((tx) => tx.query(
      "INSERT INTO inbound_email_addresses (tenant_id,id,handle,created_at) VALUES ($1,$2,'NOT-A-HANDLE',$3)",
      [tenantId, randomUUID(), T0])))).toMatchObject({ code: "23514", constraint: "inbound_email_addresses_handle" });
  });

  it("lets the runtime role read its own tenant's addresses and write none", async () => {
    const a = await addressOf(fixture.a.tenantId);
    expect((await fixture.a.run((tx) => tx.query("SELECT handle FROM inbound_email_addresses"))).rows).toEqual([{ handle: a.handle }]);
    expect((await fixture.b.run((tx) => tx.query("SELECT handle FROM inbound_email_addresses WHERE tenant_id=$1", [fixture.a.tenantId]))).rowCount).toBe(0);
    for (const statement of [
      "UPDATE inbound_email_addresses SET status='disabled', disabled_at=now()",
      "DELETE FROM inbound_email_addresses",
    ]) expect(await denied(() => fixture.a.run((tx) => tx.query(statement))), statement).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "INSERT INTO inbound_email_addresses (tenant_id,id,handle,status,created_at,retire_after) VALUES ($1,$2,'aaaaaaaaaaaaaaaa','retiring',$3,$3)",
      [fixture.a.tenantId, randomUUID(), T0])))).toMatchObject({ code: "42501" });
  });
});

describe("routing a handle (IE-3, test 1)", () => {
  it("names the tenant and address of an active or retiring handle, and nothing for a disabled or unknown one", async () => {
    const tenantId = fixture.b.tenantId;
    const retiring = { id: randomUUID(), handle: "" };
    const disabled = { id: randomUUID(), handle: "" };
    await fixture.service(async (tx) => {
      retiring.handle = (await tx.query<{ handle: string }>(
        `INSERT INTO inbound_email_addresses (tenant_id,id,handle,status,created_at,retire_after)
         VALUES ($1,$2,inbound_email_new_handle(),'retiring',$3,$3) RETURNING handle`, [tenantId, retiring.id, T0])).rows[0]!.handle;
      disabled.handle = (await tx.query<{ handle: string }>(
        `INSERT INTO inbound_email_addresses (tenant_id,id,handle,status,created_at,disabled_at)
         VALUES ($1,$2,inbound_email_new_handle(),'disabled',$3,$3) RETURNING handle`, [tenantId, disabled.id, T0])).rows[0]!.handle;
    });
    const active = await addressOf(tenantId);
    // The runtime role with no tenant set, and from another tenant's scope: the function is the only way in.
    const route = (handle: string) => database.db.withoutTenant(async (tx) => (await tx.query(
      "SELECT * FROM inbound_email_route($1)", [handle])).rows);
    expect(await route(active.handle)).toEqual([{ tenant_id: tenantId, address_id: active.id }]);
    expect(await route(retiring.handle)).toEqual([{ tenant_id: tenantId, address_id: retiring.id }]);
    expect(await route(disabled.handle)).toEqual([]);
    expect(await route("aaaaaaaaaaaaaaaa")).toEqual([]);
    expect((await fixture.a.run((tx) => tx.query("SELECT * FROM inbound_email_route($1)", [active.handle]))).rows)
      .toEqual([{ tenant_id: tenantId, address_id: active.id }]);
    // Without the function, the runtime role sees no other tenant's handle.
    expect((await database.db.withoutTenant((tx) => tx.query("SELECT 1 FROM inbound_email_addresses"))).rowCount).toBe(0);
  });
});

describe("emails under the runtime role (IE-31, test 1)", () => {
  it("inserts the receive columns only, takes the received defaults, and reads no lease column", async () => {
    const tenantId = fixture.a.tenantId;
    const address = await addressOf(tenantId);
    const id = await fixture.a.run((tx) => receive(tx, tenantId, address.id));
    const row = (await fixture.a.run((tx) => tx.query(
      "SELECT status, kind, body_state, review, contact_id FROM inbound_emails WHERE id=$1", [id]))).rows[0];
    expect(row).toEqual({ status: "received", kind: "unclassified", body_state: "none", review: null, contact_id: null });
    expect(await denied(() => fixture.a.run((tx) => tx.query("SELECT lease_token FROM inbound_emails")))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query("SELECT * FROM inbound_emails")))).toMatchObject({ code: "42501" });
    // A received row cannot be inserted settled: status is not an insert column.
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      `INSERT INTO inbound_emails (tenant_id,id,address_id,provider,provider_email_id,status,from_address,received_at,sender_key,created_at)
       VALUES ($1,$2,$3,'resend','x','ready','m@example.com',$4,$5,$4)`, [tenantId, randomUUID(), address.id, T0, randomUUID()]))))
      .toMatchObject({ code: "42501" });
    for (const statement of ["UPDATE inbound_emails SET lease_token=gen_random_uuid(), lease_expires_at=now()", "DELETE FROM inbound_emails"])
      expect(await denied(() => fixture.a.run((tx) => tx.query(statement))), statement).toMatchObject({ code: "42501" });
  });

  it("shows tenant B none of tenant A's emails and refuses every write against them", async () => {
    const a = fixture.a.tenantId;
    const address = await addressOf(a);
    const id = await fixture.a.run((tx) => receive(tx, a, address.id));
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM inbound_emails WHERE tenant_id=$1 OR id=$2", [a, id]))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, [id]))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query("UPDATE inbound_emails SET review='rejected' WHERE tenant_id=$1", [a]))).rowCount).toBe(0);
    // B cannot insert into A, even naming A's address.
    expect(await denied(() => fixture.b.run((tx) => receive(tx, a, address.id)))).toMatchObject({ code: "42501" });
    // B's own row cannot name A's address: the key includes tenant_id.
    expect(await denied(() => fixture.b.run((tx) => receive(tx, fixture.b.tenantId, address.id)))).toMatchObject({ code: "23503" });
  });

  it("keeps one row per provider message per tenant", async () => {
    const tenantId = fixture.a.tenantId;
    const address = await addressOf(tenantId);
    const emailId = randomUUID();
    await fixture.a.run((tx) => receive(tx, tenantId, address.id, emailId));
    expect(await denied(() => fixture.a.run((tx) => receive(tx, tenantId, address.id, emailId))))
      .toMatchObject({ code: "23505", constraint: "inbound_emails_provider_unique" });
  });
});

describe("the content guard (IE-35)", () => {
  let address: Address;
  beforeAll(async () => { address = await addressOf(fixture.a.tenantId); });
  const fresh = () => fixture.a.run((tx) => receive(tx, fixture.a.tenantId, address.id));
  const asRuntime = (sql: string, id: string) => fixture.a.run(async (tx) => (await tx.query(sql, [id])).rowCount);
  const asServiceRole = (sql: string, id: string) => fixture.service(async (tx) => (await tx.query(sql, [id])).rowCount);
  const asOwner = async (sql: string, id: string) => (await database.pool.query(sql, [id])).rowCount;
  const roles = [["runtime", asRuntime], ["service role", asServiceRole], ["table owner", asOwner]] as const;

  it("never changes a receive column, for any role", async () => {
    const id = await fresh();
    for (const [set, who] of [
      ["from_address='other@example.com'", asServiceRole], ["received_at=now()", asServiceRole], ["sender_key=gen_random_uuid()", asOwner],
      ["provider_email_id='other'", asOwner], ["reply_ref='aaaaaaaaaaaaaaaa'", asServiceRole],
    ] as const)
      expect(await denied(() => who(`UPDATE inbound_emails SET ${set} WHERE id=$1`, id)), set)
        .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
  });

  it("changes the settlement columns only in the one settle, for every role", async () => {
    for (const [who, run] of roles) {
      const id = await fresh();
      // Before the settle: content alone may not change.
      expect(await denied(() => run("UPDATE inbound_emails SET subject='Changed' WHERE id=$1", id)), who)
        .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
      expect(await run(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, id), who).toBe(1);
      for (const set of ["body_text='Again'", "status='received', settled_at=NULL", "kind='spam'", `status='dropped', drop_reason='loop'`])
        expect(await denied(() => run(`UPDATE inbound_emails SET ${set} WHERE id=$1`, id)), `${who}: ${set}`)
          .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
    }
  });

  it("changes the lease only while the row is received", async () => {
    const id = await fresh();
    expect(await asServiceRole("UPDATE inbound_emails SET lease_token=gen_random_uuid(), lease_expires_at=now(), attempts=1 WHERE id=$1", id)).toBe(1);
    expect(await asRuntime(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, id)).toBe(1);
    expect(await denied(() => asServiceRole("UPDATE inbound_emails SET attempts=2 WHERE id=$1", id)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
  });

  it("changes the link columns only by settle, link or reject", async () => {
    const contactId = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at) VALUES ($1,$2,'Mira','mira@example.com',$3,$3)",
      [fixture.a.tenantId, contactId, T0]));
    const link = `review='linked', contact_id='${contactId}', linked_by=gen_random_uuid(), linked_at=now()`;
    const id = await fresh();
    // A received row has no review to move from.
    expect(await denied(() => asRuntime(`UPDATE inbound_emails SET ${link} WHERE id=$1`, id)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
    expect(await asRuntime(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, id)).toBe(1);
    expect(await asRuntime(`UPDATE inbound_emails SET ${link} WHERE id=$1`, id)).toBe(1);
    expect(await denied(() => asRuntime("UPDATE inbound_emails SET review='rejected', contact_id=NULL WHERE id=$1", id)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
    const other = await fresh();
    expect(await asRuntime(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, other)).toBe(1);
    expect(await asRuntime("UPDATE inbound_emails SET review='rejected' WHERE id=$1", other)).toBe(1);
    expect(await denied(() => asRuntime("UPDATE inbound_emails SET review='unmatched' WHERE id=$1", other)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
  });

  it("allows the one erasure, by the service role, after settle, once", async () => {
    const received = await fresh();
    expect(await denied(() => asServiceRole(`UPDATE inbound_emails SET ${ERASE} WHERE id=$1`, received)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
    const id = await fresh();
    expect(await asRuntime(`UPDATE inbound_emails SET ${SETTLE} WHERE id=$1`, id)).toBe(1);
    expect(await denied(() => asRuntime(`UPDATE inbound_emails SET ${ERASE} WHERE id=$1`, id))).toMatchObject({ code: "42501" });
    expect(await denied(() => asOwner(`UPDATE inbound_emails SET ${ERASE} WHERE id=$1`, id))).toMatchObject({ code: "42501" });
    // An erasure that also changes something else is not the erasure.
    expect(await denied(() => asServiceRole(`UPDATE inbound_emails SET ${ERASE}, kind='spam' WHERE id=$1`, id)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
    expect(await asServiceRole(`UPDATE inbound_emails SET ${ERASE} WHERE id=$1`, id)).toBe(1);
    expect(await denied(() => asServiceRole(`UPDATE inbound_emails SET erased_at='${T0}' WHERE id=$1`, id)))
      .toMatchObject({ code: "23514", constraint: "inbound_emails_guard" });
  });

  it("lets only the service role delete", async () => {
    const id = await fresh();
    expect(await denied(() => asOwner("DELETE FROM inbound_emails WHERE id=$1", id))).toMatchObject({ code: "42501" });
    expect(await asServiceRole("DELETE FROM inbound_emails WHERE id=$1", id)).toBe(1);
  });
});

it("backfills an address for every tenant a database already holds, as the non-superuser migrator", async () => {
  const partial = await mkdtemp(join(tmpdir(), "zs-migrations-pre-inbound-"));
  try {
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < MIGRATION))
      await copyFile(new URL(name, migrations), join(partial, name));
    const handles = await withTestDatabase(async (database) => {
      const tenants = [randomUUID(), randomUUID()];
      await asService(database.servicePool, (tx) => tx.query(
        "INSERT INTO tenants (tenant_id,name) VALUES ($1,'One'),($2,'Two')", tenants));
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name >= MIGRATION))
        await copyFile(new URL(name, migrations), join(partial, name));
      const url = new URL(database.url);
      url.username = database.migrator!;
      const migrator = new Pool({ connectionString: url.href, max: 1 });
      try {
        await migrate(migrator, pathToFileURL(`${partial}/`));
      } finally {
        await migrator.end();
      }
      return asService(database.servicePool, async (tx) => (await tx.query<{ tenant_id: string; handle: string; status: string; force: boolean }>(
        `SELECT a.tenant_id, a.handle, a.status, (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.inbound_email_addresses'::regclass) AS force
           FROM inbound_email_addresses a WHERE a.tenant_id = ANY($1) ORDER BY a.tenant_id`, [tenants])).rows);
    }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true });
    expect(handles).toHaveLength(2);
    for (const row of handles) expect(row).toMatchObject({ handle: expect.stringMatching(/^[a-z2-7]{16}$/), status: "active", force: true });
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}, 180_000);
