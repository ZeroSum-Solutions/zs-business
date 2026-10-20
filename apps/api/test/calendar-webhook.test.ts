// POST /webhooks/google/calendar (docs/requirements/google-calendar.md G-8) through the real app:
// the channel token is checked before any database work, and a push is stored once by channel and
// message number in the platform inbox the calendar worker reads.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema } from "@zs/contracts";
import { channelToken, type GoogleClient } from "@zs/core";
import { asService, createRuntimePool, createScopedDatabase } from "@zs/db";
import { clock, createApiHarness, type ApiHarness } from "./helpers.js";
import { calendarApp, CHANNEL_SECRET, googleConfig } from "./calendar-fixtures.js";

const UNAUTHORIZED = { error: { code: "Unauthorized", message: "Invalid channel token", details: {} } };
/** The webhook never calls Google. */
const google = new Proxy({}, { get: () => () => { throw new Error("Google was called"); } }) as GoogleClient;

let h: ApiHarness;
let app: ReturnType<typeof calendarApp>;
beforeAll(async () => {
  h = await createApiHarness();
  app = calendarApp(h, { clock, googleCalendar: googleConfig(google) });
});
afterAll(async () => h?.close());

interface Push {
  channelId?: string | null;
  token?: string | null;
  number?: string | null;
  state?: string | null;
  body?: string;
}
async function push(target: ReturnType<typeof calendarApp>, options: Push = {}) {
  const channelId = options.channelId === undefined ? randomUUID() : options.channelId;
  const token = options.token === undefined ? (channelId ? channelToken(CHANNEL_SECRET, channelId) : null) : options.token;
  const headers: Record<string, string> = {};
  if (channelId !== null) headers["X-Goog-Channel-ID"] = channelId;
  if (token !== null) headers["X-Goog-Channel-Token"] = token;
  const number = options.number === undefined ? "1" : options.number;
  if (number !== null) headers["X-Goog-Message-Number"] = number;
  const state = options.state === undefined ? "sync" : options.state;
  if (state !== null) headers["X-Goog-Resource-State"] = state;
  headers["X-Goog-Resource-ID"] = "fake-resource";
  const response = await target.request("/webhooks/google/calendar", {
    method: "POST", headers, ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as unknown : null };
}
const stored = () => asService(h.database.servicePool, async (tx) => (await tx.query<{
  channel_id: string; message_number: string; resource_state: string; received_at: Date; processed_at: Date | null;
}>("SELECT channel_id, message_number, resource_state, received_at, processed_at FROM calendar_push_notifications ORDER BY channel_id, message_number")).rows);

describe("POST /webhooks/google/calendar (G-8)", () => {
  it("stores a push with a valid channel token once, and answers 200", async () => {
    const channelId = randomUUID();
    const first = await push(app, { channelId, number: "1", state: "sync" });
    expect(first).toMatchObject({ status: 200, body: { received: true, stored: true } });
    const row = (await stored()).filter((found) => found.channel_id === channelId);
    expect(row).toEqual([{ channel_id: channelId, message_number: "1", resource_state: "sync", received_at: clock.now(), processed_at: null }]);
    // Google retries a delivery with the same number; the next change has the next number.
    expect(await push(app, { channelId, number: "1", state: "sync" })).toMatchObject({ status: 200, body: { received: true, stored: false } });
    expect(await push(app, { channelId, number: "2", state: "exists", body: "ignored" })).toMatchObject({ status: 200, body: { stored: true } });
    expect((await stored()).filter((found) => found.channel_id === channelId).map((found) => [found.message_number, found.resource_state]))
      .toEqual([["1", "sync"], ["2", "exists"]]);
    // A channel ID in capitals names the same channel.
    expect(await push(app, { channelId: channelId.toUpperCase(), token: channelToken(CHANNEL_SECRET, channelId), number: "2" }))
      .toMatchObject({ status: 200, body: { stored: false } });
  });

  it("answers 401 with one body for a missing, wrong, foreign or malformed token, storing nothing", async () => {
    const before = await stored();
    const channelId = randomUUID();
    const otherSecret = ["other", "channel", "o".repeat(32)].join("-");
    const right = channelToken(CHANNEL_SECRET, channelId);
    const cases: Push[] = [
      { channelId, token: null },
      { channelId, token: "" },
      { channelId, token: channelToken(otherSecret, channelId) },
      { channelId, token: channelToken(CHANNEL_SECRET, randomUUID()) },
      { channelId, token: `${right.slice(0, -1)}${right.endsWith("A") ? "B" : "A"}` },
      { channelId, token: `${right}x` },
      { channelId, token: "é".repeat(43) },
      { channelId: null, token: right },
      { channelId: "not-a-uuid", token: channelToken(CHANNEL_SECRET, "not-a-uuid") },
    ];
    for (const options of cases) {
      const response = await push(app, options);
      expect(response.status, JSON.stringify(options)).toBe(401);
      expect(response.body).toEqual(UNAUTHORIZED);
    }
    expect(await stored()).toEqual(before);
  });

  it("answers 400 for a signed push with a malformed message number or state", async () => {
    const before = await stored();
    for (const options of [{ number: null }, { number: "-1" }, { number: "1.5" }, { number: "9".repeat(19) }, { state: null }, { state: "EXISTS" }, { state: "x".repeat(41) }]) {
      const response = await push(app, options);
      expect(response.status, JSON.stringify(options)).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
    expect(await stored()).toEqual(before);
  });

  it("refuses a body over the limit with 413", async () => {
    expect((await push(app, { body: "x".repeat(8 * 1024) })).status).toBe(413);
  });

  it("answers 503 when the database is unavailable, so Google delivers again; bad tokens stay 401", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    const pool = createRuntimePool({
      connectionString: `postgres://zs_runtime@127.0.0.1:${port}/postgres`, max: 1, connectionTimeoutMs: 500, onError: () => undefined,
    });
    try {
      const down = calendarApp(h, { clock, googleCalendar: googleConfig(google), db: createScopedDatabase(pool) });
      const channelId = randomUUID();
      const response = await push(down, { channelId, number: "7" });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.body).toEqual({ error: { code: "Unavailable", message: "Service unavailable", details: {} } });
      expect((await push(down, { channelId, token: null })).status).toBe(401);
      // The redelivery is stored once the database is back.
      expect((await push(app, { channelId, number: "7" })).body).toEqual({ received: true, stored: true });
    } finally {
      await pool.end();
    }
  });

  it("is not served without Google config", async () => {
    const off = calendarApp(h, { clock });
    const response = await push(off);
    expect(response.status).toBe(404);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
    expect((await push(h.app)).status).toBe(404);
  });
});
