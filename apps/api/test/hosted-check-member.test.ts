import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { temporaryMember } from "../src/hosted-check-member.js";

/** The pool, except that the first statement matching `fails` runs and then throws, as when its reply is lost. */
function losingReplies(pool: Pool, fails: (text: string) => boolean): Pool {
  let lost = false;
  return new Proxy(pool, {
    get(target, key) {
      if (key !== "connect") return Reflect.get(target, key, target);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, name) {
            if (name !== "query") {
              const value = Reflect.get(inner, name, inner);
              return typeof value === "function" ? value.bind(inner) : value;
            }
            return async (...args: Parameters<PoolClient["query"]>) => {
              const result = await (inner.query as (...a: unknown[]) => Promise<unknown>)(...args);
              if (!lost && typeof args[0] === "string" && fails(args[0])) {
                lost = true;
                throw new Error("Connection terminated unexpectedly");
              }
              return result;
            };
          },
        });
      };
    },
  });
}

describe("check:hosted's temporary member", () => {
  let database: TestDatabase;
  let tenantId: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    tenantId = randomUUID();
    await asService(database.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant A')", [tenantId]));
  });
  afterAll(async () => { await database?.close(); });

  const user = () => ({ email: `zs-check-a-${randomUUID()}@example.com`, userId: randomUUID() });
  const rowCount = async (memberId: string) => (await database.pool.query("SELECT 1 FROM tenant_members WHERE id=$1", [memberId])).rowCount;

  it("adds a staff member and removes it, checking it is gone", async () => {
    const member = temporaryMember(database.servicePool, tenantId, randomUUID);
    await member.add(user());
    expect(await rowCount(member.memberId)).toBe(1);
    expect(await member.remove()).toEqual({ ok: true, detail: { memberId: member.memberId, deleted: true, absent: true, error: null } });
    expect(await rowCount(member.memberId)).toBe(0);
  });

  it("still removes the row when the insert committed but its COMMIT reply was lost", async () => {
    const lossy = losingReplies(database.servicePool, (text) => text === "COMMIT");
    const member = temporaryMember(lossy, tenantId, randomUUID);
    await expect(member.add(user())).rejects.toThrow(/Connection terminated/);
    expect(await rowCount(member.memberId)).toBe(1);
    // The insert threw, yet cleanup knows the id and finds and removes the row.
    expect(await member.remove()).toEqual({ ok: true, detail: { memberId: member.memberId, deleted: true, absent: true, error: null } });
    expect(await rowCount(member.memberId)).toBe(0);
  });

  it("reports a failure when the delete did not land and the row is still there", async () => {
    const member = temporaryMember(losingReplies(database.servicePool, (text) => text.startsWith("DELETE FROM tenant_members")), tenantId, randomUUID);
    await member.add(user());
    const removal = await member.remove();
    // The DELETE ran but its transaction never committed, so the row stays.
    expect(removal).toMatchObject({ ok: false, detail: { deleted: false, absent: false, error: "Connection terminated unexpectedly" } });
    expect(await rowCount(member.memberId)).toBe(1);
    await asService(database.servicePool, (tx) => tx.query("DELETE FROM tenant_members WHERE id=$1", [member.memberId]));
  });

  it("passes when the insert never landed, and does nothing before any add", async () => {
    const member = temporaryMember(database.servicePool, randomUUID(), randomUUID);
    expect(await member.remove()).toBeNull();
    // No such tenant: the foreign key refuses the insert.
    await expect(member.add(user())).rejects.toThrow();
    expect(await member.remove()).toMatchObject({ ok: true, detail: { deleted: false, absent: true, error: null } });
  });
});
