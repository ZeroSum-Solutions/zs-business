// The demo adapter's managed-tier connections keep the API's rules (connections.md C-4, C-5, C-13):
// only owners list, connect and disconnect; a shop domain must be a .myshopify.com address; a store
// connects once; and nothing connects until the owner confirms the store the grant names.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionListSchema, connectionSchema, pendingConnectionSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_CONNECTIONS_WORKER_MS, DEMO_MANAGED_GRANT_MS } from "../src/lib/api/demo/managed-connections";

const NOW = new Date("2026-11-06T13:00:00.000Z");
const SHOP = "halden-rowe.myshopify.com";

function adapter() {
  let ids = 0;
  let clock = NOW;
  const api = createDemoAdapter({
    clock: { now: () => clock },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return Object.assign(api, { advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } });
}
type Api = ReturnType<typeof adapter>;

let keys = 0;
const key = () => ({ idempotencyKey: `managed-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const list = async (api: Api) => connectionListSchema.parse({ items: await api.listManagedConnections() }).items;
const confirm = async (api: Api) => api.confirmManagedConnect((await api.getPendingManagedConnect())?.grantId ?? "x".repeat(43));
const connect = async (api: Api, shop = SHOP) => {
  await api.startManagedConnect("shopify", shop);
  return connectionSchema.parse(await confirm(api));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo adapter: managed connections", () => {
  it("starts with none, stages a grant on connect, and connects only on confirm", async () => {
    const api = adapter();
    expect(await list(api)).toEqual([]);
    expect(await api.getPendingManagedConnect()).toBeNull();
    expect(await api.startManagedConnect("shopify", SHOP)).toEqual({ authorizeUrl: "http://127.0.0.1/account/connections?connection=confirm" });
    expect(await list(api)).toEqual([]);
    expect(pendingConnectionSchema.parse(await api.getPendingManagedConnect())).toEqual({
      grantId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), toolkit: "shopify", shopDomain: SHOP, accountLabel: "Halden Rowe",
      expiresAt: new Date(NOW.getTime() + DEMO_MANAGED_GRANT_MS).toISOString(), tokensWithAccess: 0,
    });
    const connected = await confirm(api);
    expect(connectionSchema.parse(connected)).toMatchObject({ toolkit: "shopify", accountDomain: SHOP, accountLabel: "Halden Rowe", status: "active", revokeFailed: false, reauthorizeReason: null });
    expect(await api.getPendingManagedConnect()).toBeNull();
    expect(await list(api)).toEqual([connected]);
  });

  it("names the token count on the confirm screen's data", async () => {
    const api = adapter();
    api.setManagedTokensWithAccess(3);
    await api.startManagedConnect("shopify", SHOP);
    expect((await api.getPendingManagedConnect())?.tokensWithAccess).toBe(3);
  });

  it("refuses a bad address (400), an unknown toolkit (404) and a connected store (409)", async () => {
    const api = adapter();
    for (const bad of ["example.com", "a.myshopify.com.evil.test", "https://a.myshopify.com", "", "-a.myshopify.com"]) {
      expect(await failure(api.startManagedConnect("shopify", bad)), bad).toMatchObject({ kind: "validation" });
    }
    expect(await failure(api.startManagedConnect("gmail", SHOP))).toMatchObject({ kind: "not_found" });
    expect(await failure(api.startManagedConnect("Bad Toolkit", SHOP))).toMatchObject({ kind: "validation" });
    await connect(api);
    expect(await failure(api.startManagedConnect("shopify", SHOP))).toMatchObject({ kind: "conflict", reason: "already_connected" });
    // One live connection per toolkit (C-7): another store of the same toolkit is refused too.
    expect(await failure(api.startManagedConnect("shopify", "other-shop.myshopify.com"))).toMatchObject({ kind: "conflict", reason: "already_connected" });
    expect(await api.getPendingManagedConnect()).toBeNull();
  });

  it("refuses staff on every call (403) and everything when the server has no settings (404)", async () => {
    const api = adapter();
    api.actAs("staff");
    for (const call of [
      () => api.listManagedConnections(),
      () => api.startManagedConnect("shopify", SHOP),
      () => api.getPendingManagedConnect(),
      () => api.disconnectManagedConnection("00000000-0000-4000-8000-000000000099", key()),
    ]) expect(await failure(call())).toMatchObject({ kind: "forbidden" });
    api.actAs("owner");
    api.setManagedConnectionsConfigured(false);
    for (const call of [() => api.listManagedConnections(), () => api.startManagedConnect("shopify", SHOP), () => api.getPendingManagedConnect()])
      expect(await failure(call())).toMatchObject({ kind: "not_found" });
  });

  it("refuses a confirm of a grant the browser has since replaced, and keeps the new one", async () => {
    const api = adapter();
    await api.startManagedConnect("shopify", SHOP);
    const shown = (await api.getPendingManagedConnect())!;
    await api.startManagedConnect("shopify", "other-shop.myshopify.com");
    expect(await failure(api.confirmManagedConnect(shown.grantId))).toMatchObject({ kind: "conflict", reason: "grant_changed" });
    expect((await api.getPendingManagedConnect())?.shopDomain).toBe("other-shop.myshopify.com");
    expect(await list(api)).toEqual([]);
  });

  it("spends the grant on any other answer, expires it after ten minutes, and cancels it", async () => {
    const api = adapter();
    expect(await failure(api.confirmManagedConnect("x".repeat(43)))).toMatchObject({ kind: "not_found" });
    await api.startManagedConnect("shopify", SHOP);
    api.advance(DEMO_MANAGED_GRANT_MS);
    expect(await api.getPendingManagedConnect()).toBeNull();
    expect(await failure(confirm(api))).toMatchObject({ kind: "not_found" });
    await api.startManagedConnect("shopify", SHOP);
    api.expireManagedPendingGrant();
    expect(await api.getPendingManagedConnect()).toBeNull();
    await api.startManagedConnect("shopify", SHOP);
    await expect(api.cancelManagedConnect()).resolves.toEqual({ cancelled: true, revokeFailed: false });
    expect(await api.getPendingManagedConnect()).toBeNull();
    await expect(api.cancelManagedConnect()).resolves.toEqual({ cancelled: false, revokeFailed: false });
    expect(await list(api)).toEqual([]);
    expect(await api.checkManagedConnectStatus()).toEqual({ connection: "error", reason: "expired" });
    await api.startManagedConnect("shopify", SHOP);
    expect(await api.checkManagedConnectStatus()).toEqual({ connection: "confirm" });
  });

  it("reports a failed revoke when a cancel removes the account (C-5)", async () => {
    const api = adapter();
    api.setManagedRevokeFails(true);
    await api.startManagedConnect("shopify", SHOP);
    await expect(api.cancelManagedConnect()).resolves.toEqual({ cancelled: true, revokeFailed: true });
  });

  it("disconnects: disconnecting at once, disconnected after the worker's delay, and a repeat with the key replays", async () => {
    const api = adapter();
    const connected = await connect(api);
    const first = connectionSchema.parse(await api.disconnectManagedConnection(connected.id, { idempotencyKey: "same" }));
    expect(first.status).toBe("disconnecting");
    expect(await api.disconnectManagedConnection(connected.id, { idempotencyKey: "same" })).toEqual(first);
    expect((await list(api))[0]!.status).toBe("disconnecting");
    api.advance(DEMO_CONNECTIONS_WORKER_MS);
    expect((await list(api))[0]).toMatchObject({ status: "disconnected", revokeFailed: false });
    // The store can be connected again once it is retired.
    await expect(api.startManagedConnect("shopify", SHOP)).resolves.toBeDefined();
    expect(await failure(api.disconnectManagedConnection("00000000-0000-4000-8000-000000000099", key()))).toMatchObject({ kind: "not_found" });
  });

  it("clears the label once a store is retired, and keeps only the newest 20 retired rows (C-7, C-13)", async () => {
    const api = adapter();
    const ids: string[] = [];
    for (let n = 0; n < 22; n += 1) {
      const connected = await connect(api, `shop-${n}.myshopify.com`);
      ids.push(connected.id);
      await api.disconnectManagedConnection(connected.id, key());
      api.advance(DEMO_CONNECTIONS_WORKER_MS);
      await list(api);
    }
    const rows = await list(api);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.status === "disconnected" && row.accountLabel === null)).toBe(true);
    // The two oldest are gone.
    expect(rows.map((row) => row.id)).not.toContain(ids[0]);
    expect(rows.map((row) => row.id)).not.toContain(ids[1]);
    expect(rows.map((row) => row.id)).toContain(ids[21]);
    // A live store keeps its label.
    expect((await connect(api, "live-shop.myshopify.com")).accountLabel).toBe("Live Shop");
  });

  it("ends a disconnect with revokeFailed when the provider refuses the revoke (C-13)", async () => {
    const api = adapter();
    api.setManagedRevokeFails(true);
    const connected = await connect(api);
    await api.disconnectManagedConnection(connected.id, key());
    api.advance(DEMO_CONNECTIONS_WORKER_MS);
    expect((await list(api))[0]).toMatchObject({ status: "disconnected", revokeFailed: true });
  });

  it("marks a connection that lost access as reauthorize, which a disconnect still ends", async () => {
    const api = adapter();
    const connected = await connect(api);
    api.loseManagedConnectionAccess(connected.id);
    expect((await list(api))[0]).toMatchObject({ status: "reauthorize", reauthorizeReason: "auth_error" });
    expect(await failure(api.startManagedConnect("shopify", SHOP))).toMatchObject({ kind: "conflict", reason: "already_connected" });
    expect((await api.disconnectManagedConnection(connected.id, key())).status).toBe("disconnecting");
  });
});
