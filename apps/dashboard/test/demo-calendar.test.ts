// The demo adapter's Google Calendar connections keep the API's rules (google-calendar.md G-1,
// G-4, G-5): owners connect and disconnect, staff only read, a connect key names one connection,
// and a resource has at most one connection that is active or needs reconnecting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarConnectionListSchema, calendarConnectionSchema } from "@zs/contracts";
import { demoErrorBody, type ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_CALENDAR_WORKER_MS, DEMO_GOOGLE_ACCOUNT } from "../src/lib/api/demo/calendar";
import { DEMO_RESOURCES } from "../src/lib/api/demo/seed";
import { currentConnection } from "../src/lib/calendar-sync";

const NOW = new Date("2026-10-20T13:00:00.000Z");
const [SHOWROOM, REPAIR] = DEMO_RESOURCES.map((resource) => resource.id) as [string, string];
const FOREIGN = "0b0b0b0b-1c1c-4d2d-8e3e-4f4f4f4f4f4f";

function adapter() {
  let ids = 0;
  let clock = NOW;
  const api = createDemoAdapter({
    clock: { now: () => clock },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return Object.assign(api, { advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } });
}

let keys = 0;
const key = () => ({ idempotencyKey: `calendar-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const list = async (api: ReturnType<typeof adapter>) => calendarConnectionListSchema.parse({ items: await api.listCalendarConnections() }).items;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo adapter: Google Calendar connections", () => {
  it("starts with no connections", async () => {
    expect(await list(adapter())).toEqual([]);
  });

  it("connects a resource with the made-up account and sends the page back to Connections", async () => {
    const api = adapter();
    expect(await api.startGoogleConnect(SHOWROOM, key())).toEqual({ authorizeUrl: "http://127.0.0.1/account/connections?calendar=connected" });
    const [connection] = await list(api);
    expect(connection).toMatchObject({
      provider: "google", resourceId: SHOWROOM, calendarId: "primary", accountEmail: DEMO_GOOGLE_ACCOUNT,
      status: "active", lastSyncedAt: null, lastError: null, createdAt: NOW.toISOString(),
    });
    expect(DEMO_GOOGLE_ACCOUNT).toMatch(/@haldenrowe\.example$/);
    // The worker's first sync, once its delay has passed.
    api.advance(DEMO_CALENDAR_WORKER_MS);
    expect((await list(api))[0]!.lastSyncedAt).toBe(new Date(NOW.getTime() + DEMO_CALENDAR_WORKER_MS).toISOString());
  });

  it("answers on the page's own origin when there is one", async () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:3217" });
    expect((await adapter().startGoogleConnect(REPAIR, key())).authorizeUrl).toBe("http://127.0.0.1:3217/account/connections?calendar=connected");
  });

  it("lets a key name one connection: the same resource replays, another resource or a retired one is a 409", async () => {
    const api = adapter();
    const first = key();
    await api.startGoogleConnect(SHOWROOM, first);
    await api.startGoogleConnect(SHOWROOM, first);
    expect(await list(api)).toHaveLength(1);
    expect(await failure(api.startGoogleConnect(REPAIR, first))).toMatchObject({ kind: "conflict", status: 409, reason: "idempotency_key_reused" });
    await api.disconnectCalendar((await list(api))[0]!.id, key());
    expect(await failure(api.startGoogleConnect(SHOWROOM, first))).toMatchObject({ kind: "conflict", reason: "idempotency_key_reused" });
  });

  it("reconnecting retires the resource's older connection beside the new one (G-4)", async () => {
    const api = adapter();
    await api.startGoogleConnect(SHOWROOM, key());
    api.loseCalendarGrant(SHOWROOM);
    const [lost] = await list(api);
    expect(lost).toMatchObject({ status: "reauthorize", lastError: "invalid_grant" });
    api.advance(1000);
    await api.startGoogleConnect(SHOWROOM, key());
    const items = await list(api);
    expect(items.map((item) => item.status)).toEqual(["disconnecting", "active"]);
    expect(items.filter((item) => item.status === "active" || item.status === "reauthorize")).toHaveLength(1);
    expect(currentConnection(items, SHOWROOM)?.id).toBe(items[1]!.id);
    expect(currentConnection(items, REPAIR)).toBeNull();
  });

  it("refuses a staff member with the API's 403 body, but lets them read", async () => {
    const api = adapter();
    await api.startGoogleConnect(SHOWROOM, key());
    const [connection] = await list(api);
    api.actAs("staff");
    const connect = await failure(api.startGoogleConnect(REPAIR, key()));
    const disconnect = await failure(api.disconnectCalendar(connection!.id, key()));
    for (const error of [connect, disconnect]) {
      expect(error).toMatchObject({ kind: "forbidden", status: 403, code: "Forbidden" });
      expect(error!.details).toEqual(demoErrorBody("Forbidden").error.details);
    }
    expect(await list(api)).toEqual([connection]);
  });

  it("checks in the API's order: no Google settings, then the body, then the resource", async () => {
    const api = adapter();
    expect(await failure(api.startGoogleConnect("not-a-uuid", key()))).toMatchObject({ kind: "validation", status: 400 });
    expect(await failure(api.startGoogleConnect(FOREIGN, key()))).toMatchObject({ kind: "forbidden", status: 403 });
    api.setGoogleCalendarConfigured(false);
    expect(await failure(api.startGoogleConnect("not-a-uuid", key()))).toMatchObject({ kind: "not_found", status: 404 });
    api.setGoogleCalendarConfigured(true);
    await expect(api.startGoogleConnect(SHOWROOM, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(await list(api)).toEqual([]);
  });

  it("disconnects to disconnecting, replays the same key, and the worker finishes on a later list", async () => {
    const api = adapter();
    await api.startGoogleConnect(SHOWROOM, key());
    const [connection] = await list(api);
    const disconnectKey = key();
    const result = calendarConnectionSchema.parse(await api.disconnectCalendar(connection!.id, disconnectKey));
    expect(result).toMatchObject({ id: connection!.id, status: "disconnecting" });
    expect(await api.disconnectCalendar(connection!.id, disconnectKey)).toEqual(result);
    expect((await list(api))[0]!.status).toBe("disconnecting");
    api.advance(DEMO_CALENDAR_WORKER_MS - 1);
    expect((await list(api))[0]!.status).toBe("disconnecting");
    api.advance(1);
    const items = await list(api);
    expect(items[0]!.status).toBe("disconnected");
    expect(currentConnection(items, SHOWROOM)).toBeNull();
    // G-5: a retired connection answers as it is.
    expect(await api.disconnectCalendar(connection!.id, key())).toMatchObject({ status: "disconnected" });
    expect(api.writeLog().filter((write) => write.operation === "calendar.google.disconnect").map((write) => write.outcome))
      .toEqual(["applied", "replayed", "applied"]);
  });

  it("disconnects a connection that needs reconnecting, and says not found for an unknown one", async () => {
    const api = adapter();
    await api.startGoogleConnect(REPAIR, key());
    api.loseCalendarGrant(REPAIR);
    const [connection] = await list(api);
    expect(await api.disconnectCalendar(connection!.id, key())).toMatchObject({ status: "disconnecting" });
    expect(await failure(api.disconnectCalendar(FOREIGN, key()))).toMatchObject({ kind: "not_found", status: 404 });
    expect(await failure(api.disconnectCalendar("../connect", key()))).toMatchObject({ kind: "validation", status: 400 });
  });
});
