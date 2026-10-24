import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { asService } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// business-profile.md BP-1, BP-2, BP-3, BP-4, BP-9, BP-12 at the database, as the runtime role.

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const profileOf = (tenantId: string) => fixture.service(async (tx) =>
  (await tx.query("SELECT * FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0]);
const tenantName = (tenantId: string) => fixture.service(async (tx) =>
  (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]!.name);
const asA = <T>(work: (tx: import("../src/scoped.js").Transaction) => Promise<T>) => fixture.a.run(work);

describe("the row that comes with a tenant (BP-1)", () => {
  it("is created with the tenant: name copied, USD, revision 1, everything else null", async () => {
    expect(await profileOf(fixture.a.tenantId)).toMatchObject({
      tenant_id: fixture.a.tenantId, display_name: "Tenant A", legal_name: null, phone_e164: null, time_zone: null,
      currency: "USD", postal_address: null, revision: 1, updated_by: null,
    });
    expect((await profileOf(fixture.b.tenantId)).display_name).toBe("Tenant B");
  });

  it("trims and cuts a long or padded tenant name, and falls back for a blank one", async () => {
    const [long, padded, blank] = [randomUUID(), randomUUID(), randomUUID()];
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2),($3,$4),($5,$6)", [
        long, "L".repeat(200), padded, "   Padded & Co   ", blank, "   ",
      ]);
    });
    expect((await profileOf(long)).display_name).toBe("L".repeat(120));
    expect((await profileOf(padded)).display_name).toBe("Padded & Co");
    expect((await profileOf(blank)).display_name).toBe("Business");
    // The tenant takes the same text, so the two names never differ (BP-9).
    expect(await tenantName(long)).toBe("L".repeat(120));
    expect(await tenantName(padded)).toBe("Padded & Co");
    expect(await tenantName(blank)).toBe("Business");
  });
});

describe("backfill (BP-1)", () => {
  it("gives every tenant that existed before the migration a row", async () => {
    const earlier = await mkdtemp(join(tmpdir(), "zs-before-profiles-"));
    const source = new URL("../../../supabase/migrations/", import.meta.url);
    try {
      for (const name of (await readdir(source)).filter((file) => file.endsWith(".sql") && file !== "20261023100000_business_profiles.sql")) {
        await copyFile(new URL(name, source), join(earlier, name));
      }
      const old = await createTestDatabase(undefined, { migrations: pathToFileURL(`${earlier}/`) });
      try {
        const [first, second, blank] = [randomUUID(), randomUUID(), randomUUID()];
        await asService(old.servicePool, (tx) => tx.query(
          "INSERT INTO tenants (tenant_id,name) VALUES ($1,'Halden & Rowe'),($2,$3),($4,' ')", [first, second, "N".repeat(150), blank]));
        expect((await old.pool.query("SELECT to_regclass('public.business_profiles') AS t")).rows[0].t).toBeNull();
        await migrate(old.pool);
        const rows = (await asService(old.servicePool, (tx) => tx.query(
          "SELECT tenant_id, display_name, currency, revision, legal_name, time_zone FROM business_profiles ORDER BY display_name"))).rows;
        expect(rows).toEqual([
          { tenant_id: blank, display_name: "Business", currency: "USD", revision: 1, legal_name: null, time_zone: null },
          { tenant_id: first, display_name: "Halden & Rowe", currency: "USD", revision: 1, legal_name: null, time_zone: null },
          { tenant_id: second, display_name: "N".repeat(120), currency: "USD", revision: 1, legal_name: null, time_zone: null },
        ]);
        // The tenants carry the same names, so the header and the profile agree (BP-9).
        expect((await asService(old.servicePool, (tx) => tx.query(
          "SELECT t.name = p.display_name AS same FROM tenants t JOIN business_profiles p USING (tenant_id) WHERE t.tenant_id = ANY($1)",
          [[first, second, blank]]))).rows).toEqual([{ same: true }, { same: true }, { same: true }]);
        // Forced RLS is back on both tables after the copy.
        expect((await old.pool.query(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('tenants','business_profiles') ORDER BY 1")).rows)
          .toEqual([
            { relname: "business_profiles", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "tenants", relrowsecurity: true, relforcerowsecurity: true },
          ]);
        // A tenant added after the migration gets its row from the trigger.
        const later = randomUUID();
        await asService(old.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Later')", [later]));
        expect((await asService(old.servicePool, (tx) => tx.query(
          "SELECT display_name FROM business_profiles WHERE tenant_id=$1", [later]))).rows).toEqual([{ display_name: "Later" }]);
      } finally {
        await old.close();
      }
    } finally {
      await rm(earlier, { recursive: true, force: true });
    }
  }, 60000);
});

describe("field shapes (BP-2, BP-4)", () => {
  const set = (column: string, value: unknown) => fixture.service((tx) =>
    tx.query(`UPDATE business_profiles SET ${column}=$1 WHERE tenant_id=$2`, [value, fixture.b.tenantId]));

  it.each([
    ["legal_name", ""],
    ["legal_name", "l".repeat(201)],
    ["phone_e164", "4155550123"],
    ["phone_e164", "+1415555"],
    ["phone_e164", "+1234567890123456"],
    ["phone_e164", "+1 415 555 0123"],
    ["currency", "XXZ"],
    ["currency", "usd"],
    ["currency", "XAU"],
    // Withdrawn from ISO 4217: deals may still hold them, a business may not.
    ["currency", "CUC"],
    ["currency", "HRK"],
    ["currency", "SLL"],
    ["currency", "ZWL"],
    ["revision", 0],
  ])("refuses %s = %j", async (column, value) => {
    await expect(set(column, value)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a blank, too long or null display_name, and a null currency", async () => {
    const rename = (name: string | null) => fixture.b.run((tx) => tx.query("UPDATE business_profiles SET display_name=$1", [name]));
    for (const name of ["", "   ", "n".repeat(121)]) await expect(rename(name)).rejects.toMatchObject({ code: "23514" });
    await expect(rename(null)).rejects.toMatchObject({ code: "23502" });
    await expect(set("currency", null)).rejects.toMatchObject({ code: "23502" });
  });

  it("accepts the edges of each shape, and nulls where allowed", async () => {
    // Renaming moves tenants.name too, so it happens in the tenant's own context.
    const rename = (name: string) => fixture.b.run((tx) => tx.query("UPDATE business_profiles SET display_name=$1", [name]));
    await rename("n".repeat(120));
    await set("legal_name", "l".repeat(200));
    await set("phone_e164", "+12345678");
    await set("phone_e164", "+123456789012345");
    await set("phone_e164", null);
    await set("currency", "EUR");
    await set("currency", "ZWG");
    await set("legal_name", null);
    await rename("Tenant B");
    await set("currency", "USD");
  });

  const ADDRESS = { line1: "1 High St", city: "London", country: "GB" };
  it.each([
    ["a full address", { ...ADDRESS, line2: "Floor 2", region: "Greater London", postalCode: "N1 9GU" }, true],
    ["the minimal address", ADDRESS, true],
    ["a missing city", { line1: "1 High St", country: "GB" }, false],
    ["a missing line1", { city: "London", country: "GB" }, false],
    ["a missing country", { line1: "1 High St", city: "London" }, false],
    ["a lowercase country", { ...ADDRESS, country: "gb" }, false],
    ["a three-letter country", { ...ADDRESS, country: "GBR" }, false],
    ["two capitals that are no country", { ...ADDRESS, country: "ZZ" }, false],
    ["a country at the end of the list", { ...ADDRESS, country: "ZW" }, true],
    ["an empty line", { ...ADDRESS, line1: "" }, false],
    ["a 121-character line", { ...ADDRESS, line2: "x".repeat(121) }, false],
    ["a JSON null optional line", { ...ADDRESS, line2: null }, false],
    ["a number in a line", { ...ADDRESS, line1: 12 }, false],
    ["an unknown key", { ...ADDRESS, county: "Kent" }, false],
    ["an array", [ADDRESS], false],
    ["a string", "1 High St", false],
  ] as const)("address: %s", async (_, address, ok) => {
    const write = set("postal_address", JSON.stringify(address));
    if (ok) await write; else await expect(write).rejects.toMatchObject({ code: "23514" });
    await set("postal_address", null);
  });
});

describe("time zone (BP-3)", () => {
  const set = (zone: string | null) => fixture.service((tx) =>
    tx.query("UPDATE business_profiles SET time_zone=$1 WHERE tenant_id=$2", [zone, fixture.b.tenantId]));
  const stored = async () => (await profileOf(fixture.b.tenantId)).time_zone;

  it("refuses a name the database does not know, on update and on insert", async () => {
    await expect(set("Mars/Base")).rejects.toMatchObject({ code: "23514", constraint: "business_profiles_time_zone_known" });
    const tenant = randomUUID();
    await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Zone')", [tenant]));
    await expect(fixture.service((tx) => tx.query(
      "UPDATE business_profiles SET time_zone='Foo/Bar' WHERE tenant_id=$1", [tenant]))).rejects.toMatchObject({
      code: "23514", constraint: "business_profiles_time_zone_known" });
    expect(await stored()).toBeNull();
  });

  it("accepts UTC, an IANA name in any case (keeping its spelling) and null", async () => {
    await set("UTC");
    expect(await stored()).toBe("UTC");
    await set("Europe/London");
    expect(await stored()).toBe("Europe/London");
    await set("america/new_york");
    expect(await stored()).toBe("america/new_york");
    await set(null);
    expect(await stored()).toBeNull();
  });
});

describe("tenancy as the runtime role (BP-12, BP-9)", () => {
  it("reads only its own tenant's profile", async () => {
    expect((await asA((tx) => tx.query("SELECT tenant_id FROM business_profiles"))).rows).toEqual([{ tenant_id: fixture.a.tenantId }]);
    expect((await asA((tx) => tx.query("SELECT 1 FROM business_profiles WHERE tenant_id=$1", [fixture.b.tenantId]))).rowCount).toBe(0);
  });

  it("cannot update another tenant's profile: no row is visible to change", async () => {
    const before = await profileOf(fixture.b.tenantId);
    const result = await asA((tx) => tx.query("UPDATE business_profiles SET legal_name='Hijacked', revision=revision+1 WHERE tenant_id=$1", [fixture.b.tenantId]));
    expect(result.rowCount).toBe(0);
    expect(await profileOf(fixture.b.tenantId)).toEqual(before);
    // And it cannot move its own row to the other tenant.
    await expect(asA((tx) => tx.query("UPDATE business_profiles SET tenant_id=$1 WHERE tenant_id=$2", [fixture.b.tenantId, fixture.a.tenantId])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("cannot insert or delete a profile, for itself or another tenant", async () => {
    for (const tenant of [fixture.a.tenantId, fixture.b.tenantId]) {
      await expect(asA((tx) => tx.query("INSERT INTO business_profiles (tenant_id, display_name) VALUES ($1,'Forged')", [tenant])))
        .rejects.toMatchObject({ code: "42501" });
      await expect(asA((tx) => tx.query("DELETE FROM business_profiles WHERE tenant_id=$1", [tenant]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("updates its own editable columns", async () => {
    const updated = await asA((tx) => tx.query(
      `UPDATE business_profiles SET legal_name='Halden & Rowe LLC', phone_e164='+14155550123', time_zone='Europe/London', currency='EUR',
         postal_address=$1::jsonb, revision=revision+1, updated_by=$2, updated_at=now() WHERE tenant_id=$3 RETURNING revision`,
      [JSON.stringify({ line1: "1 High St", city: "London", country: "GB" }), randomUUID(), fixture.a.tenantId]));
    expect(updated.rows).toEqual([{ revision: 2 }]);
    expect(await profileOf(fixture.a.tenantId)).toMatchObject({ legal_name: "Halden & Rowe LLC", currency: "EUR", time_zone: "Europe/London" });
    // Tenant B is untouched.
    expect(await profileOf(fixture.b.tenantId)).toMatchObject({ legal_name: null, currency: "USD", revision: 1 });
  });

  it("renames the tenant with the display name, in the same transaction, for its own tenant only", async () => {
    await asA((tx) => tx.query("UPDATE business_profiles SET display_name='Halden & Rowe Fine Jewelry' WHERE tenant_id=$1", [fixture.a.tenantId]));
    expect(await tenantName(fixture.a.tenantId)).toBe("Halden & Rowe Fine Jewelry");
    expect(await tenantName(fixture.b.tenantId)).toBe("Tenant B");
    // A rolled-back transaction leaves both names alone.
    await expect(asA(async (tx) => {
      await tx.query("UPDATE business_profiles SET display_name='Rolled back' WHERE tenant_id=$1", [fixture.a.tenantId]);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await tenantName(fixture.a.tenantId)).toBe("Halden & Rowe Fine Jewelry");
    expect((await profileOf(fixture.a.tenantId)).display_name).toBe("Halden & Rowe Fine Jewelry");
  });

  it("still cannot rename tenants directly, and the sync trigger gives it no other reach", async () => {
    await expect(asA((tx) => tx.query("UPDATE tenants SET name='forged'"))).rejects.toMatchObject({ code: "42501" });
    expect((await asA((tx) => tx.query("SELECT tenant_id FROM tenants"))).rows).toEqual([{ tenant_id: fixture.a.tenantId }]);
  });

  it("refuses a rename made outside the tenant's context rather than leaving the two names apart", async () => {
    await expect(fixture.service((tx) => tx.query(
      "UPDATE business_profiles SET display_name='Out of context' WHERE tenant_id=$1", [fixture.b.tenantId])))
      .rejects.toMatchObject({ code: "42501" });
    expect((await profileOf(fixture.b.tenantId)).display_name).toBe("Tenant B");
    expect(await tenantName(fixture.b.tenantId)).toBe("Tenant B");
  });

  it("denies a connection with no tenant in context", async () => {
    const client = await database.runtimePool.connect();
    try {
      await client.query("BEGIN");
      expect((await client.query("SELECT 1 FROM business_profiles")).rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
