// M3d prepaid wallet (delivery.md D-4, D-5, D-8): never negative, concurrent reservations
// cannot overdraw, settlement happens once.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureReservation,
  creditWallet,
  getWallet,
  releaseReservation,
  reserveFunds,
} from "../../src/index.js";
import { createDeliveryHarness, PRICES, type DeliveryHarness } from "./helpers.js";

let h: DeliveryHarness;
let tenant: string;
beforeAll(async () => { h = await createDeliveryHarness(); });
beforeEach(async () => { tenant = await h.tenant(); });
afterEach(async () => { await h.reset(); });
afterAll(async () => { await h?.close(); });

/** A delivery row to hang reservations on. */
async function deliveries(tenantId: string, n: number): Promise<string[]> {
  const contactId = await h.contact(tenantId);
  for (let i = 0; i < n; i += 1) await h.enqueue(tenantId, { contactId });
  await h.worker().ingest();
  return (await h.rows<{ id: string }>("SELECT id FROM message_deliveries WHERE tenant_id=$1 ORDER BY id", [tenantId])).map((row) => row.id);
}

const ledgerSum = async (tenantId: string) =>
  Number((await h.rows<{ sum: string | null }>("SELECT sum(amount)::text AS sum FROM wallet_ledger WHERE tenant_id=$1", [tenantId]))[0]!.sum ?? 0);

describe("credits", () => {
  it("applies a credit once per key, refuses the key with another amount, and keeps the balance equal to the ledger", async () => {
    const now = h.clock.now();
    const first = await h.service((tx) => creditWallet(tx, { tenantId: tenant, ledgerId: randomUUID(), amount: 500, idempotencyKey: "topup-1", now }));
    expect(first).toEqual({ applied: true, wallet: { currency: "usd", balance: 500, reserved: 0, available: 500 } });
    const replay = await h.service((tx) => creditWallet(tx, { tenantId: tenant, ledgerId: randomUUID(), amount: 500, idempotencyKey: "topup-1", now }));
    expect(replay.applied).toBe(false);
    await expect(h.service((tx) => creditWallet(tx, { tenantId: tenant, ledgerId: randomUUID(), amount: 900, idempotencyKey: "topup-1", now })))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "idempotency_conflict" } });
    await expect(h.service((tx) => creditWallet(tx, { tenantId: tenant, ledgerId: randomUUID(), amount: 0, idempotencyKey: "topup-2", now })))
      .rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await h.wallet(tenant)).toEqual({ balance: 500, reserved: 0 });
    expect(await ledgerSum(tenant)).toBe(500);
  });

  it("an empty wallet reads as zero", async () => {
    expect(await h.service((tx) => getWallet(tx, tenant))).toEqual({ currency: "usd", balance: 0, reserved: 0, available: 0 });
  });
});

describe("reservations", () => {
  it("concurrent reservations cannot overdraw: of 25 racing holds of 10 on a balance of 100, exactly 10 win", async () => {
    await h.credit(tenant, 100);
    const ids = await deliveries(tenant, 25);
    const results = await Promise.all(ids.map((deliveryId) => h.service((tx) => reserveFunds(tx, {
      tenantId: tenant, deliveryId, reservationId: randomUUID(), amount: 10, now: h.clock.now(),
    }))));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 100 });
    expect(await h.rows("SELECT 1 FROM wallet_reservations WHERE tenant_id=$1 AND status='held'", [tenant])).toHaveLength(10);
  });

  it("concurrent workers cannot overdraw either: funds for 3 sends, 8 deliveries, 3 workers", async () => {
    await h.credit(tenant, 3 * PRICES.email);
    const contactId = await h.contact(tenant);
    for (let i = 0; i < 8; i += 1) await h.enqueue(tenant, { contactId });
    const workers = [h.worker(), h.worker(), h.worker()];
    await workers[0]!.ingest();
    await Promise.all(workers.map((worker) => worker.runOnce({ claimLimit: 3 })));
    const statuses = await h.rows<{ status: string; last_error: string | null }>(
      "SELECT status, last_error FROM message_deliveries WHERE tenant_id=$1", [tenant]);
    expect(statuses.filter((row) => row.status === "sent")).toHaveLength(3);
    expect(statuses.filter((row) => row.status !== "sent").every((row) => row.last_error === "insufficient_funds")).toBe(true);
    expect(await h.wallet(tenant)).toEqual({ balance: 0, reserved: 0 });
    expect(await ledgerSum(tenant)).toBe(0);
    expect(h.provider.delivered.filter((item) => item.request.tenantId === tenant)).toHaveLength(3);
  });

  it("the table constraints refuse a negative balance or a hold above it, whatever the code does", async () => {
    await h.credit(tenant, 10);
    await expect(h.service((tx) => tx.query("UPDATE wallets SET reserved = 11 WHERE tenant_id=$1", [tenant])))
      .rejects.toMatchObject({ code: "23514", constraint: "wallets_reserved_within_balance" });
    await expect(h.service((tx) => tx.query("UPDATE wallets SET balance = -1 WHERE tenant_id=$1", [tenant])))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("settles a reservation once: a second capture or a release after it changes nothing", async () => {
    await h.credit(tenant, 50);
    const [deliveryId] = await deliveries(tenant, 1);
    const now = h.clock.now();
    const held = await h.service((tx) => reserveFunds(tx, { tenantId: tenant, deliveryId: deliveryId!, reservationId: randomUUID(), amount: 20, now }));
    const capture = () => h.service((tx) => captureReservation(tx, { tenantId: tenant, reservationId: held!.id, ledgerId: randomUUID(), now }));
    const [a, b] = await Promise.all([capture(), capture()]);
    expect([a, b].sort()).toEqual(["already_settled", "captured"]);
    expect(await h.service((tx) => releaseReservation(tx, { tenantId: tenant, reservationId: held!.id, now }))).toBe("already_settled");
    expect(await h.wallet(tenant)).toEqual({ balance: 30, reserved: 0 });
    expect(await h.rows("SELECT amount FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenant])).toEqual([{ amount: "-20" }]);
  });

  it("allows one held reservation per delivery", async () => {
    await h.credit(tenant, 50);
    const [deliveryId] = await deliveries(tenant, 1);
    const hold = () => h.service((tx) => reserveFunds(tx, { tenantId: tenant, deliveryId: deliveryId!, reservationId: randomUUID(), amount: 5, now: h.clock.now() }));
    await hold();
    await expect(hold()).rejects.toMatchObject({ code: "23505", constraint: "wallet_reservations_one_held" });
    expect(await h.wallet(tenant)).toEqual({ balance: 50, reserved: 5 });
  });
});

describe("runtime role (two tenants)", () => {
  it("reads only its own wallet and cannot write money tables or the ledger at all", async () => {
    const other = await h.tenant();
    await h.credit(tenant, 70);
    await h.credit(other, 30);
    const read = (tenantId: string) => h.database.db.tenant(tenantId, async (tx) => (await tx.query("SELECT tenant_id, balance FROM wallets")).rows);
    expect(await read(tenant)).toEqual([{ tenant_id: tenant, balance: "70" }]);
    expect(await read(other)).toEqual([{ tenant_id: other, balance: "30" }]);
    for (const sql of [
      "UPDATE wallets SET balance = balance + 1000",
      "INSERT INTO wallet_ledger (tenant_id,id,kind,amount,idempotency_key,created_at) VALUES ($1,gen_random_uuid(),'credit',1000,'free','2026-10-20T00:00Z')",
      "UPDATE wallet_reservations SET status='released'",
      "UPDATE message_deliveries SET status='pending'",
      "DELETE FROM wallet_ledger",
    ]) {
      await expect(h.database.db.tenant(other, (tx) => tx.query(sql, sql.includes("$1") ? [other] : [])), sql)
        .rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the service role cannot rewrite or delete ledger rows", async () => {
    await h.credit(tenant, 10);
    await expect(h.service((tx) => tx.query("UPDATE wallet_ledger SET amount = 1 WHERE tenant_id=$1", [tenant])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(h.service((tx) => tx.query("DELETE FROM wallet_ledger WHERE tenant_id=$1", [tenant])))
      .rejects.toMatchObject({ code: "42501" });
  });
});
