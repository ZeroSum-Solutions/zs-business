// connections.md C-21 / C-27: the hub half of the native Shopify tier. Failure injection: createHub fails after each
// Supabase Auth step, the worker retries, and the final state is the same as one clean run with no step done twice.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { createShopifyHub } from "../src/connections/shopify-hub.js";
import { createSupabaseAuthAdmin, type SupabaseAuthAdmin } from "../src/supabase-auth-admin.js";
import { tenantIdForKey } from "../src/tenant-create.js";
import { FAKE_REF, FAKE_SERVICE_KEY, fakeGoTrue } from "./fake-gotrue.js";
import { clock } from "./helpers.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); }, 60_000);
afterAll(async () => { await database?.close(); });

type Counted = "findUser" | "createUser" | "setTenantClaim";
/** The real admin client over the fake GoTrue, counting each call and failing exactly the `failAt`-th (1-based) call once. */
function harness(failAt: number | null) {
  const gotrue = fakeGoTrue();
  const real = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
  const calls: Counted[] = [];
  const step = <A extends unknown[], R>(name: Counted, fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    calls.push(name);
    if (calls.length === failAt) throw new Error(`injected failure at call ${calls.length} (${name})`);
    return fn(...args);
  };
  const auth: SupabaseAuthAdmin = {
    ...real,
    findUser: step("findUser", real.findUser.bind(real)),
    createUser: step("createUser", real.createUser.bind(real)),
    setTenantClaim: step("setTenantClaim", real.setTenantClaim.bind(real)),
  };
  const steps: string[] = [];
  const hub = createShopifyHub({ pool: database.servicePool, auth, clock, signInUrl: "https://hub.example.test/auth/confirm", generateId: randomUUID, report: (event) => steps.push(event.step) });
  return { gotrue, calls, hub, steps };
}

const stateOf = (key: string) => asService(database.servicePool, async (tx) => ({
  tenants: (await tx.query("SELECT name FROM tenants WHERE tenant_id=$1", [tenantIdForKey(key)])).rowCount,
  members: (await tx.query<{ email: string; role: string }>("SELECT email, role::text AS role FROM tenant_members WHERE tenant_id=$1", [tenantIdForKey(key)])).rows,
}));

describe("createHub failure injection (C-21, C-27)", () => {
  const input = (key: string) => ({ key, name: "Halden Rowe", ownerEmail: `Owner@${key}.example.test` });

  it("a clean run creates one user, one tenant and one owner; a repeat changes nothing and creates no second user", async () => {
    const key = "shopify-1000";
    const { gotrue, hub, calls } = harness(null);
    expect(await hub.createHub(input(key))).toMatchObject({ kind: "ok", tenantId: tenantIdForKey(key), name: "Halden Rowe" });
    expect(calls.filter((c) => c === "createUser")).toHaveLength(1);
    const before = calls.length;
    expect(await hub.createHub(input(key))).toMatchObject({ kind: "ok", tenantId: tenantIdForKey(key), name: "Halden Rowe" });
    expect(calls.slice(before)).not.toContain("createUser");
    expect([...gotrue.users.values()]).toHaveLength(1);
    expect(await stateOf(key)).toEqual({ tenants: 1, members: [{ email: `owner@${key}.example.test`, role: "owner" }] });
  });

  it("fails after every auth call in turn; the retry ends in the clean state with each step done once", async () => {
    const total = harness(null);
    await total.hub.createHub(input("shopify-2000"));
    const callCount = total.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(4); // find, create user, the tenant create's find, the owner's find, the claim
    for (let failAt = 1; failAt <= callCount; failAt++) {
      const key = `shopify-3${String(failAt).padStart(3, "0")}`;
      const run = harness(failAt);
      const first = await run.hub.createHub(input(key));
      expect(first, `call ${failAt} (${run.calls[failAt - 1]})`).toEqual({ kind: "failed" });
      expect(run.steps).toHaveLength(1);
      expect(await run.hub.createHub(input(key)), `retry after call ${failAt}`).toMatchObject({ kind: "ok", tenantId: tenantIdForKey(key), name: "Halden Rowe" });
      const users = [...run.gotrue.users.values()];
      expect(users, `users after call ${failAt}`).toHaveLength(1);
      // The failed call itself is attempted again; any other createUser must not repeat once the user exists.
      expect(run.calls.filter((c) => c === "createUser"), `createUser after call ${failAt}`).toHaveLength(run.calls[failAt - 1] === "createUser" ? 2 : 1);
      expect(users[0]!.app_metadata.tenant_id, `claim after call ${failAt}`).toBe(tenantIdForKey(key));
      expect(await stateOf(key), `rows after call ${failAt}`).toEqual({ tenants: 1, members: [{ email: `owner@${key}.example.test`, role: "owner" }] });
    }
  });

  it("an email that already belongs to another hub answers email_has_hub and writes nothing", async () => {
    const first = harness(null);
    await first.hub.createHub(input("shopify-4000"));
    const second = harness(null);
    // Same owner email, other store: the user in this project's Auth already holds shopify-4000's claim.
    second.gotrue.addUser("owner@shopify-4000.example.test", { tenant_id: tenantIdForKey("shopify-4000") });
    expect(await second.hub.createHub({ key: "shopify-4001", name: "Other", ownerEmail: "owner@shopify-4000.example.test" })).toEqual({ kind: "email_has_hub" });
    expect(second.calls).not.toContain("createUser");
    expect(await stateOf("shopify-4001")).toEqual({ tenants: 0, members: [] });
  });
});
