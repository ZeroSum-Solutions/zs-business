import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// public-intake.md P-24 at the database, as the runtime role: an owner may change a booking page's
// title and description and nothing else, only on the tenant's own pages.

let database: TestDatabase;
let fixture: TwoTenantFixture;
const pages = new Map<string, string>();

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  await fixture.service(async (tx) => {
    for (const tenantId of [fixture.a.tenantId, fixture.b.tenantId]) {
      const id = randomUUID();
      pages.set(tenantId, id);
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,created_at) VALUES ($1,$2,'Original',now())", [tenantId, id]);
    }
  });
});
afterAll(async () => { await database?.close(); });

const pageOf = (tenantId: string) => fixture.service(async (tx) =>
  (await tx.query("SELECT title, description, published, disclosure_text, disclosure_version FROM booking_pages WHERE id=$1", [pages.get(tenantId)])).rows[0]);

describe("booking page title and description (P-24)", () => {
  it("starts with no description", async () => {
    expect((await pageOf(fixture.a.tenantId)).description).toBeNull();
  });

  it("lets the runtime role change the title and the description of its own page, and clear the description", async () => {
    const changed = await fixture.a.run((tx) => tx.query(
      "UPDATE booking_pages SET title='Book a visit', description='Pick a time.' WHERE id=$1 RETURNING title, description", [pages.get(fixture.a.tenantId)]));
    expect(changed.rows).toEqual([{ title: "Book a visit", description: "Pick a time." }]);
    await fixture.a.run((tx) => tx.query("UPDATE booking_pages SET description=NULL WHERE id=$1", [pages.get(fixture.a.tenantId)]));
    expect((await pageOf(fixture.a.tenantId)).description).toBeNull();
  });

  it("denies tenant A the page of tenant B: no row is visible to change", async () => {
    const before = await pageOf(fixture.b.tenantId);
    const result = await fixture.a.run((tx) => tx.query(
      "UPDATE booking_pages SET title='Hijacked', description='Hijacked' WHERE id=$1", [pages.get(fixture.b.tenantId)]));
    expect(result.rowCount).toBe(0);
    expect(await pageOf(fixture.b.tenantId)).toEqual(before);
    expect((await fixture.a.run((tx) => tx.query("SELECT 1 FROM booking_pages WHERE id=$1", [pages.get(fixture.b.tenantId)]))).rowCount).toBe(0);
  });

  it("cannot move its page to another tenant", async () => {
    await expect(fixture.a.run((tx) => tx.query("UPDATE booking_pages SET tenant_id=$1 WHERE id=$2", [fixture.b.tenantId, pages.get(fixture.a.tenantId)])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("keeps every other column closed: the disclosure, the creation time and the id", async () => {
    for (const set of ["created_at='2000-01-01'", "disclosure_text='Changed'", "disclosure_version='9999-01'", `id='${randomUUID()}'`]) {
      await expect(fixture.a.run((tx) => tx.query(`UPDATE booking_pages SET ${set} WHERE id=$1`, [pages.get(fixture.a.tenantId)])), set)
        .rejects.toMatchObject({ code: "42501" });
    }
  });

  it("refuses an empty or over-long title and description: the table checks what the contract checks", async () => {
    const attempt = (set: string, value: string) => fixture.a.run((tx) => tx.query(`UPDATE booking_pages SET ${set}=$1 WHERE id=$2`, [value, pages.get(fixture.a.tenantId)]));
    for (const [column, value] of [["title", ""], ["title", "t".repeat(201)], ["description", ""], ["description", "d".repeat(2001)]] as const) {
      await expect(attempt(column, value), `${column} ${value.length}`).rejects.toMatchObject({ code: "23514" });
    }
    await attempt("title", "t".repeat(200));
    await attempt("description", "d".repeat(2000));
  });
});
