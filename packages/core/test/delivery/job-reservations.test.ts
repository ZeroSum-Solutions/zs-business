// Wallet reservations for any priced job (delivery.md D-11, revision 5): a hold names a job by
// kind and id; the D-4 and D-5 guarantees hold for every kind.
import { randomUUID } from "node:crypto";
import { WALLET_JOB_KINDS } from "@zs/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_REGISTRY,
  captureReservation,
  findStaleHolds,
  getWallet,
  heldReservationForJob,
  jobRowLock,
  releaseReservation,
  reserveForJob,
  reserveFunds,
  type JobRegistry,
} from "../../src/index.js";
import { createDeliveryHarness, type DeliveryHarness } from "./helpers.js";

let h: DeliveryHarness;
let tenant: string;
/** No other kind has a job table yet: the tests stand one in for `enrichment` and `image_job`. */
let registry: JobRegistry;
beforeAll(async () => {
  h = await createDeliveryHarness();
  await h.database.pool.query(`
    CREATE TABLE public.test_priced_jobs (
      tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id), id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
    GRANT SELECT, INSERT, UPDATE ON public.test_priced_jobs TO service_role;
    CREATE TABLE public.test_other_jobs (
      tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id), id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
    GRANT SELECT, INSERT, UPDATE ON public.test_other_jobs TO service_role;`);
  registry = {
    ...DEFAULT_JOB_REGISTRY,
    enrichment: jobRowLock("test_priced_jobs"),
    image_job: jobRowLock("test_other_jobs"),
  };
});
beforeEach(async () => { tenant = await h.tenant(); });
afterEach(async () => { await h.reset(); });
afterAll(async () => { await h?.close(); });

/** `n` job rows in a test job table. */
async function jobs(tenantId: string, n: number, table = "test_priced_jobs"): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const id of ids) await h.service((tx) => tx.query(`INSERT INTO ${table} (tenant_id, id) VALUES ($1,$2)`, [tenantId, id]));
  return ids;
}
async function deliveries(tenantId: string, n: number): Promise<string[]> {
  const contactId = await h.contact(tenantId);
  for (let i = 0; i < n; i += 1) await h.enqueue(tenantId, { contactId });
  await h.worker().ingest();
  return (await h.rows<{ id: string }>("SELECT id FROM message_deliveries WHERE tenant_id=$1 ORDER BY id", [tenantId])).map((row) => row.id);
}
const reserve = (tenantId: string, jobKind: Parameters<typeof reserveForJob>[1]["jobKind"], jobId: string, amount: number, now = h.clock.now()) =>
  h.service((tx) => reserveForJob(tx, { tenantId, jobKind, jobId, reservationId: randomUUID(), amount, currency: "usd", now }, registry));
const ledger = (tenantId: string) =>
  h.rows<{ amount: string; idempotency_key: string; reservation_id: string }>(
    "SELECT amount, idempotency_key, reservation_id FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantId]);

describe("reserve before the vendor call (D-11, D-5)", () => {
  it("holds funds for a job of any registered kind and records its kind and id", async () => {
    await h.credit(tenant, 100);
    const [jobId] = await jobs(tenant, 1);
    const held = await reserve(tenant, "enrichment", jobId!, 30);
    expect(held).toMatchObject({ amount: 30 });
    expect(await h.rows("SELECT job_kind, job_id, delivery_id, amount, status FROM wallet_reservations WHERE tenant_id=$1", [tenant]))
      .toEqual([{ job_kind: "enrichment", job_id: jobId, delivery_id: null, amount: "30", status: "held" }]);
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 30 });
    expect(await h.service((tx) => heldReservationForJob(tx, tenant, "enrichment", jobId!))).toEqual(held);
    expect(await h.service((tx) => heldReservationForJob(tx, tenant, "image_job", jobId!))).toBeNull();
  });

  it("returns null without funds, in another currency, or with money owed, and changes nothing", async () => {
    await h.credit(tenant, 10);
    const [jobId] = await jobs(tenant, 1);
    expect(await reserve(tenant, "enrichment", jobId!, 11)).toBeNull();
    expect(await h.service((tx) => reserveForJob(tx, {
      tenantId: tenant, jobKind: "enrichment", jobId: jobId!, reservationId: randomUUID(), amount: 5, currency: "eur", now: h.clock.now(),
    }, registry))).toBeNull();
    await h.service((tx) => tx.query("UPDATE wallets SET owed = 1 WHERE tenant_id=$1", [tenant]));
    expect(await reserve(tenant, "enrichment", jobId!, 5)).toBeNull();
    expect(await h.rows("SELECT 1 FROM wallet_reservations WHERE tenant_id=$1", [tenant])).toHaveLength(0);
    expect(await h.wallet(tenant)).toEqual({ balance: 10, reserved: 0 });
  });

  it("concurrent reservations for different kinds can never overdraw: 30 racing holds of 10 on 100, exactly 10 win", async () => {
    await h.credit(tenant, 100);
    const [messages, enrichments, images] = [await deliveries(tenant, 10), await jobs(tenant, 10), await jobs(tenant, 10, "test_other_jobs")];
    const results = await Promise.all([
      ...messages.map((id) => reserve(tenant, "message_delivery", id, 10)),
      ...enrichments.map((id) => reserve(tenant, "enrichment", id, 10)),
      ...images.map((id) => reserve(tenant, "image_job", id, 10)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 100 });
    expect(await h.rows("SELECT 1 FROM wallet_reservations WHERE tenant_id=$1 AND status='held'", [tenant])).toHaveLength(10);
  });

  it("refuses a second hold for the same job, and lets the same id be held under another kind", async () => {
    await h.credit(tenant, 100);
    const [jobId] = await jobs(tenant, 1);
    await h.service((tx) => tx.query("INSERT INTO test_other_jobs (tenant_id, id) VALUES ($1,$2)", [tenant, jobId]));
    await reserve(tenant, "enrichment", jobId!, 5);
    await expect(reserve(tenant, "enrichment", jobId!, 5)).rejects.toMatchObject({ code: "23505", constraint: "wallet_reservations_one_held" });
    expect(await reserve(tenant, "image_job", jobId!, 5)).toMatchObject({ amount: 5 });
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 10 });
  });

  it("refuses job_not_found for a job row that is absent or belongs to another tenant, before touching the wallet", async () => {
    await h.credit(tenant, 100);
    const other = await h.tenant();
    const [theirs] = await jobs(other, 1);
    const [delivery] = await deliveries(other, 1);
    for (const [kind, id] of [["enrichment", randomUUID()], ["enrichment", theirs!], ["message_delivery", delivery!]] as const)
      await expect(reserve(tenant, kind, id, 5), `${kind} ${id}`).rejects.toMatchObject({ code: "Conflict", details: { reason: "job_not_found" } });
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 0 });
  });

  it("refuses a kind with no registered job table, and a kind the contract does not list", async () => {
    await h.credit(tenant, 100);
    for (const kind of ["voice_minutes", "browser_run"] as const)
      await expect(h.service((tx) => reserveForJob(tx, {
        tenantId: tenant, jobKind: kind, jobId: randomUUID(), reservationId: randomUUID(), amount: 5, currency: "usd", now: h.clock.now(),
      })), kind).rejects.toMatchObject({ code: "Conflict", details: { reason: "job_kind_unavailable" } });
    await expect(h.service((tx) => reserveForJob(tx, {
      tenantId: tenant, jobKind: "sms_burst" as never, jobId: randomUUID(), reservationId: randomUUID(), amount: 5, currency: "usd", now: h.clock.now(),
    }))).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(reserve(tenant, "enrichment", randomUUID(), 0)).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 0 });
  });

  it("reserveFunds keeps the D-5 behaviour for a delivery by reserving as kind message_delivery", async () => {
    await h.credit(tenant, 50);
    const [deliveryId] = await deliveries(tenant, 1);
    const held = await h.service((tx) => reserveFunds(tx, { tenantId: tenant, deliveryId: deliveryId!, reservationId: randomUUID(), amount: 7, now: h.clock.now() }));
    expect(held).toMatchObject({ amount: 7 });
    expect(await h.rows("SELECT job_kind, job_id, delivery_id FROM wallet_reservations WHERE tenant_id=$1", [tenant]))
      .toEqual([{ job_kind: "message_delivery", job_id: deliveryId, delivery_id: deliveryId }]);
    await expect(h.service((tx) => reserveFunds(tx, { tenantId: tenant, deliveryId: randomUUID(), reservationId: randomUUID(), amount: 1, now: h.clock.now() })))
      .rejects.toMatchObject({ details: { reason: "job_not_found" } });
  });
});

describe("capture the real cost, release the rest (D-11)", () => {
  async function held(amount: number) {
    await h.credit(tenant, 100);
    const [jobId] = await jobs(tenant, 1);
    return { jobId: jobId!, hold: (await reserve(tenant, "enrichment", jobId!, amount))! };
  }
  const capture = (reservationId: string, amount?: number) => h.service((tx) =>
    captureReservation(tx, { tenantId: tenant, reservationId, ledgerId: randomUUID(), now: h.clock.now(), ...(amount === undefined ? {} : { amount }) }));

  it("a partial capture takes that amount, returns the rest to available in the same transaction and writes one keyed ledger row", async () => {
    const { hold } = await held(40);
    expect(await capture(hold.id, 25)).toBe("captured");
    expect(await h.wallet(tenant)).toEqual({ balance: 75, reserved: 0 });
    expect(await h.service((tx) => getWallet(tx, tenant))).toMatchObject({ available: 75 });
    expect(await ledger(tenant)).toEqual([{ amount: "-25", idempotency_key: `capture:${hold.id}`, reservation_id: hold.id }]);
    expect(await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND id=$2", [tenant, hold.id])).toEqual([{ status: "captured" }]);
    // A second capture or a release changes nothing.
    expect(await capture(hold.id, 25)).toBe("already_settled");
    expect(await h.service((tx) => releaseReservation(tx, { tenantId: tenant, reservationId: hold.id, now: h.clock.now() }))).toBe("already_settled");
    expect(await h.wallet(tenant)).toEqual({ balance: 75, reserved: 0 });
  });

  it("captures the whole hold when no amount is given, or the whole amount is named", async () => {
    const { hold } = await held(40);
    expect(await capture(hold.id)).toBe("captured");
    expect(await h.wallet(tenant)).toEqual({ balance: 60, reserved: 0 });
    const [second] = await jobs(tenant, 1);
    const again = (await reserve(tenant, "enrichment", second!, 10))!;
    expect(await capture(again.id, 10)).toBe("captured");
    expect(await h.wallet(tenant)).toEqual({ balance: 50, reserved: 0 });
  });

  it("refuses a capture above the hold (capture_exceeds_hold) and changes nothing", async () => {
    const { hold } = await held(40);
    await expect(capture(hold.id, 41)).rejects.toMatchObject({ code: "Conflict", details: { reason: "capture_exceeds_hold" } });
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 40 });
    expect(await ledger(tenant)).toEqual([]);
    expect(await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND id=$2", [tenant, hold.id])).toEqual([{ status: "held" }]);
    // The hold is still good for a capture within it.
    expect(await capture(hold.id, 40)).toBe("captured");
  });

  it("refuses an amount that is not a positive whole number", async () => {
    const { hold } = await held(40);
    for (const amount of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      await expect(capture(hold.id, amount), String(amount)).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 40 });
  });

  it("two racing partial captures settle once", async () => {
    const { hold } = await held(40);
    const results = await Promise.all([capture(hold.id, 10), capture(hold.id, 30)]);
    expect([...results].sort()).toEqual(["already_settled", "captured"]);
    const [row] = await ledger(tenant);
    expect(await h.wallet(tenant)).toEqual({ balance: 100 + Number(row!.amount), reserved: 0 });
  });

  it("a definite failure releases the whole hold", async () => {
    const { hold, jobId } = await held(40);
    expect(await h.service((tx) => releaseReservation(tx, { tenantId: tenant, reservationId: hold.id, now: h.clock.now() }))).toBe("released");
    expect(await h.wallet(tenant)).toEqual({ balance: 100, reserved: 0 });
    expect(await h.service((tx) => heldReservationForJob(tx, tenant, "enrichment", jobId))).toBeNull();
    // The job may hold again after a release, and be captured once.
    const second = (await reserve(tenant, "enrichment", jobId, 5))!;
    expect(await capture(second.id, 5)).toBe("captured");
    const third = (await reserve(tenant, "enrichment", jobId, 5))!;
    await expect(capture(third.id)).rejects.toMatchObject({ code: "23505", constraint: "wallet_reservations_one_capture" });
  });
});

describe("stale holds (D-11)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("reports a held reservation older than 24 hours by the injected clock, with tenant, kind and job, and settles nothing", async () => {
    const other = await h.tenant();
    await h.credit(tenant, 100);
    await h.credit(other, 100);
    const [oldJob, newJob, capturedJob, releasedJob] = await jobs(tenant, 4);
    const [otherJob] = await jobs(other, 1);
    const [delivery] = await deliveries(tenant, 1);
    const t0 = h.clock.now();
    const old = (await reserve(tenant, "enrichment", oldJob!, 5, t0))!;
    const msg = (await reserve(tenant, "message_delivery", delivery!, 3, t0))!;
    const theirs = (await reserve(other, "enrichment", otherJob!, 4, new Date(t0.getTime() - 1000)))!;
    const fresh = (await reserve(tenant, "enrichment", newJob!, 6, new Date(t0.getTime() + 2 * 60 * 60 * 1000)))!;
    const done = (await reserve(tenant, "enrichment", capturedJob!, 2, t0))!;
    const gone = (await reserve(tenant, "enrichment", releasedJob!, 2, t0))!;
    await h.service((tx) => captureReservation(tx, { tenantId: tenant, reservationId: done.id, ledgerId: randomUUID(), now: t0 }));
    await h.service((tx) => releaseReservation(tx, { tenantId: tenant, reservationId: gone.id, now: t0 }));
    // The sweep reads every tenant, and earlier tests in this file left holds of their own.
    const sweep = async (at: number) => (await h.service((tx) => findStaleHolds(tx, { now: new Date(at) })))
      .filter((stale) => stale.tenantId === tenant || stale.tenantId === other);
    const walletBefore = await h.wallet(tenant);

    // Exactly 24 hours is not older than 24 hours; one tick more is (the other tenant's hold is 1 s older).
    expect(await sweep(t0.getTime() + DAY - 1000)).toEqual([]);
    expect((await sweep(t0.getTime() + DAY)).map((s) => s.reservationId)).toEqual([theirs.id]);
    const report = await sweep(t0.getTime() + DAY + 1);
    expect(report).toEqual(expect.arrayContaining([
      { code: "stale_hold", tenantId: other, jobKind: "enrichment", jobId: otherJob, reservationId: theirs.id, amount: 4, heldSince: new Date(t0.getTime() - 1000) },
      { code: "stale_hold", tenantId: tenant, jobKind: "enrichment", jobId: oldJob, reservationId: old.id, amount: 5, heldSince: t0 },
      { code: "stale_hold", tenantId: tenant, jobKind: "message_delivery", jobId: delivery, reservationId: msg.id, amount: 3, heldSince: t0 },
    ]));
    expect(report).toHaveLength(3);
    expect(report.map((s) => s.reservationId)).not.toContain(fresh.id);
    // Reporting is all it does: nothing is captured or released.
    expect(await h.wallet(tenant)).toEqual(walletBefore);
    expect(await h.rows("SELECT status FROM wallet_reservations WHERE tenant_id=$1 AND id = ANY($2) ORDER BY status", [tenant, [old.id, msg.id]]))
      .toEqual([{ status: "held" }, { status: "held" }]);
    expect(await h.rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenant])).toHaveLength(1);
  });

  it("lists the oldest first and honours a limit", async () => {
    await h.credit(tenant, 100);
    const ids = await jobs(tenant, 3);
    // Older than any hold another test made, so these three lead the cross-tenant list.
    const t0 = h.clock.now().getTime() - 400 * DAY;
    await reserve(tenant, "enrichment", ids[0]!, 1, new Date(t0 + 2000));
    await reserve(tenant, "enrichment", ids[1]!, 1, new Date(t0));
    await reserve(tenant, "enrichment", ids[2]!, 1, new Date(t0 + 1000));
    const report = await h.service((tx) => findStaleHolds(tx, { now: h.clock.now(), limit: 2 }));
    expect(report.map((s) => s.jobId)).toEqual([ids[1], ids[2]]);
    // The next page starts after the last report, so a list longer than any limit can be read whole.
    const next = await h.service((tx) => findStaleHolds(tx, { now: h.clock.now(), limit: 1, after: report[1]! }));
    expect(next.map((s) => s.jobId)).toEqual([ids[0]]);
  });
});

describe("runtime role (two tenants, new columns)", () => {
  it("a tenant reads its own job_kind and job_id and nothing of the other's, and cannot write them", async () => {
    const other = await h.tenant();
    await h.credit(tenant, 50);
    await h.credit(other, 50);
    const [mine] = await jobs(tenant, 1);
    const [theirs] = await jobs(other, 1);
    await reserve(tenant, "enrichment", mine!, 5);
    await reserve(other, "enrichment", theirs!, 6);
    const read = (tenantId: string, sql = "SELECT tenant_id, job_kind, job_id, delivery_id FROM wallet_reservations") =>
      h.database.db.tenant(tenantId, async (tx) => (await tx.query(sql)).rows);
    expect(await read(tenant)).toEqual([{ tenant_id: tenant, job_kind: "enrichment", job_id: mine, delivery_id: null }]);
    expect(await read(other)).toEqual([{ tenant_id: other, job_kind: "enrichment", job_id: theirs, delivery_id: null }]);
    expect(await read(tenant, `SELECT 1 FROM wallet_reservations WHERE job_id='${theirs}'`)).toEqual([]);
    for (const sql of [
      "UPDATE wallet_reservations SET job_kind='image_job'",
      "UPDATE wallet_reservations SET job_id=gen_random_uuid()",
      `INSERT INTO wallet_reservations (tenant_id,id,job_kind,job_id,amount,created_at) VALUES ('${other}',gen_random_uuid(),'enrichment',gen_random_uuid(),1,'2026-10-23T00:00Z')`,
      "DELETE FROM wallet_reservations",
    ])
      await expect(h.database.db.tenant(tenant, (tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the table's own checks (D-11 migration)", () => {
  it("lists the same kinds in SQL as the contract does", async () => {
    const [row] = await h.rows<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='wallet_reservations_job_kind'");
    expect([...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]!).sort()).toEqual([...WALLET_JOB_KINDS].sort());
  });

  const insert = (jobKind: string | null, jobId: string | null, deliveryId: string | null) => h.service((tx) => tx.query(
    `INSERT INTO wallet_reservations (tenant_id,id,job_kind,job_id,delivery_id,amount,created_at) VALUES ($1,$2,$3,$4,$5,1,$6)`,
    [tenant, randomUUID(), jobKind, jobId, deliveryId, h.clock.now()]));

  it("keeps delivery_id set and equal to job_id exactly when the kind is message_delivery", async () => {
    const [deliveryId] = await deliveries(tenant, 1);
    const id = randomUUID();
    await expect(insert("enrichment", id, deliveryId!)).rejects.toMatchObject({ code: "23514", constraint: "wallet_reservations_job_delivery" });
    await expect(insert("enrichment", deliveryId!, deliveryId!)).rejects.toMatchObject({ code: "23514", constraint: "wallet_reservations_job_delivery" });
    await expect(insert("message_delivery", deliveryId!, null)).rejects.toMatchObject({ code: "23514", constraint: "wallet_reservations_job_delivery" });
    await expect(insert("message_delivery", id, deliveryId!)).rejects.toMatchObject({ code: "23514", constraint: "wallet_reservations_job_delivery" });
    await expect(insert("message_delivery", deliveryId!, deliveryId!)).resolves.toBeDefined();
    await expect(insert("enrichment", id, null)).resolves.toBeDefined();
  });

  it("checks the kind against the list, requires both columns, and keeps the delivery foreign key", async () => {
    await expect(insert("sms_burst", randomUUID(), null)).rejects.toMatchObject({ code: "23514", constraint: "wallet_reservations_job_kind" });
    await expect(insert(null, randomUUID(), null)).rejects.toMatchObject({ code: "23502" });
    await expect(insert("enrichment", null, null)).rejects.toMatchObject({ code: "23502" });
    const missing = randomUUID();
    await expect(insert("message_delivery", missing, missing)).rejects.toMatchObject({ code: "23503" });
  });
});
