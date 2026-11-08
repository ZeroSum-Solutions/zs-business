import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing.js";
import { collectDrift, mirroredTables, normaliseIndexDef } from "./drizzle-drift-lib.js";

/**
 * Drift test: the SQL migrations are the source of truth, and packages/db/src/schema/*.ts mirrors
 * 12 of the tables. collectDrift (drizzle-drift-lib.ts) compares them in both directions on a
 * migrated database and returns every difference. The second block seeds one drift of each kind
 * into the database and requires the comparison to report it.
 */
it("defines the 12 tables this test covers", () => {
  expect(mirroredTables.map((table) => getTableConfig(table).name).sort()).toEqual([
    "actions", "booking_external_blocks", "booking_resources", "bookings", "crm_contact_consent", "crm_contacts",
    "crm_deals", "crm_pipelines", "crm_stages", "outbox", "tenant_members", "tenants",
  ]);
});

it("matches the migrated database: columns, enums, RLS, policies, constraints, indexes and foreign keys", async () => {
  await withTestDatabase(async (database) => {
    expect(await collectDrift(database.pool)).toEqual([]);
  });
});

describe("normaliseIndexDef", () => {
  it("strips the schema qualifier outside string literals only, the same for both schemas", () => {
    const predicate = "(payload ->> 'scope'::text) = 'public.foo'::text";
    expect(normaliseIndexDef(`CREATE INDEX i ON public.t USING btree (public.f(a)) WHERE ${predicate}`))
      .toBe(`ON USING btree (f(a)) WHERE ${predicate}`);
    expect(normaliseIndexDef(`CREATE INDEX i ON zs_drift_ab12.t USING btree (public.f(a)) WHERE ${predicate}`))
      .toBe(normaliseIndexDef(`CREATE INDEX i ON public.t USING btree (zs_drift.f(a)) WHERE ${predicate}`));
    expect(normaliseIndexDef("CREATE INDEX i ON public.t USING btree (a) WHERE (b = 'foo')"))
      .not.toBe(normaliseIndexDef("CREATE INDEX i ON public.t USING btree (a) WHERE (b = 'public.foo')"));
  });
});

// Each statement changes the database away from the migrations; the comparison must name it.
const SEEDED: [string, string, RegExp][] = [
  ["policy text", "ALTER POLICY tenant_scope ON crm_pipelines USING (true)", /crm_pipelines: policy tenant_scope qual/],
  ["CHECK constraint dropped", "ALTER TABLE crm_stages DROP CONSTRAINT crm_stages_outcome", /crm_stages: constraint crm_stages_outcome is in Drizzle, not in the database/],
  ["CHECK constraint added", "ALTER TABLE crm_stages ADD CONSTRAINT crm_stages_extra CHECK (position < 1000)", /crm_stages: constraint crm_stages_extra is in the database, not in Drizzle/],
  ["column default", "ALTER TABLE crm_stages ALTER COLUMN outcome SET DEFAULT 'won'", /crm_stages: column outcome default/],
  ["identity dropped", "ALTER TABLE outbox ALTER COLUMN seq DROP IDENTITY", /outbox: column seq identity/],
  ["enum label", "ALTER TYPE member_role ADD VALUE 'viewer'", /enum member_role/],
  ["UNIQUE constraint replaced by a plain index",
    "ALTER TABLE actions DROP CONSTRAINT actions_tenant_key; CREATE UNIQUE INDEX actions_tenant_key ON actions (tenant_id, idempotency_key)",
    /actions: constraint actions_tenant_key is in Drizzle, not in the database/],
  ["foreign key not validated",
    "ALTER TABLE crm_deals DROP CONSTRAINT crm_deals_tenant_id_contact_id_fkey; ALTER TABLE crm_deals ADD CONSTRAINT crm_deals_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES crm_contacts(tenant_id, id) NOT VALID",
    /crm_deals: foreign key crm_deals_tenant_id_contact_id_fkey/],
  ["duplicate foreign key", "ALTER TABLE bookings ADD CONSTRAINT bookings_dup_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES booking_resources(tenant_id, id)",
    /bookings: foreign key bookings_dup_fkey is in the database, not in Drizzle/],
  ["foreign key deferrable", "ALTER TABLE outbox ALTER CONSTRAINT outbox_tenant_id_action_id_fkey DEFERRABLE",
    /outbox: foreign key outbox_tenant_id_action_id_fkey/],
  ["foreign key to an unmirrored parent dropped", "ALTER TABLE bookings DROP CONSTRAINT bookings_intake_item_fk",
    /bookings: foreign key bookings_intake_item_fk to unmirrored intake_items is missing/],
  ["index invalid", "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'bookings_tenant_start'::regclass", /bookings: index bookings_tenant_start is not valid and ready/],
  ["index storage option", "ALTER INDEX bookings_tenant_start SET (fillfactor = 70)", /bookings: index bookings_tenant_start:/],
  ["index predicate literal", "DROP INDEX crm_deals_tenant_won; CREATE INDEX crm_deals_tenant_won ON crm_deals (tenant_id, won_at) WHERE won_at IS NOT NULL AND currency <> 'public.x'",
    /crm_deals: index crm_deals_tenant_won:/],
];

describe("seeded drift", () => {
  it.each(SEEDED)("reports %s", async (_kind, statement, expected) => {
    await withTestDatabase(async (database) => {
      await database.pool.query(statement);
      const problems = await collectDrift(database.pool);
      expect(problems.join("\n")).toMatch(expected);
    });
  });
});

describe("seeded pinned drift", () => {
  it.each([
    ["FORCE ROW LEVEL SECURITY off", "ALTER TABLE bookings NO FORCE ROW LEVEL SECURITY", /bookings: FORCE ROW LEVEL SECURITY is off/],
    ["EXCLUDE constraint dropped", "ALTER TABLE bookings DROP CONSTRAINT bookings_resource_occupied_excl", /bookings: EXCLUDE constraint bookings_resource_occupied_excl is missing/],
    ["generated column", "ALTER TABLE tenant_members DROP COLUMN updated_at; ALTER TABLE tenant_members ADD COLUMN updated_at timestamptz GENERATED ALWAYS AS (created_at) STORED", /tenant_members: column updated_at generated/],
    ["column order", "ALTER TABLE crm_contacts ADD COLUMN note text", /crm_contacts: column order/],
  ])("reports %s", async (_kind, statement, expected) => {
    await withTestDatabase(async (database) => {
      await database.pool.query(statement);
      expect((await collectDrift(database.pool)).join("\n")).toMatch(expected);
    });
  });
});
