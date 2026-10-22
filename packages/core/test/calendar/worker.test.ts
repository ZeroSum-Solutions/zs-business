// G-6..G-10: the calendar worker against the real local Postgres with an in-memory Google stub.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBookingCommandSchema, type ActionBinding } from "@zs/contracts";
import { asService } from "@zs/db";
import {
  bookingHandlers,
  channelToken,
  createBooking,
  createDispatcher,
  GoogleRequestFailed,
  lockBookingResource,
  type CalendarWorkerReport,
  type DispatchContext,
  type GoogleEvent,
  type NewGoogleEvent,
} from "../../src/index.js";
import {
  CHANNEL_SECRET,
  CHANNEL_TTL_MS,
  createCalendarHarness,
  manualClock,
  START,
  stubGoogle,
  WEBHOOK_URL,
  type CalendarHarness,
  type ManualClock,
  type Resource,
  type StubGoogle,
} from "./worker-stub.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
let h: CalendarHarness;
beforeAll(async () => { h = await createCalendarHarness(); });
afterAll(async () => { await h?.close(); });
beforeEach(async () => { await h.retireAll(); });

const timed = (id: string, start: string, end: string, extra: Partial<GoogleEvent> = {}): GoogleEvent =>
  ({ id, status: "confirmed", start: { dateTime: start }, end: { dateTime: end }, ...extra });
const iso = (value: Date) => value.toISOString();
const spans = (blocks: Array<{ external_id: string | null; starts_at: Date; ends_at: Date }>) =>
  blocks.map((block) => [block.external_id, iso(block.starts_at), iso(block.ends_at)]);

interface World {
  clock: ManualClock;
  google: StubGoogle;
  resource: Resource;
  token: string;
  connectionId: string;
}
async function world(options: { pageSize?: number; delayMs?: number; timeZone?: string } = {}): Promise<World> {
  const clock = manualClock();
  const google = stubGoogle(clock, options);
  const tenantId = await h.tenant();
  const resource = await h.resource(tenantId, options.timeZone);
  const token = google.account();
  const connectionId = await h.connection(resource, token, clock.now().getTime());
  return { clock, google, resource, token, connectionId };
}

describe("sync (G-6, G-7)", () => {
  it("a full sync turns busy events into blocks and stores the sync state", async () => {
    const w = await world({ timeZone: "America/New_York" });
    w.google.put(w.token, timed("busy1", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    w.google.put(w.token, timed("free1", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z", { transparency: "transparent" }));
    w.google.put(w.token, { id: "allday1", start: { date: "2026-10-23" }, end: { date: "2026-10-24" } });
    w.google.put(w.token, timed("bday", "2026-10-22T00:00:00Z", "2026-10-22T01:00:00Z", { eventType: "birthday" }));
    const counts = await h.worker(w.google, w.clock).runOnce();
    expect(counts).toMatchObject({ synced: 1, syncFailed: 0, reauthorized: 0 });
    const blocks = await h.blocks(w.resource.tenantId);
    expect(spans(blocks)).toEqual([
      ["busy1", "2026-10-21T10:00:00.000Z", "2026-10-21T11:00:00.000Z"],
      // All-day in the resource's zone (EDT).
      ["allday1", "2026-10-23T04:00:00.000Z", "2026-10-24T04:00:00.000Z"],
    ]);
    expect(blocks.every((block) => block.source === "google" && block.connection_id === w.connectionId
      && block.resource_id === w.resource.id)).toBe(true);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ status: "active", sync_token: "sync-4", lease_until: null, last_error: null });
    expect(row.last_full_sync_at.getTime()).toBe(START);
    expect(row.last_synced_at.getTime()).toBe(START);
    expect(row.next_sync_at.getTime()).toBe(START + 15 * MINUTE);
    // Full window: one day back, 400 days ahead, no sync token.
    const query = w.google.of("listEvents")[0]![1] as { timeMin: string; timeMax: string; syncToken?: string };
    expect(query).toMatchObject({ calendarId: "primary", timeMin: new Date(START - DAY).toISOString(), timeMax: new Date(START + 400 * DAY).toISOString() });
    expect(query.syncToken).toBeUndefined();
    // Every Google call carried an abort signal.
    expect(w.google.calls.every((entry) => (entry.args.at(-1) as { signal?: AbortSignal })?.signal instanceof AbortSignal)).toBe(true);
    // Not due again until the poll interval passes.
    expect((await h.worker(w.google, w.clock).runOnce()).synced).toBe(0);
  });

  it("reads every page of a long list", async () => {
    const w = await world({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1)
      w.google.put(w.token, timed(`p${index}`, `2026-10-2${index + 1}T10:00:00Z`, `2026-10-2${index + 1}T10:30:00Z`));
    await h.worker(w.google, w.clock).runOnce();
    expect(w.google.count("listEvents")).toBe(3);
    expect((await h.blocks(w.resource.tenantId)).length).toBe(5);
    expect((await h.connectionRow(w.resource.tenantId, w.connectionId)).sync_token).toBe("sync-5");
  });

  it("an incremental sync moves, adds and removes blocks by event ID", async () => {
    const w = await world();
    w.google.put(w.token, timed("move", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    w.google.put(w.token, timed("cancel", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z"));
    w.google.put(w.token, timed("free", "2026-10-21T14:00:00Z", "2026-10-21T15:00:00Z"));
    w.google.put(w.token, timed("keep", "2026-10-21T16:00:00Z", "2026-10-21T17:00:00Z"));
    const worker = h.worker(w.google, w.clock);
    await worker.runOnce();
    const keptId = (await h.blocks(w.resource.tenantId)).find((block) => block.external_id === "keep")!.id;
    w.google.put(w.token, timed("move", "2026-10-22T10:00:00Z", "2026-10-22T11:30:00Z"));
    w.google.cancel(w.token, "cancel");
    w.google.put(w.token, timed("free", "2026-10-21T14:00:00Z", "2026-10-21T15:00:00Z", { transparency: "transparent" }));
    w.google.put(w.token, timed("new", "2026-10-23T08:00:00Z", "2026-10-23T09:00:00Z"));
    w.google.put(w.token, timed("declined", "2026-10-23T10:00:00Z", "2026-10-23T11:00:00Z",
      { attendees: [{ self: true, responseStatus: "declined" }] }));
    w.clock.advance(15 * MINUTE);
    w.google.reset();
    expect((await worker.runOnce()).synced).toBe(1);
    expect(w.google.of("listEvents").map((args) => (args[1] as { syncToken?: string }).syncToken)).toEqual(["sync-4"]);
    const blocks = await h.blocks(w.resource.tenantId);
    expect(spans(blocks)).toEqual([
      ["keep", "2026-10-21T16:00:00.000Z", "2026-10-21T17:00:00.000Z"],
      ["move", "2026-10-22T10:00:00.000Z", "2026-10-22T11:30:00.000Z"],
      ["new", "2026-10-23T08:00:00.000Z", "2026-10-23T09:00:00.000Z"],
    ]);
    // An untouched block is the same row; a moved one is updated in place.
    expect(blocks.find((block) => block.external_id === "keep")!.id).toBe(keptId);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.sync_token).toBe("sync-9");
    expect(row.last_full_sync_at.getTime()).toBe(START);
    expect(row.last_synced_at.getTime()).toBe(START + 15 * MINUTE);
  });

  it("a 410 runs a full list in the same pass and replaces the connection's blocks", async () => {
    const w = await world();
    w.google.put(w.token, timed("old", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    w.google.put(w.token, timed("stay", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z"));
    const worker = h.worker(w.google, w.clock);
    await worker.runOnce();
    // A block that did not come from this connection survives the replace.
    await h.service((tx) => tx.query(
      `INSERT INTO booking_external_blocks (tenant_id,id,resource_id,starts_at,ends_at,source,created_at)
       VALUES ($1,$2,$3,'2026-10-25T10:00:00Z','2026-10-25T11:00:00Z','manual',$4)`,
      [w.resource.tenantId, randomUUID(), w.resource.id, new Date(START)]));
    w.google.forget(w.token, "old");
    w.google.put(w.token, timed("fresh", "2026-10-24T10:00:00Z", "2026-10-24T11:00:00Z"));
    w.google.expireSyncTokens(w.token);
    w.clock.advance(15 * MINUTE);
    w.google.reset();
    expect((await worker.runOnce()).synced).toBe(1);
    const queries = w.google.of("listEvents").map((args) => args[1] as { syncToken?: string; timeMin?: string });
    expect(queries.length).toBe(2);
    expect(queries[0]!.syncToken).toBe("sync-2");
    expect(queries[1]!.timeMin).toBe(new Date(START + 15 * MINUTE - DAY).toISOString());
    expect(w.google.count("refreshAccessToken")).toBe(1);
    expect(spans(await h.blocks(w.resource.tenantId, w.connectionId))).toEqual([
      ["stay", "2026-10-21T12:00:00.000Z", "2026-10-21T13:00:00.000Z"],
      ["fresh", "2026-10-24T10:00:00.000Z", "2026-10-24T11:00:00.000Z"],
    ]);
    expect((await h.blocks(w.resource.tenantId)).filter((block) => block.source === "manual").length).toBe(1);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.sync_token).toBe("sync-3");
    expect(row.last_full_sync_at.getTime()).toBe(START + 15 * MINUTE);
  });

  it("runs a full list again once the full-sync interval has passed", async () => {
    const w = await world();
    const worker = h.worker(w.google, w.clock, { fullSyncIntervalMs: DAY });
    await worker.runOnce();
    w.clock.advance(DAY);
    w.google.reset();
    await worker.runOnce();
    expect((w.google.of("listEvents")[0]![1] as { syncToken?: string }).syncToken).toBeUndefined();
  });

  it("events this system pushed for the connection's own resource never become blocks", async () => {
    const w = await world();
    w.google.put(w.token, timed("ours", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z",
      { extendedProperties: { private: { zs_booking: randomUUID(), zs_tenant: w.resource.tenantId, zs_resource: w.resource.id } } }));
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const worker = h.worker(w.google, w.clock);
    const first = await worker.runOnce();
    expect(first).toMatchObject({ synced: 1, pushed: 1 });
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
    // The pushed booking comes back on the next list and is skipped too.
    w.clock.advance(15 * MINUTE);
    await worker.runOnce();
    expect(w.google.events(w.token).some((event) => event.id === bookingId.replaceAll("-", ""))).toBe(true);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
  });

  it("two resources sharing one calendar: a booking pushed for one blocks the other, not itself", async () => {
    const w = await world();
    const tenantId = w.resource.tenantId;
    // R2 is connected to the same Google calendar as R1.
    const second = await h.resource(tenantId);
    const secondConnection = await h.connection(second, w.token, START);
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const worker = h.worker(w.google, w.clock);
    expect(await worker.runOnce()).toMatchObject({ synced: 2, pushesQueued: 1, pushed: 1 });
    expect((w.google.of("insertEvent")[0]![2] as NewGoogleEvent).privateProperties)
      .toEqual({ zs_booking: bookingId, zs_tenant: tenantId, zs_resource: w.resource.id });
    w.clock.advance(15 * MINUTE);
    expect((await worker.runOnce()).synced).toBe(2);
    expect(await h.blocks(tenantId, w.connectionId)).toEqual([]);
    const blocks = await h.blocks(tenantId, secondConnection);
    expect(spans(blocks)).toEqual([[bookingId.replaceAll("-", ""), "2026-10-22T10:00:00.000Z", "2026-10-22T10:30:00.000Z"]]);
    expect(blocks[0]!.resource_id).toBe(second.id);
  });

  it("a full list that hits the page cap: a complete near list replaces its window, the rest is only upserted", async () => {
    const w = await world({ pageSize: 2 });
    const tenantId = w.resource.tenantId;
    const put = (id: string, day: string) => w.google.put(w.token, timed(id, `${day}T10:00:00Z`, `${day}T11:00:00Z`));
    put("far1", "2027-03-01");
    put("near1", "2026-10-25");
    put("gone", "2026-10-26");
    put("far2", "2027-04-01");
    put("fargone", "2027-05-01");
    await h.worker(w.google, w.clock).runOnce();
    expect((await h.blocks(tenantId)).length).toBe(5);
    const near1 = (await h.blocks(tenantId)).find((block) => block.external_id === "near1")!.id;
    w.google.forget(w.token, "gone");
    w.google.forget(w.token, "fargone");
    put("far2", "2027-04-02");
    put("far3", "2027-06-01");
    put("near2", "2026-11-05");
    // In Google's order two pages of two hold far1, near1, far2 and far3; near2 is past the cap.
    w.google.expireSyncTokens(w.token);
    w.clock.advance(15 * MINUTE);
    w.google.reset();
    const reports: CalendarWorkerReport[] = [];
    const capped = h.worker(w.google, w.clock, { maxPages: 2 }, reports);
    expect((await capped.runOnce()).synced).toBe(1);
    const at = START + 15 * MINUTE;
    const queries = w.google.of("listEvents").map((args) => args[1] as { syncToken?: string; timeMin?: string; timeMax?: string; pageToken?: string });
    expect(queries.map((query) => [query.syncToken, query.timeMin, query.timeMax, query.pageToken])).toEqual([
      ["sync-5", undefined, undefined, undefined],
      [undefined, iso(new Date(at - DAY)), iso(new Date(at + 400 * DAY)), undefined],
      [undefined, iso(new Date(at - DAY)), iso(new Date(at + 400 * DAY)), "page-2"],
      [undefined, iso(new Date(at - DAY)), iso(new Date(at + 30 * DAY)), undefined],
    ]);
    const blocks = await h.blocks(tenantId);
    expect(spans(blocks)).toEqual([
      // The near window: as the near list says, so `gone` is gone and near2 is there.
      ["near1", "2026-10-25T10:00:00.000Z", "2026-10-25T11:00:00.000Z"],
      ["near2", "2026-11-05T10:00:00.000Z", "2026-11-05T11:00:00.000Z"],
      // Beyond it: the capped list adds and moves blocks but deletes none (fargone stays).
      ["far1", "2027-03-01T10:00:00.000Z", "2027-03-01T11:00:00.000Z"],
      ["far2", "2027-04-02T10:00:00.000Z", "2027-04-02T11:00:00.000Z"],
      ["fargone", "2027-05-01T10:00:00.000Z", "2027-05-01T11:00:00.000Z"],
      ["far3", "2027-06-01T10:00:00.000Z", "2027-06-01T11:00:00.000Z"],
    ]);
    expect(blocks.find((block) => block.external_id === "near1")!.id).toBe(near1);
    const row = await h.connectionRow(tenantId, w.connectionId);
    expect(row).toMatchObject({ sync_token: null, last_error: "too_many_events", lease_until: null });
    expect(row.last_full_sync_at.getTime()).toBe(START);
    expect(reports).toContainEqual({ kind: "synced", tenantId, connectionId: w.connectionId, mode: "full", events: 4, complete: false });
    // No sync token: the next sync is a full list again.
    w.clock.advance(15 * MINUTE);
    w.google.reset();
    await capped.runOnce();
    expect((w.google.of("listEvents")[0]![1] as { syncToken?: string; timeMax?: string }))
      .toMatchObject({ timeMax: iso(new Date(at + 15 * MINUTE + 400 * DAY)) });
    expect((w.google.of("listEvents")[0]![1] as { syncToken?: string }).syncToken).toBeUndefined();
  });

  it("when the near list hits the page cap too, the blocks are only upserted", async () => {
    const w = await world({ pageSize: 1 });
    const tenantId = w.resource.tenantId;
    const put = (id: string, day: string) => w.google.put(w.token, timed(id, `${day}T10:00:00Z`, `${day}T11:00:00Z`));
    put("stale", "2026-10-21");
    await h.worker(w.google, w.clock).runOnce();
    w.google.forget(w.token, "stale");
    put("a", "2026-10-22");
    put("b", "2026-10-23");
    put("c", "2026-10-24");
    w.google.expireSyncTokens(w.token);
    w.clock.advance(15 * MINUTE);
    w.google.reset();
    expect((await h.worker(w.google, w.clock, { maxPages: 2 }).runOnce()).synced).toBe(1);
    // A 410, two pages of the full list, two of the near list.
    expect(w.google.count("listEvents")).toBe(5);
    expect((await h.blocks(tenantId)).map((block) => block.external_id)).toEqual(["stale", "a", "b"]);
    expect(await h.connectionRow(tenantId, w.connectionId)).toMatchObject({ sync_token: null, last_error: "too_many_events" });
  });

  it("blocks stop slots: a booking in a blocked slot is refused, a free one commits", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    await h.worker(w.google, w.clock).runOnce();
    const dispatch = createDispatcher({ ...bookingHandlers });
    const actorId = randomUUID();
    const book = (startsAt: string) => {
      const tenantId = w.resource.tenantId;
      const bookingId = randomUUID();
      const cmd = createBookingCommandSchema.parse({
        actionType: "booking.create", target: { tenantId, type: "booking", id: bookingId },
        payload: { bookingId, resourceId: w.resource.id, startsAt },
        approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: randomUUID(),
      });
      const ctx: DispatchContext = {
        tenantId, actor: { tenantId, id: actorId }, db: h.database.db, clock: w.clock, config: {}, generateId: randomUUID,
        resolveApproval: async (): Promise<ActionBinding> => ({
          tenantId, actorId, actionType: cmd.actionType, target: cmd.target, payload: cmd.payload, approvalReference: cmd.approvalReference,
        }),
      };
      return createBooking(cmd, { dispatch: (parsed) => dispatch(ctx, parsed) });
    };
    await expect(book("2026-10-21T10:30:00.000Z")).rejects.toMatchObject({ details: { reason: "slot_unavailable" } });
    await expect(book("2026-10-21T10:00:00.000Z")).rejects.toMatchObject({ details: { reason: "slot_unavailable" } });
    await expect(book("2026-10-21T11:00:00.000Z")).resolves.toMatchObject({ result: { startsAt: "2026-10-21T11:00:00.000Z" } });
  });

  it("applies under the B-21 resource lock: the write waits while a booking holds it", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = asService(h.database.servicePool, async (tx) => {
      await lockBookingResource(tx, w.resource.tenantId, w.resource.id);
      locked();
      await gate;
    });
    await holding;
    let finished = false;
    const run = h.worker(w.google, w.clock).runOnce().then((counts) => { finished = true; return counts; });
    // The worker's apply transaction waits on the same advisory lock.
    let waiting = 0;
    for (let tries = 0; tries < 100 && waiting === 0; tries += 1) {
      waiting = Number((await h.database.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0]!.n);
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(1);
    expect(finished).toBe(false);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
    release();
    await holder;
    expect((await run).synced).toBe(1);
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
  });

  it("invalid_grant moves the connection to reauthorize and keeps its blocks", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const reports: CalendarWorkerReport[] = [];
    const worker = h.worker(w.google, w.clock, {}, reports);
    await worker.runOnce();
    w.google.revokeGrant(w.token);
    w.clock.advance(15 * MINUTE);
    expect(await worker.runOnce()).toMatchObject({ synced: 0, reauthorized: 1 });
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId))
      .toMatchObject({ status: "reauthorize", last_error: "invalid_grant", lease_until: null });
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    expect(reports).toContainEqual({ kind: "reauthorize", tenantId: w.resource.tenantId, connectionId: w.connectionId, code: "invalid_grant" });
    // Not claimed again.
    w.clock.advance(60 * MINUTE);
    w.google.reset();
    await worker.runOnce();
    expect(w.google.calls).toEqual([]);
    // Reports never carry a token.
    expect(JSON.stringify(reports)).not.toContain(w.token);
  });

  it("a sealed token that does not open moves the connection to reauthorize without calling Google", async () => {
    const w = await world();
    const other = await h.connection(await h.resource(w.resource.tenantId), w.google.account(), START, { sealFor: randomUUID() });
    expect(await h.worker(w.google, w.clock).runOnce()).toMatchObject({ synced: 1, reauthorized: 1 });
    expect(await h.connectionRow(w.resource.tenantId, other)).toMatchObject({ status: "reauthorize", last_error: "token_unreadable" });
    expect(w.google.count("refreshAccessToken")).toBe(1);
  });

  it("a retryable Google error keeps the blocks and retries with a growing delay", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(w.google, w.clock);
    // A brand-new connection that fails waits the base delay.
    w.google.fail("listEvents", new GoogleRequestFailed("google_503_backendError", true, 503));
    expect(await worker.runOnce()).toMatchObject({ synced: 0, syncFailed: 1 });
    let row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ status: "active", last_error: "google_503_backendError", lease_until: null });
    expect(row.next_sync_at.getTime()).toBe(START + MINUTE);
    w.clock.advance(MINUTE);
    await worker.runOnce();
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    // Healthy for 15 minutes, then Google stops answering: the delay grows with the outage.
    w.clock.advance(15 * MINUTE);
    w.google.fail("refreshAccessToken", new GoogleRequestFailed("google_network", true));
    expect((await worker.runOnce()).syncFailed).toBe(1);
    row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.last_error).toBe("google_network");
    expect(row.next_sync_at.getTime()).toBe(START + 16 * MINUTE + 15 * MINUTE);
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    // A hanging call times out instead of holding the pass.
    w.clock.advance(15 * MINUTE);
    w.google.fail("listEvents", () => new Promise<void>(() => undefined));
    const timedOut = h.worker(w.google, w.clock, { requestTimeoutMs: 50, leaseMs: 1000 });
    expect((await timedOut.runOnce()).syncFailed).toBe(1);
    expect((await h.connectionRow(w.resource.tenantId, w.connectionId)).last_error).toBe("google_timeout");
  });

  it("a connection that turns disconnecting mid-sync gets no blocks", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    w.google.fail("listEvents", async () => {
      await h.database.db.tenant(w.resource.tenantId, (tx) => tx.query(
        "UPDATE calendar_connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [w.resource.tenantId, w.connectionId, new Date(START)]));
    });
    const worker = h.worker(w.google, w.clock);
    expect((await worker.runOnce()).synced).toBe(0);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({ status: "disconnecting", lease_until: null });
    expect((await worker.runOnce()).disconnected).toBe(1);
  });
});

describe("disconnect cleanup (G-9)", () => {
  async function connectedWithChannel() {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(w.google, w.clock, { webhookUrl: WEBHOOK_URL });
    await worker.runOnce();
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.channel_id).not.toBeNull();
    return { w, worker, channelId: row.channel_id as string, channelResource: row.channel_resource_id as string };
  }
  const disconnect = (w: World) => h.database.db.tenant(w.resource.tenantId, (tx) => tx.query(
    "UPDATE calendar_connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
    [w.resource.tenantId, w.connectionId, w.clock.now()]));

  it("stops the channel, revokes the grant, removes the blocks and clears the token", async () => {
    const { w, worker, channelId, channelResource } = await connectedWithChannel();
    // A pending push of this connection cannot go out any more.
    const bookingId = await h.booking(w.resource, "2026-10-23T10:00:00.000Z");
    await h.service((tx) => tx.query(
      `INSERT INTO calendar_pushes (tenant_id,connection_id,booking_id,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$4,$4)`, [w.resource.tenantId, w.connectionId, bookingId, new Date(START + DAY)]));
    await disconnect(w);
    w.google.reset();
    expect(await worker.runOnce()).toMatchObject({ disconnected: 1, channelsStopped: 1 });
    expect(w.google.of("stopChannel").map((args) => args[1])).toEqual([{ channelId, resourceId: channelResource }]);
    expect(w.google.of("revoke").map((args) => args[0])).toEqual([w.token]);
    expect(w.google.isRevoked(w.token)).toBe(true);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({
      status: "disconnected", refresh_token_sealed: null, sync_token: null, channel_id: null, channel_resource_id: null,
      channel_expires_at: null, lease_until: null,
    });
    expect(await h.push(w.resource.tenantId, bookingId)).toMatchObject({ status: "failed", last_error: "disconnected" });
    // Done for good: nothing more is claimed or called.
    w.google.reset();
    w.clock.advance(DAY);
    await worker.runOnce();
    expect(w.google.calls).toEqual([]);
  });

  it("a revoke that fails on the network keeps disconnecting with the blocks, then finishes", async () => {
    const { w, worker } = await connectedWithChannel();
    await disconnect(w);
    w.google.fail("stopChannel", new GoogleRequestFailed("google_503", true, 503));
    w.google.fail("revoke", new GoogleRequestFailed("google_network", true));
    expect(await worker.runOnce()).toMatchObject({ disconnected: 0, disconnectRetries: 1 });
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({ status: "disconnecting", last_error: "google_network" });
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    // Not retried before its delay.
    w.google.reset();
    await worker.runOnce();
    expect(w.google.count("revoke")).toBe(0);
    w.clock.advance(MINUTE);
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);
    expect((await h.connectionRow(w.resource.tenantId, w.connectionId)).status).toBe("disconnected");
  });

  it("keeps a grant an active connection may share: the same account anywhere, or the same resource without an email", async () => {
    const { w, worker } = await connectedWithChannel();
    // The owner reconnected the same resource with the same Google account: a revoke would end the new grant too.
    const email = (await h.connectionRow(w.resource.tenantId, w.connectionId)).account_email as string;
    await disconnect(w);
    const replacement = await h.connection(w.resource, w.google.account(), START, { email: email.toUpperCase() });
    w.google.reset();
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.count("revoke")).toBe(0);
    expect(w.google.isRevoked(w.token)).toBe(false);
    expect(await h.blocks(w.resource.tenantId, w.connectionId)).toEqual([]);
    expect((await h.connectionRow(w.resource.tenantId, w.connectionId)).status).toBe("disconnected");
    expect((await h.connectionRow(w.resource.tenantId, replacement)).status).toBe("active");

    // The same Google account connected in another tenant keeps its grant too.
    const shared = "shared@haldenrowe.example";
    const other = await h.resource(await h.tenant());
    await h.connection(other, w.google.account(), START, { email: shared });
    const tenantId = await h.tenant();
    const leaving = await h.connection(await h.resource(tenantId), w.google.account(), START, { email: shared.toUpperCase(), status: "disconnecting" });
    w.google.reset();
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.count("revoke")).toBe(0);
    expect((await h.connectionRow(tenantId, leaving)).status).toBe("disconnected");

    // Without an email on either row, an active replacement on the same resource may be the same account.
    for (const [leavingEmail, replacementEmail] of [[null, "next@haldenrowe.example"], ["prior@haldenrowe.example", null]] as const) {
      const resource = await h.resource(await h.tenant());
      const id = await h.connection(resource, w.google.account(), START, { email: leavingEmail, status: "disconnecting" });
      await h.connection(resource, w.google.account(), START, { email: replacementEmail });
      w.google.reset();
      expect((await worker.runOnce()).disconnected).toBe(1);
      expect(w.google.count("revoke")).toBe(0);
      expect((await h.connectionRow(resource.tenantId, id)).status).toBe("disconnected");
    }
  });

  it("revokes when no active connection shares the grant: another account on the resource, or a reauthorize row", async () => {
    const { w, worker } = await connectedWithChannel();
    // The owner reconnected the same resource with a different Google account: the old grant goes.
    await disconnect(w);
    const replacementToken = w.google.account();
    const replacement = await h.connection(w.resource, replacementToken, START);
    w.google.reset();
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.of("revoke").map((args) => args[0])).toEqual([w.token]);
    expect(w.google.isRevoked(w.token)).toBe(true);
    expect(w.google.isRevoked(replacementToken)).toBe(false);
    expect((await h.connectionRow(w.resource.tenantId, replacement)).status).toBe("active");

    // A reauthorize row on the same account elsewhere has lost its grant already: it keeps nothing.
    const stale = "stale@haldenrowe.example";
    await h.connection(await h.resource(await h.tenant()), w.google.account(), START, { email: stale, status: "reauthorize" });
    const tenantId = await h.tenant();
    const leavingToken = w.google.account();
    const leaving = await h.connection(await h.resource(tenantId), leavingToken, START, { email: stale, status: "disconnecting" });
    w.google.reset();
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.of("revoke").map((args) => args[0])).toEqual([leavingToken]);
    expect((await h.connectionRow(tenantId, leaving)).status).toBe("disconnected");
  });

  it("a revoke Google refuses keeps disconnecting with the token, the blocks and the error, then finishes", async () => {
    const { w, worker } = await connectedWithChannel();
    await disconnect(w);
    w.google.fail("revoke", new GoogleRequestFailed("google_403", false, 403));
    expect(await worker.runOnce()).toMatchObject({ disconnected: 0, disconnectRetries: 1 });
    expect(w.google.isRevoked(w.token)).toBe(false);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ status: "disconnecting", last_error: "google_403" });
    expect(row.refresh_token_sealed).not.toBeNull();
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    w.clock.advance(MINUTE);
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.isRevoked(w.token)).toBe(true);
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({ status: "disconnected", refresh_token_sealed: null });
  });

  it("an already revoked grant or an unreadable token still cleans up", async () => {
    const { w, worker } = await connectedWithChannel();
    w.google.revokeGrant(w.token);
    await disconnect(w);
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(await h.blocks(w.resource.tenantId)).toEqual([]);

    const tenantId = await h.tenant();
    const resource = await h.resource(tenantId);
    const unreadable = await h.connection(resource, w.google.account(), START, { sealFor: randomUUID(), status: "disconnecting" });
    w.google.reset();
    expect((await worker.runOnce()).disconnected).toBe(1);
    expect(w.google.calls).toEqual([]);
    expect((await h.connectionRow(tenantId, unreadable)).status).toBe("disconnected");
  });
});

describe("push notifications and channels (G-8)", () => {
  it("opens a channel with the derived token, renews it a day before expiry and stops the old one", async () => {
    const w = await world();
    const worker = h.worker(w.google, w.clock, { webhookUrl: WEBHOOK_URL });
    expect(await worker.runOnce()).toMatchObject({ synced: 1, channelsOpened: 1 });
    const watched = w.google.of("watch")[0]![1] as { channelId: string; address: string; token: string; calendarId: string };
    expect(watched).toMatchObject({ address: WEBHOOK_URL, calendarId: "primary", token: channelToken(CHANNEL_SECRET, watched.channelId) });
    let row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.channel_id).toBe(watched.channelId);
    expect(row.channel_expires_at.getTime()).toBe(START + CHANNEL_TTL_MS);
    const first = { id: row.channel_id, resource: row.channel_resource_id };

    // Well before expiry: no new channel.
    w.clock.advance(15 * MINUTE);
    expect((await worker.runOnce()).channelsOpened).toBe(0);
    // Within a day of expiry: a new channel, then the old one stopped.
    w.clock.set(START + CHANNEL_TTL_MS - DAY + MINUTE);
    w.google.reset();
    expect(await worker.runOnce()).toMatchObject({ channelsOpened: 1, channelsStopped: 1 });
    row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row.channel_id).not.toBe(first.id);
    expect(w.google.of("stopChannel").map((args) => args[1])).toEqual([{ channelId: first.id, resourceId: first.resource }]);
    expect(w.google.channels.get(first.id)!.stopped).toBe(true);
    expect(w.google.channels.get(row.channel_id)!.stopped).toBe(false);
  });

  it("channel calls end with the run's deadline, and none starts once no time is left (G-10)", async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 400));
    const timed = async (work: () => Promise<unknown>) => {
      const started = Date.now();
      const result = await work();
      return { result, ms: Date.now() - started };
    };
    // A slow watch: cut at the 100 ms left; the sync still applies.
    const v = await world();
    v.google.fail("watch", slow);
    const watching = await timed(() => h.worker(v.google, v.clock, { webhookUrl: WEBHOOK_URL })
      .runOnce({ deadline: new Date(v.clock.now().getTime() + 100) }));
    expect(watching.result).toMatchObject({ synced: 1, channelsOpened: 0, channelFailures: 1 });
    expect(watching.ms).toBeLessThan(400);

    // Renewal: a slow stop of the old channel is cut the same way.
    const w = await world();
    const worker = h.worker(w.google, w.clock, { webhookUrl: WEBHOOK_URL });
    await worker.runOnce();
    w.clock.set(START + CHANNEL_TTL_MS - DAY + MINUTE);
    w.google.reset();
    w.google.fail("stopChannel", slow);
    const stopping = await timed(() => worker.runOnce({ deadline: new Date(w.clock.now().getTime() + 100) }));
    expect(stopping.result).toMatchObject({ synced: 1, channelsOpened: 1, channelsStopped: 0 });
    expect(stopping.ms).toBeLessThan(400);

    // A watch that uses up the run: the old channel is not stopped at all; it expires on its own.
    w.clock.set(START + 2 * CHANNEL_TTL_MS - DAY);
    w.google.reset();
    w.google.fail("watch", () => { w.clock.advance(MINUTE); });
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + 1_000) }))
      .toMatchObject({ synced: 1, channelsOpened: 1, channelsStopped: 0 });
    expect(w.google.count("stopChannel")).toBe(0);
  });

  it("opens no channel without a webhook URL, and a watch failure does not fail the sync", async () => {
    const w = await world();
    expect(await h.worker(w.google, w.clock).runOnce()).toMatchObject({ synced: 1, channelsOpened: 0 });
    expect(w.google.count("watch")).toBe(0);
    const v = await world();
    v.google.fail("watch", new GoogleRequestFailed("google_400_push_webhookNotVerified", false, 400));
    expect(await h.worker(v.google, v.clock, { webhookUrl: WEBHOOK_URL }).runOnce())
      .toMatchObject({ synced: 1, channelsOpened: 0, channelFailures: 1 });
    expect((await h.connectionRow(v.resource.tenantId, v.connectionId)).channel_id).toBeNull();
  });

  it("a notification makes its connection due now and is marked processed", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(w.google, w.clock, { webhookUrl: WEBHOOK_URL });
    await worker.runOnce();
    const channelId = (await h.connectionRow(w.resource.tenantId, w.connectionId)).channel_id as string;
    const notify = (number: number, state: string, at: number) => h.database.db.platform!((tx) => tx.query(
      `INSERT INTO calendar_push_notifications (channel_id,message_number,resource_state,received_at) VALUES ($1,$2,$3,$4)`,
      [channelId, number, state, new Date(at)]));
    // The first `sync` message carries no change.
    await notify(1, "sync", START);
    w.clock.advance(MINUTE);
    expect(await worker.runOnce()).toMatchObject({ notifications: 1, markedDue: 0, synced: 0 });
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T12:00:00Z"));
    await notify(2, "exists", START + MINUTE);
    w.clock.advance(MINUTE);
    expect(await worker.runOnce()).toMatchObject({ notifications: 1, markedDue: 1, synced: 1 });
    expect(spans(await h.blocks(w.resource.tenantId))).toEqual([["busy", "2026-10-21T10:00:00.000Z", "2026-10-21T12:00:00.000Z"]]);
    const stored = await h.rows("SELECT processed_at FROM calendar_push_notifications WHERE channel_id=$1 ORDER BY message_number", [channelId]);
    expect(stored.map((entry) => entry.processed_at?.getTime())).toEqual([START + MINUTE, START + 2 * MINUTE]);
    // Processed notifications older than a day are deleted.
    w.clock.advance(DAY + 2 * MINUTE);
    await worker.runOnce();
    expect(await h.rows("SELECT 1 FROM calendar_push_notifications WHERE channel_id=$1", [channelId])).toEqual([]);
  });
});

describe("bookings out (G-10)", () => {
  it("pushes each confirmed future booking once with the booking ID as the event ID", async () => {
    const w = await world();
    const future = await h.booking(w.resource, "2026-10-22T10:00:00.000Z", 45);
    const ended = await h.booking(w.resource, "2026-10-19T10:00:00.000Z");
    const unconnected = await h.booking(await h.resource(w.resource.tenantId), "2026-10-22T10:00:00.000Z");
    const worker = h.worker(w.google, w.clock);
    expect(await worker.runOnce()).toMatchObject({ pushesQueued: 1, pushed: 1 });
    const inserted = w.google.of("insertEvent");
    expect(inserted.length).toBe(1);
    expect(inserted[0]![1]).toBe("primary");
    expect(inserted[0]![2]).toEqual({
      id: future.replaceAll("-", ""), summary: "Booked", start: "2026-10-22T10:00:00.000Z", end: "2026-10-22T10:45:00.000Z",
      privateProperties: { zs_booking: future, zs_tenant: w.resource.tenantId, zs_resource: w.resource.id },
    } satisfies NewGoogleEvent);
    expect(await h.push(w.resource.tenantId, future)).toMatchObject({ status: "pushed", attempts: 1, last_error: null, lease_until: null });
    expect((await h.push(w.resource.tenantId, future)).pushed_at.getTime()).toBe(START);
    expect(await h.push(w.resource.tenantId, ended)).toBeUndefined();
    expect(await h.push(w.resource.tenantId, unconnected)).toBeUndefined();
    w.clock.advance(15 * MINUTE);
    expect(await worker.runOnce()).toMatchObject({ pushesQueued: 0, pushed: 0 });
    expect(w.google.count("insertEvent")).toBe(1);
  });

  it("a configured title and a 409 (already there) both work", async () => {
    const w = await world();
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    w.google.put(w.token, timed(bookingId.replaceAll("-", ""), "2026-10-22T10:00:00Z", "2026-10-22T10:30:00Z",
      { extendedProperties: { private: { zs_booking: bookingId } } }));
    expect((await h.worker(w.google, w.clock, { eventTitle: "Held" }).runOnce()).pushed).toBe(1);
    expect((w.google.of("insertEvent")[0]![2] as NewGoogleEvent).summary).toBe("Held");
    expect((await h.push(w.resource.tenantId, bookingId)).status).toBe("pushed");
  });

  it("retries a retryable failure after a backoff and fails after the last attempt", async () => {
    const w = await world();
    const retried = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const worker = h.worker(w.google, w.clock, { pushMaxAttempts: 3 });
    w.google.fail("insertEvent", new GoogleRequestFailed("google_503", true, 503));
    expect(await worker.runOnce()).toMatchObject({ pushRetries: 1, pushed: 0 });
    let push = await h.push(w.resource.tenantId, retried);
    expect(push).toMatchObject({ status: "pending", attempts: 1, last_error: "google_503", lease_until: null });
    expect(push.next_attempt_at.getTime()).toBe(START + MINUTE);
    w.clock.advance(30_000);
    await worker.runOnce();
    expect(w.google.count("insertEvent")).toBe(1);
    w.clock.advance(30_000);
    expect((await worker.runOnce()).pushed).toBe(1);
    expect((await h.push(w.resource.tenantId, retried)).status).toBe("pushed");

    const doomed = await h.booking(w.resource, "2026-10-23T10:00:00.000Z");
    w.google.fail("insertEvent", ...[1, 2, 3].map(() => new GoogleRequestFailed("google_429_rateLimitExceeded", true, 429)));
    for (const wait of [0, MINUTE, 2 * MINUTE]) {
      w.clock.advance(wait);
      await worker.runOnce();
    }
    push = await h.push(w.resource.tenantId, doomed);
    expect(push).toMatchObject({ status: "failed", attempts: 3, last_error: "google_429_rateLimitExceeded", pushed_at: null });
    w.clock.advance(DAY);
    w.google.reset();
    await worker.runOnce();
    expect(w.google.count("insertEvent")).toBe(0);
  });

  it("a 401 (the grant went away mid-pass) keeps the push pending for a retry", async () => {
    const w = await world();
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const worker = h.worker(w.google, w.clock);
    w.google.fail("insertEvent", new GoogleRequestFailed("google_401_authError", false, 401));
    expect(await worker.runOnce()).toMatchObject({ pushRetries: 1, pushesFailed: 0, reauthorized: 0 });
    const push = await h.push(w.resource.tenantId, bookingId);
    expect(push).toMatchObject({ status: "pending", attempts: 1, last_error: "google_401_authError", lease_until: null });
    expect(push.next_attempt_at.getTime()).toBe(START + MINUTE);
    expect((await h.connectionRow(w.resource.tenantId, w.connectionId)).status).toBe("active");
    w.clock.advance(MINUTE);
    expect((await worker.runOnce()).pushed).toBe(1);
    // On the last attempt a 401 fails the push like any other retryable error.
    const last = await h.booking(w.resource, "2026-10-23T10:00:00.000Z");
    w.google.fail("insertEvent", new GoogleRequestFailed("google_401_authError", false, 401));
    expect((await h.worker(w.google, w.clock, { pushMaxAttempts: 1 }).runOnce()).pushesFailed).toBe(1);
    expect(await h.push(w.resource.tenantId, last)).toMatchObject({ status: "failed", attempts: 1, last_error: "google_401_authError" });
  });

  it("another refusal fails the push at once", async () => {
    const w = await world();
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    w.google.fail("insertEvent", new GoogleRequestFailed("google_403_forbidden", false, 403));
    expect((await h.worker(w.google, w.clock).runOnce()).pushesFailed).toBe(1);
    expect(await h.push(w.resource.tenantId, bookingId)).toMatchObject({ status: "failed", attempts: 1, last_error: "google_403_forbidden" });
  });

  it("a disconnect during a push batch sends none of the pushes the batch has not started", async () => {
    const w = await world();
    const tenantId = w.resource.tenantId;
    const bookings = [await h.booking(w.resource, "2026-10-22T10:00:00.000Z"), await h.booking(w.resource, "2026-10-22T12:00:00.000Z")];
    // The owner disconnects while the first insert is in flight.
    w.google.fail("insertEvent", async () => {
      await h.service((tx) => tx.query("UPDATE calendar_connections SET status='disconnecting' WHERE tenant_id=$1 AND id=$2",
        [tenantId, w.connectionId]));
    });
    expect(await h.worker(w.google, w.clock).runOnce()).toMatchObject({ pushesQueued: 2, pushed: 1, lostLeases: 1 });
    expect(w.google.count("insertEvent")).toBe(1);
    const pushes = await Promise.all(bookings.map((id) => h.push(tenantId, id)));
    expect(pushes.map((push) => push.status).sort()).toEqual(["pending", "pushed"]);
    expect(pushes.find((push) => push.status === "pending")).toMatchObject({ pushed_at: null, google_event_id: expect.any(String) });
  });
});

describe("deadline (G-10)", () => {
  it("a pass whose deadline has passed claims nothing; one with time left runs", async () => {
    const w = await world();
    const tenantId = w.resource.tenantId;
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const leaving = await h.connection(await h.resource(tenantId), w.google.account(), START, { status: "disconnecting" });
    const channelId = randomUUID();
    await h.database.db.platform!((tx) => tx.query(
      "INSERT INTO calendar_push_notifications (channel_id,message_number,resource_state,received_at) VALUES ($1,1,'exists',$2)",
      [channelId, new Date(START)]));
    const worker = h.worker(w.google, w.clock);
    const counts = await worker.runOnce({ deadline: w.clock.now() });
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
    expect(w.google.calls).toEqual([]);
    expect(await h.connectionRow(tenantId, w.connectionId)).toMatchObject({ status: "active", lease_until: null, last_synced_at: null });
    expect(await h.connectionRow(tenantId, leaving)).toMatchObject({ status: "disconnecting", lease_until: null });
    expect(await h.push(tenantId, bookingId)).toBeUndefined();
    expect(await h.rows("SELECT processed_at FROM calendar_push_notifications WHERE channel_id=$1", [channelId]))
      .toEqual([{ processed_at: null }]);
    expect(await worker.runOnce({ deadline: new Date(START + MINUTE) }))
      .toMatchObject({ notifications: 1, disconnected: 1, synced: 1, pushed: 1 });
  });

  it("a deadline that passes mid-step gives back the connections and pushes the pass has not started", async () => {
    const w = await world();
    const tenantId = w.resource.tenantId;
    const second = await h.resource(tenantId);
    const secondConnection = await h.connection(second, w.google.account(), START);
    const deadline = new Date(START + MINUTE);
    // The first listing outlasts the deadline: the other claimed connection goes back unsynced.
    w.google.fail("listEvents", () => { w.clock.advance(2 * MINUTE); });
    const worker = h.worker(w.google, w.clock);
    expect(await worker.runOnce({ deadline })).toMatchObject({ synced: 1, pushesQueued: 0 });
    expect(w.google.count("listEvents")).toBe(1);
    const rows = [await h.connectionRow(tenantId, w.connectionId), await h.connectionRow(tenantId, secondConnection)];
    expect(rows.map((row) => row.lease_until)).toEqual([null, null]);
    expect(rows.filter((row) => row.last_synced_at === null).length).toBe(1);
    expect((await worker.runOnce()).synced).toBe(1);

    // Pushes: the first insert outlasts the deadline; the second push goes back with its attempt.
    const one = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    const two = await h.booking(second, "2026-10-22T12:00:00.000Z");
    w.google.fail("insertEvent", () => { w.clock.advance(2 * MINUTE); });
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + MINUTE) }))
      .toMatchObject({ pushesQueued: 2, pushed: 1 });
    const pushes = [await h.push(tenantId, one), await h.push(tenantId, two)];
    expect(pushes.map((push) => push.status).sort()).toEqual(["pending", "pushed"]);
    expect(pushes.find((push) => push.status === "pending")).toMatchObject({ attempts: 0, lease_until: null, last_error: null });
    expect((await worker.runOnce()).pushed).toBe(1);
  });

  it("a list that pages past the deadline stops there: a later connection goes back unchanged", async () => {
    const w = await world({ pageSize: 2 });
    const tenantId = w.resource.tenantId;
    w.google.put(w.token, timed("first", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const second = await h.resource(tenantId);
    const secondToken = w.google.account();
    for (let index = 0; index < 5; index += 1)
      w.google.put(secondToken, timed(`p${index}`, `2026-10-2${index + 1}T10:00:00Z`, `2026-10-2${index + 1}T10:30:00Z`));
    const secondConnection = await h.connection(second, secondToken, START);
    // The first connection is claimed first; the second one's first page outlasts the deadline.
    await h.service((tx) => tx.query("UPDATE calendar_connections SET next_sync_at=$3 WHERE tenant_id=$1 AND id=$2",
      [tenantId, w.connectionId, new Date(START - MINUTE)]));
    const before = await h.connectionRow(tenantId, secondConnection);
    w.google.fail("listEvents", () => {}, () => { w.clock.advance(2 * MINUTE); });
    const reports: CalendarWorkerReport[] = [];
    const worker = h.worker(w.google, w.clock, {}, reports);
    expect(await worker.runOnce({ deadline: new Date(START + MINUTE) }))
      .toMatchObject({ synced: 1, deadlineStops: 1, syncFailed: 0 });
    expect(w.google.count("listEvents")).toBe(2);
    expect(reports).toContainEqual({ kind: "deadline_reached", tenantId, connectionId: secondConnection });
    expect(await h.connectionRow(tenantId, secondConnection)).toMatchObject({
      lease_until: null, next_sync_at: before.next_sync_at, last_synced_at: null, last_error: null, sync_token: null,
    });
    expect(await h.blocks(tenantId, secondConnection)).toEqual([]);
    // The next run takes it first, with a whole budget.
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + MINUTE) })).toMatchObject({ synced: 1, deadlineStops: 0 });
    expect((await h.blocks(tenantId, secondConnection)).length).toBe(5);
  });

  it("a connection cut by the deadline while first in the pass backs off instead of taking every run", async () => {
    const w = await world({ pageSize: 2 });
    for (let index = 0; index < 5; index += 1)
      w.google.put(w.token, timed(`p${index}`, `2026-10-2${index + 1}T10:00:00Z`, `2026-10-2${index + 1}T10:30:00Z`));
    w.google.fail("listEvents", () => { w.clock.advance(2 * MINUTE); });
    const worker = h.worker(w.google, w.clock);
    expect(await worker.runOnce({ deadline: new Date(START + MINUTE) })).toMatchObject({ synced: 0, syncFailed: 1, deadlineStops: 0 });
    expect(w.google.count("listEvents")).toBe(1);
    const row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ lease_until: null, last_error: "run_deadline", sync_token: null });
    expect(row.next_sync_at.getTime()).toBeGreaterThan(w.clock.now().getTime());
    expect(await h.blocks(w.resource.tenantId, w.connectionId)).toEqual([]);
  });

  it("bounds each Google call by the time the run has left", async () => {
    const w = await world({ delayMs: 400 });
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(w.google, w.clock);
    // 50 ms left: the 10 s request timeout would outlast the run, so the call ends with the deadline.
    const started = Date.now();
    expect(await worker.runOnce({ deadline: new Date(START + 50) })).toMatchObject({ synced: 0, syncFailed: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({ lease_until: null, last_error: "run_deadline" });
  });

  it("bounds a token refresh by the time the run has left", async () => {
    const w = await world();
    w.google.fail("refreshAccessToken", () => new Promise<void>(() => {}));
    const worker = h.worker(w.google, w.clock, { requestTimeoutMs: 400 });
    const started = Date.now();
    expect(await worker.runOnce({ deadline: new Date(START + 40) })).toMatchObject({ synced: 0, syncFailed: 1 });
    expect(Date.now() - started).toBeLessThan(400);
    expect(await h.connectionRow(w.resource.tenantId, w.connectionId)).toMatchObject({ lease_until: null, last_error: "run_deadline" });
  });

  it("a disconnect starts no Google call once the run has no time left, and goes back as it was", async () => {
    const w = await world();
    w.google.put(w.token, timed("busy", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(w.google, w.clock, { webhookUrl: WEBHOOK_URL });
    await worker.runOnce();
    await h.service((tx) => tx.query("UPDATE calendar_connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
      [w.resource.tenantId, w.connectionId, w.clock.now()]));
    // The refresh for the channel stop uses up the run: no stop and no revoke.
    w.google.reset();
    w.google.fail("refreshAccessToken", () => { w.clock.advance(MINUTE); });
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + 1_000) }))
      .toMatchObject({ disconnected: 0, disconnectRetries: 0, deadlineStops: 1 });
    expect(w.google.count("stopChannel")).toBe(0);
    expect(w.google.count("revoke")).toBe(0);
    let row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ status: "disconnecting", lease_until: null, last_error: null });
    expect(row.refresh_token_sealed).not.toBeNull();
    expect((await h.blocks(w.resource.tenantId)).length).toBe(1);
    // The channel stop uses up the run: no revoke.
    w.google.reset();
    w.google.fail("stopChannel", () => { w.clock.advance(MINUTE); });
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + 1_000) }))
      .toMatchObject({ disconnected: 0, channelsStopped: 1, deadlineStops: 1 });
    expect(w.google.count("revoke")).toBe(0);
    row = await h.connectionRow(w.resource.tenantId, w.connectionId);
    expect(row).toMatchObject({ status: "disconnecting", lease_until: null });
    // The next run finishes it.
    expect((await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + MINUTE) })).disconnected).toBe(1);
  });

  it("a push starts no insert once the run has no time left, and goes back with its attempt", async () => {
    const w = await world();
    const worker = h.worker(w.google, w.clock);
    await worker.runOnce();
    // Not due for a sync, so the push step refreshes the token itself.
    w.clock.advance(MINUTE);
    const bookingId = await h.booking(w.resource, "2026-10-22T10:00:00.000Z");
    w.google.reset();
    w.google.fail("refreshAccessToken", () => { w.clock.advance(MINUTE); });
    expect(await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + 1_000) }))
      .toMatchObject({ pushesQueued: 1, pushed: 0, pushRetries: 0, pushesFailed: 0 });
    expect(w.google.count("insertEvent")).toBe(0);
    expect(await h.push(w.resource.tenantId, bookingId)).toMatchObject({ status: "pending", attempts: 0, lease_until: null, last_error: null });
    expect((await worker.runOnce({ deadline: new Date(w.clock.now().getTime() + MINUTE) })).pushed).toBe(1);
  });
});

describe("tenancy and concurrency (G-11)", () => {
  it("tenant A's sync never touches tenant B's blocks", async () => {
    const a = await world();
    const clock = a.clock;
    const tenantB = await h.tenant();
    const resourceB = await h.resource(tenantB);
    const tokenB = a.google.account();
    a.google.put(tokenB, timed("shared-id", "2026-10-21T14:00:00Z", "2026-10-21T15:00:00Z"));
    const connectionB = await h.connection(resourceB, tokenB, START);
    a.google.put(a.token, timed("shared-id", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
    const worker = h.worker(a.google, clock);
    expect((await worker.runOnce()).synced).toBe(2);
    const before = await h.blocks(tenantB);
    expect(spans(before)).toEqual([["shared-id", "2026-10-21T14:00:00.000Z", "2026-10-21T15:00:00.000Z"]]);
    // Only A is due: a full replace and an incremental delete of the same event ID in A.
    await h.service((tx) => tx.query("UPDATE calendar_connections SET next_sync_at=$3 WHERE tenant_id=$1 AND id=$2",
      [tenantB, connectionB, new Date(START + 365 * DAY)]));
    a.google.cancel(a.token, "shared-id");
    clock.advance(15 * MINUTE);
    expect((await worker.runOnce()).synced).toBe(1);
    expect(await h.blocks(a.resource.tenantId)).toEqual([]);
    a.google.expireSyncTokens(a.token);
    clock.advance(15 * MINUTE);
    expect((await worker.runOnce()).synced).toBe(1);
    expect(await h.blocks(tenantB)).toEqual(before);
    // The runtime role in tenant A cannot see B's blocks either.
    const seen = await h.database.db.tenant(a.resource.tenantId, (tx) => tx.query("SELECT 1 FROM booking_external_blocks WHERE tenant_id=$1", [tenantB]));
    expect(seen.rowCount).toBe(0);
  });

  it("two passes at once never double-apply or double-push", async () => {
    const clock = manualClock();
    const google = stubGoogle(clock, { delayMs: 5 });
    const connections: Array<{ resource: Resource; token: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      const tenantId = await h.tenant();
      const resource = await h.resource(tenantId);
      const token = google.account();
      google.put(token, timed(`e${index}`, "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"));
      await h.connection(resource, token, START);
      await h.booking(resource, "2026-10-22T10:00:00.000Z");
      await h.booking(resource, "2026-10-22T12:00:00.000Z");
      connections.push({ resource, token });
    }
    const one = h.worker(google, clock, { claimLimit: 2, pushLimit: 3 });
    const two = h.worker(google, clock, { claimLimit: 2, pushLimit: 3 });
    const results = await Promise.all([one.runOnce(), two.runOnce(), one.runOnce(), two.runOnce()]);
    const total = (key: keyof (typeof results)[number]) => results.reduce((sum, counts) => sum + counts[key], 0);
    expect(total("synced")).toBe(4);
    expect(total("pushed")).toBe(8);
    expect(total("pushesQueued")).toBe(8);
    expect(total("lostLeases")).toBe(0);
    expect(google.count("listEvents")).toBe(4);
    const ids = google.of("insertEvent").map((args) => (args[2] as NewGoogleEvent).id);
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(8);
    for (const { resource } of connections) expect((await h.blocks(resource.tenantId)).length).toBe(1);
  });
});
