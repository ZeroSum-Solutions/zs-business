// The calendar worker end to end over the real HTTP client (google.ts) and the in-process fake
// Google server: sync, push, channel, incremental change, disconnect.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createCalendarWorker, createGoogleClient, verifyChannelToken } from "../../src/index.js";
import { createFakeGoogle, type FakeGoogle } from "./fake-google.js";
import { CHANNEL_SECRET, createCalendarHarness, manualClock, START, WEBHOOK_URL, type CalendarHarness } from "./worker-stub.js";

const MINUTE = 60_000;
let h: CalendarHarness;
let fake: FakeGoogle;
const clock = manualClock();
beforeAll(async () => {
  h = await createCalendarHarness();
  fake = await createFakeGoogle({ clock });
});
afterAll(async () => {
  await fake?.close();
  await h?.close();
});

it("syncs, pushes, watches, follows a change and disconnects through the real client", async () => {
  await h.retireAll();
  const tenantId = await h.tenant();
  const resource = await h.resource(tenantId);
  const grant = fake.issueGrant();
  const connectionId = await h.connection(resource, grant.refreshToken, START);
  const calendar = fake.calendar("primary");
  calendar.put({ id: "meeting01", start: { dateTime: "2026-10-21T10:00:00Z" }, end: { dateTime: "2026-10-21T11:00:00Z" } });
  calendar.put({ id: "focus001", transparency: "transparent", start: { dateTime: "2026-10-21T12:00:00Z" }, end: { dateTime: "2026-10-21T13:00:00Z" } });
  const bookingId = await h.booking(resource, "2026-10-22T10:00:00.000Z");

  const worker = createCalendarWorker({
    service: (work) => asService(h.database.servicePool, work),
    google: createGoogleClient({ config: fake.clientConfig() }),
    clock,
    generateId: randomUUID,
    config: { privateKey: h.privateKey, channelSecret: CHANNEL_SECRET, webhookUrl: WEBHOOK_URL },
  });

  expect(await worker.runOnce()).toMatchObject({ synced: 1, syncFailed: 0, channelsOpened: 1, pushed: 1 });
  expect((await h.blocks(tenantId)).map((block) => block.external_id)).toEqual(["meeting01"]);
  const pushedEvent = calendar.get(bookingId.replaceAll("-", ""));
  expect(pushedEvent?.extendedProperties?.private).toEqual({ zs_booking: bookingId, zs_tenant: tenantId });
  expect((await h.push(tenantId, bookingId)).status).toBe("pushed");
  const row = await h.connectionRow(tenantId, connectionId);
  const channel = fake.channel(row.channel_id as string)!;
  expect(channel.address).toBe(WEBHOOK_URL);
  expect(verifyChannelToken(CHANNEL_SECRET, channel.id, channel.token ?? undefined)).toBe(true);
  expect(row.sync_token).not.toBeNull();

  // Google-side delete and a move: the incremental list follows; our own event stays out.
  calendar.remove("meeting01");
  calendar.put({ id: "lunch001", start: { dateTime: "2026-10-23T12:00:00Z" }, end: { dateTime: "2026-10-23T13:00:00Z" } });
  clock.advance(15 * MINUTE);
  expect((await worker.runOnce()).synced).toBe(1);
  expect(fake.requestsTo("list").at(-1)!.query.syncToken).toBe(row.sync_token);
  expect((await h.blocks(tenantId)).map((block) => block.external_id)).toEqual(["lunch001"]);

  // An expired sync token: 410, then a full list in the same pass.
  fake.expireSyncTokens();
  clock.advance(15 * MINUTE);
  expect((await worker.runOnce()).synced).toBe(1);
  expect((await h.blocks(tenantId)).map((block) => block.external_id)).toEqual(["lunch001"]);

  await h.database.db.tenant(tenantId, (tx) => tx.query(
    "UPDATE calendar_connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
    [tenantId, connectionId, clock.now()]));
  expect((await worker.runOnce()).disconnected).toBe(1);
  expect(fake.channel(channel.id)!.stopped).toBe(true);
  expect(fake.grants().find((entry) => entry.id === grant.grantId)!.revoked).toBe(true);
  expect(await h.blocks(tenantId)).toEqual([]);
  expect(await h.connectionRow(tenantId, connectionId)).toMatchObject({ status: "disconnected", refresh_token_sealed: null });
});
