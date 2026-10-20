// activepieces.md W-3..W-8, W-14: business events reach a fake Activepieces catch-webhook,
// signed, at least once under a stable webhook-id, with leases, retries and dead letters.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webhookSigningSecret, type WebhookTransport } from "../../src/index.js";
import { startFakeActivepieces, type FakeActivepieces } from "./fake-activepieces.js";
import { createAutomationHarness, KEY, OTHER_KEY, type AutomationHarness, type Tenant } from "./helpers.js";

let h: AutomationHarness;
let ap: FakeActivepieces;
beforeAll(async () => {
  h = await createAutomationHarness();
  ap = await startFakeActivepieces(h.clock);
});
afterAll(async () => {
  await ap?.close();
  await h?.close();
});

// Each test starts with no endpoints, three hours after the last test began, so a new
// endpoint's scan window holds only its own test's events and the endpoint cap never trips.
// The reset runs as the test cluster's admin: the service role cannot delete these rows.
beforeEach(async () => {
  h.clock.advance(3 * 3_600_000);
  await h.database.pool.query(
    "TRUNCATE webhook_delivery_attempts, webhook_deliveries, webhook_ingest_marks, webhook_endpoints");
});

/** An enabled endpoint on a fresh flow, its signing secret pasted into the flow. */
async function subscribe(tenant: Tenant, events: string[]) {
  const flowId = randomUUID().replaceAll("-", "");
  const created = await h.admin(tenant).createEndpoint({ url: ap.flow(flowId, { current: "whsec_" + "A".repeat(43) + "=" }), events }, randomUUID());
  ap.setSecrets(flowId, { current: created.signingSecret });
  return { flowId, endpoint: created.endpoint, secret: created.signingSecret };
}

const drain = async (worker = h.worker(), passes = 3) => {
  const results = [];
  for (let i = 0; i < passes; i += 1) results.push(await worker.runOnce());
  return results;
};
const deliveries = (endpointId: string) => h.rows<{ id: string; status: string; attempts: number; final_reason: string | null; event_type: string }>(
  "SELECT id, status, attempts, final_reason, event_type::text AS event_type FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at, event_type",
  [endpointId]);

describe("business events (W-3, W-4)", () => {
  it("turns a website request into lead, booking and message events, signed and verified by the flow", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["lead.created", "booking.created", "message.received"]);
    h.clock.advance(1_000);
    const email = `lead-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const { bookingId } = await h.websiteRequest(h.a, { email, notes: "Can you also look at the gutters?" });
    await drain();
    const events = ap.events(flowId);
    expect(events.map((event) => event.type).sort()).toEqual(["booking.created", "lead.created", "message.received"]);
    const lead = events.find((event) => event.type === "lead.created")!;
    expect(lead.body).toMatchObject({ tenantId: h.a.tenantId, type: "lead.created", data: { email, name: "Rowan Halden", bookingId } });
    expect(lead.webhookId).toBe(lead.body.id);
    expect(events.find((event) => event.type === "message.received")!.body.data).toMatchObject({ body: "Can you also look at the gutters?" });
    expect(events.find((event) => event.type === "booking.created")!.body.data).toMatchObject({ bookingId, source: "website" });
    expect((await deliveries(endpoint.id)).every((row) => row.status === "delivered")).toBe(true);
    expect(ap.unsigned).toHaveLength(0);
  });

  it("sends only the events an endpoint subscribes to, and nothing from before it existed", async () => {
    const early = await h.websiteRequest(h.a);
    h.clock.advance(1_000);
    const { flowId } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    const late = await h.websiteRequest(h.a);
    await drain();
    const ids = ap.events(flowId).map((event) => event.body.data.bookingId);
    expect(ap.events(flowId).map((event) => event.type)).toEqual(["booking.created"]);
    expect(ids).toEqual([late.bookingId]);
    expect(ids).not.toContain(early.bookingId);
  });

  it("sends deal.won when a deal enters a won stage, once, and not for moves between won stages", async () => {
    const { flowId } = await subscribe(h.a, ["deal.won"]);
    h.clock.advance(1_000);
    const session = h.session(h.a);
    const contact = await session.upsertContact({ email: `won-${randomUUID().slice(0, 8)}@haldenrowe.example` }, randomUUID());
    const deal = await session.createDeal({ contactId: contact.result.contact.id, pipelineId: h.a.pipelineId, stageId: h.a.openStage, title: "Roof" }, randomUUID());
    await drain();
    expect(ap.events(flowId)).toHaveLength(0);
    h.clock.advance(1_000);
    const won = await session.moveDealStage(deal.result.id, { pipelineId: h.a.pipelineId, stageId: h.a.wonStage, expectedRevision: 1 }, randomUUID());
    // A second won stage: moving between them is not a new win.
    const otherWon = randomUUID();
    await h.service((tx) => tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,'Won again',2,'won')",
      [h.a.tenantId, otherWon, h.a.pipelineId]));
    h.clock.advance(1_000);
    await session.moveDealStage(deal.result.id, { pipelineId: h.a.pipelineId, stageId: otherWon, expectedRevision: 2 }, randomUUID());
    await drain();
    expect(ap.events(flowId).map((event) => event.body.data)).toEqual([expect.objectContaining({
      dealId: deal.result.id, stageId: h.a.wonStage, title: "Roof", wonAt: won.result.updatedAt,
    })]);
  });

  it("keeps tenants apart: an endpoint never receives another tenant's events", async () => {
    const { flowId } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.b);
    await drain();
    expect(ap.events(flowId)).toHaveLength(0);
    expect(await h.fixture.b.run(async (tx) =>
      (await tx.query("SELECT 1 FROM webhook_deliveries WHERE tenant_id=$1", [h.a.tenantId])).rowCount)).toBe(0);
  });
});

describe("delivery semantics (W-7, W-8)", () => {
  it("retries a failing receiver with backoff under the same webhook-id and body, then delivers once", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    ap.queue(flowId, { respond: 500 }, "drop");
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    const worker = h.worker();
    const first = await worker.runOnce();
    expect(first.results).toEqual([expect.objectContaining({ outcome: "retry", reason: "http_500" })]);
    expect((await worker.runOnce()).claimed).toBe(0);
    h.clock.advance(1_000);
    expect((await worker.runOnce()).results).toEqual([expect.objectContaining({ outcome: "retry" })]);
    h.clock.advance(2_000);
    expect((await worker.runOnce()).results).toEqual([expect.objectContaining({ outcome: "delivered", status: 200 })]);
    const requests = ap.received.filter((request) => request.flowId === flowId);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.headers["webhook-id"])).size).toBe(1);
    expect(new Set(requests.map((request) => request.raw)).size).toBe(1);
    expect(ap.events(flowId)).toHaveLength(1);
    const attempts = await h.rows("SELECT outcome, status_code FROM webhook_delivery_attempts WHERE delivery_id=$1 ORDER BY attempt",
      [(await deliveries(endpoint.id))[0]!.id]);
    expect(attempts.map((row) => row.outcome)).toEqual(["failed", "failed", "delivered"]);
  });

  it("dead-letters after the attempt cap or a 410, and an owner replays a dead letter under the same ID", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    ap.queue(flowId, { respond: 503 }, { respond: 503 }, { respond: 503 });
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    const worker = h.worker();
    for (let i = 0; i < 4; i += 1) {
      await worker.runOnce();
      h.clock.advance(60_000);
    }
    const [dead] = await deliveries(endpoint.id);
    expect(dead).toMatchObject({ status: "dead", final_reason: "max_attempts", attempts: 3 });
    // Replaying anything but a dead letter is refused.
    const replayed = await h.admin(h.a).replayDelivery(dead!.id, {}, randomUUID());
    expect(replayed).toMatchObject({ status: "pending", attempts: 0, finalReason: null });
    expect(await h.admin(h.a).replayDelivery(dead!.id, {}, randomUUID()).catch((error) => error.details?.reason)).toBe("not_dead_letter");
    await worker.runOnce();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({ status: "delivered" });
    const ids = ap.received.filter((request) => request.flowId === flowId).map((request) => request.headers["webhook-id"]);
    expect(new Set(ids).size).toBe(1);
    expect(ids).toHaveLength(4);
    // Staff cannot replay (W-14 needs `integrations`).
    expect(await h.admin(h.a, h.a.staffId).replayDelivery(dead!.id, {}, randomUUID()).catch((error) => error.code)).toBe("TenantDenied");

    const gone = await subscribe(h.a, ["booking.created"]);
    ap.queue(gone.flowId, { respond: 410 });
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    await worker.runOnce();
    expect((await deliveries(gone.endpoint.id))[0]).toMatchObject({ status: "dead", final_reason: "endpoint_gone", attempts: 1 });
  });

  it("does not follow a redirect: a 3xx is a failed attempt", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    ap.queue(flowId, { redirect: "http://169.254.169.254/latest/meta-data" });
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    expect((await h.worker().runOnce()).results).toEqual([expect.objectContaining({ outcome: "retry", reason: "http_307" })]);
    expect((await deliveries(endpoint.id))[0]).toMatchObject({ status: "pending" });
  });

  it("two workers never send one delivery twice, and a crashed holder's attempt is retried after its lease", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    for (let i = 0; i < 4; i += 1) await h.websiteRequest(h.a);
    const [one, two] = [h.worker(), h.worker()];
    await one.ingest();
    const [x, y] = await Promise.all([one.claim(10), two.claim(10)]);
    expect(x.length + y.length).toBe(4);
    expect(new Set([...x, ...y].map((claim) => claim.deliveryId)).size).toBe(4);
    await Promise.all([...x.map((claim) => one.step(claim)), ...y.map((claim) => two.step(claim))]);
    expect(ap.received.filter((request) => request.flowId === flowId)).toHaveLength(4);

    // A holder that dies mid-send: its attempt stays open until another worker's lease takes over.
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    const crashed = h.worker();
    await crashed.ingest();
    const [lease] = await crashed.claim(1);
    const hanging: WebhookTransport = { post: () => new Promise(() => undefined) };
    void h.worker({}, { transport: hanging }).step(lease!).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await h.worker().claim(5))).toHaveLength(0);
    h.clock.advance(31_000);
    const rescuer = h.worker();
    const results = await rescuer.runOnce();
    expect(results.results).toEqual([expect.objectContaining({ outcome: "delivered" })]);
    const row = (await deliveries(endpoint.id)).find((delivery) => delivery.id === lease!.deliveryId)!;
    expect(await h.rows("SELECT outcome FROM webhook_delivery_attempts WHERE delivery_id=$1 ORDER BY attempt", [row.id]))
      .toEqual([{ outcome: "lost" }, { outcome: "delivered" }]);
  });

  it("stops at once for a disabled endpoint, and a URL changed to a private address is refused", async () => {
    const { endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    const worker = h.worker();
    await worker.ingest();
    await h.admin(h.a).updateEndpoint(endpoint.id, { enabled: false, expectedRevision: 1 }, randomUUID());
    await worker.runOnce();
    expect((await deliveries(endpoint.id))[0]).toMatchObject({ status: "dead", final_reason: "endpoint_disabled" });

    const second = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    await worker.ingest();
    // Stored before the edge policy existed, say: the worker re-checks every URL it sends to.
    await h.database.pool.query("UPDATE webhook_endpoints SET url='https://10.0.0.5/hook' WHERE tenant_id=$1 AND id=$2",
      [h.a.tenantId, second.endpoint.id]);
    await worker.runOnce();
    expect((await deliveries(second.endpoint.id))[0]).toMatchObject({ status: "dead", final_reason: "url_refused" });
  });

  it("finds an event whose transaction committed after a later one was ingested (W-7 lookback)", async () => {
    const { flowId } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(5_000);
    await h.websiteRequest(h.a);
    // An event stamped earlier than what the worker already read, as a slow transaction commits late.
    await drain();
    expect(ap.events(flowId)).toHaveLength(1);
    h.clock.advance(-3_000);
    const late = await h.websiteRequest(h.a);
    h.clock.advance(10_000);
    await drain();
    expect(ap.events(flowId).map((event) => event.body.data.bookingId)).toContain(late.bookingId);
  });
});

describe("secret rotation (W-5, W-6)", () => {
  it("signs with both secrets during the grace, then only the new one", async () => {
    const { flowId, endpoint, secret } = await subscribe(h.a, ["booking.created"]);
    const rotated = await h.admin(h.a).rotateEndpointSecret(endpoint.id, { graceMinutes: 60 }, randomUUID());
    expect(rotated.signingSecret).not.toBe(secret);
    // The flow still holds the old secret: it verifies during the grace.
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    await drain();
    expect(ap.events(flowId)).toHaveLength(1);
    expect(String(ap.received.at(-1)!.headers["webhook-signature"]).split(" ")).toHaveLength(2);
    // After the grace the old secret no longer verifies; the owner pasted the new one.
    h.clock.advance(61 * 60_000);
    await h.websiteRequest(h.a);
    await drain();
    expect(ap.unsigned.length).toBeGreaterThan(0);
    ap.setSecrets(flowId, { current: rotated.signingSecret });
    h.clock.advance(10 * 60_000);
    await drain();
    expect(ap.events(flowId)).toHaveLength(2);
    expect(String(ap.received.at(-1)!.headers["webhook-signature"]).split(" ")).toHaveLength(1);
  });

  it("keeps signing with the previous server key during a key rotation", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    await drain(h.worker({}, { keys: { current: OTHER_KEY, previous: KEY } }));
    expect(ap.events(flowId)).toHaveLength(1);
    expect(webhookSigningSecret(OTHER_KEY, h.a.tenantId, endpoint.id, 1)).not.toBe(webhookSigningSecret(KEY, h.a.tenantId, endpoint.id, 1));
  });
});

describe("events of approved actions (approvals.md A-8, A-10)", () => {
  let hour = 200;
  /** A booking a flow proposed and the owner approved, so it ran under a stored approval. */
  async function approvedBooking(expiresInMinutes = 10_080) {
    const { secret } = await h.admin(h.a).createToken({ name: "Booking flow", scopes: ["bookings:propose"] }, randomUUID());
    const principal = await h.inbound().authenticate(`Bearer ${secret}`);
    const base = Math.ceil(h.clock.now().getTime() / 3_600_000) * 3_600_000;
    const startsAt = new Date(base + (hour++) * 3_600_000).toISOString();
    const proposal = await h.inbound().propose(principal,
      { action: "booking.create", input: { resourceId: h.a.resourceId, startsAt }, expiresInMinutes }, randomUUID());
    await h.session(h.a).approveApproval(proposal.id, {}, randomUUID());
    return proposal.id;
  }

  it("sends while the approval stands, and stops once the owner revokes it, before or after ingest", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await approvedBooking();
    await drain();
    expect(ap.events(flowId)).toHaveLength(1);

    // Revoked after the event was queued: the next attempt dead-letters it and sends nothing.
    h.clock.advance(1_000);
    const queued = await approvedBooking();
    const worker = h.worker();
    await worker.ingest();
    await h.session(h.a).revokeApproval(queued, {}, randomUUID());
    await worker.runOnce();
    expect(ap.events(flowId)).toHaveLength(1);
    expect((await deliveries(endpoint.id)).map((row) => row.final_reason)).toEqual([null, "approval_withdrawn"]);

    // Revoked before ingest: no delivery is queued at all.
    h.clock.advance(1_000);
    const early = await approvedBooking();
    await h.session(h.a).revokeApproval(early, {}, randomUUID());
    await drain();
    expect(await deliveries(endpoint.id)).toHaveLength(2);
    expect(ap.events(flowId)).toHaveLength(1);
  });

  it("stops once the approval expires, including on a retry", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await approvedBooking(5);
    const worker = h.worker();
    await worker.ingest();
    h.clock.advance(6 * 60_000);
    await worker.runOnce();
    expect(ap.events(flowId)).toHaveLength(0);
    expect((await deliveries(endpoint.id))[0]).toMatchObject({ status: "dead", final_reason: "approval_withdrawn" });
  });
});

describe("decided from what happened, not from the live rows (W-4, W-7)", () => {
  it("judges deal.won and its value from the deal's history, even after a reopen and an edit before ingest", async () => {
    const { flowId } = await subscribe(h.a, ["deal.won"]);
    const otherWon = randomUUID();
    await h.service((tx) => tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,'Won late',3,'won')",
      [h.a.tenantId, otherWon, h.a.pipelineId]));
    const session = h.session(h.a);
    const step = () => h.clock.advance(1_000);
    step();
    const contact = await session.upsertContact({ email: `race-${randomUUID().slice(0, 8)}@haldenrowe.example` }, randomUUID());
    const deal = await session.createDeal({ contactId: contact.result.contact.id, pipelineId: h.a.pipelineId, stageId: h.a.openStage, title: "Gutters" }, randomUUID());
    const id = deal.result.id;
    step();
    await session.setDealDetails(id, { expectedRevision: 1, value: { amountMinor: 5_000, currency: "USD" }, leadSource: null }, randomUUID());
    step();
    const won = await session.moveDealStage(id, { pipelineId: h.a.pipelineId, stageId: h.a.wonStage, expectedRevision: 2 }, randomUUID());
    step();
    await session.moveDealStage(id, { pipelineId: h.a.pipelineId, stageId: otherWon, expectedRevision: 3 }, randomUUID());
    step();
    // Reopened and repriced before the worker ever ran.
    await session.moveDealStage(id, { pipelineId: h.a.pipelineId, stageId: h.a.openStage, expectedRevision: 4 }, randomUUID());
    step();
    await session.setDealDetails(id, { expectedRevision: 5, value: { amountMinor: 9_000, currency: "USD" }, leadSource: null }, randomUUID());
    await drain();
    expect(ap.events(flowId).map((event) => event.body.data)).toEqual([expect.objectContaining({
      dealId: id, stageId: h.a.wonStage, valueMinor: 5_000, currency: "USD", wonAt: won.result.updatedAt,
    })]);

    // Won again after the reopen: a new win, at the price it had then.
    step();
    await session.moveDealStage(id, { pipelineId: h.a.pipelineId, stageId: otherWon, expectedRevision: 6 }, randomUUID());
    await drain();
    expect(ap.events(flowId).map((event) => event.body.data)).toEqual([
      expect.objectContaining({ stageId: h.a.wonStage, valueMinor: 5_000 }),
      expect.objectContaining({ stageId: otherWon, valueMinor: 9_000 }),
    ]);
  });

  it("drops a delivery queued before the endpoint was switched off and on, but sends an owner's replay of it", async () => {
    const { flowId, endpoint } = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    const worker = h.worker();
    await worker.ingest();
    h.clock.advance(1_000);
    await h.admin(h.a).updateEndpoint(endpoint.id, { enabled: false, expectedRevision: 1 }, randomUUID());
    h.clock.advance(1_000);
    await h.admin(h.a).updateEndpoint(endpoint.id, { enabled: true, expectedRevision: 2 }, randomUUID());
    await worker.runOnce();
    expect(ap.events(flowId)).toHaveLength(0);
    const [old] = await deliveries(endpoint.id);
    expect(old).toMatchObject({ status: "dead", final_reason: "endpoint_disabled" });

    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    await h.admin(h.a).replayDelivery(old!.id, {}, randomUUID());
    await drain();
    expect(ap.events(flowId)).toHaveLength(2);
  });

  it("reads a new endpoint first, so endpoints that were read before cannot starve it", async () => {
    const first = await subscribe(h.a, ["booking.created"]);
    const second = await subscribe(h.b, ["booking.created"]);
    await h.worker().ingest();
    h.clock.advance(1_000);
    const fresh = await subscribe(h.a, ["booking.created"]);
    h.clock.advance(1_000);
    await h.websiteRequest(h.a);
    // One endpoint per pass: the one never read goes first.
    const narrow = h.worker({ ingestEndpoints: 1 });
    await narrow.ingest();
    expect(await deliveries(fresh.endpoint.id)).toHaveLength(1);
    expect(await deliveries(first.endpoint.id)).toHaveLength(0);
    // Then the least recently read, in turn.
    await narrow.ingest();
    await narrow.ingest();
    expect(await deliveries(first.endpoint.id)).toHaveLength(1);
    expect(await deliveries(second.endpoint.id)).toHaveLength(0);
  });
});
