// hub-access.md H-7, H-8: the limits on POST /mcp are one count in Postgres, shared by every API
// instance. Two apps over two connection pools to one database take turns serving a token; the
// 121st request inside a minute and the 2,001st inside an hour are 429 with Retry-After, whichever
// instance gets them. Usage rows count what happened. The clock is injected and moved by hand.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { automationTokenWithSecretSchema, automationUsageSchema, apiErrorBodySchema } from "@zs/contracts";
import { createScopedDatabase } from "@zs/db";
import { appOnDatabase, call, createApiHarness, NOW, type ApiHarness } from "./helpers.js";

const MINUTE = 60_000;
let h: ApiHarness;
let second: ReturnType<typeof appOnDatabase>;
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs) };
const pools: Pool[] = [];

beforeAll(async () => {
  h = await createApiHarness({ clock, activepieces: {} });
  const pool = new Pool({ connectionString: h.database.runtimePool.options.connectionString, max: 4 });
  pool.on("error", () => undefined);
  pools.push(pool);
  second = appOnDatabase(createScopedDatabase(pool), { clock });
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await h?.close();
});

async function mint() {
  const response = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
    token: h.a.token, key: randomUUID(), body: { name: "Busy agent", scopes: ["business:read"] },
  });
  expect(response.status).toBe(201);
  return automationTokenWithSecretSchema.parse(response.body);
}
let id = 0;
const ping = (app: ApiHarness["app"], secret: string) =>
  app.fetch(new Request("http://hub.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "ping" }),
  }));
const usageOf = async (tokenId: string) =>
  automationUsageSchema.parse((await call(h.app, "GET", `/v1/integrations/activepieces/tokens/${tokenId}/usage`, { token: h.a.token })).body);

describe("rate limits across two API instances (H-7)", () => {
  it("refuses the 121st request inside a minute with 429 and Retry-After, on either instance, and reopens after the window", async () => {
    const { secret, token } = await mint();
    const apps = [h.app, second];
    // 120 requests, spread over both instances in concurrent groups of 20.
    for (let sent = 0; sent < 120; sent += 20) {
      const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => ping(apps[(sent + i) % 2]!, secret)));
      expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(200));
    }
    for (const app of [h.app, second, h.app]) {
      const refused = await ping(app, secret);
      expect(refused.status).toBe(429);
      expect(apiErrorBodySchema.parse(await refused.json()).error.code).toBe("RateLimited");
      const wait = Number(refused.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
    // Another token has its own buckets.
    expect((await ping(second, (await mint()).secret)).status).toBe(200);
    clockMs += MINUTE + 1000;
    try {
      expect((await ping(second, secret)).status).toBe(200);
      // 120 served, three refusals, then one more served after the window: usage counts every one.
      const usage = await usageOf(token.id);
      expect(usage.totals).toEqual({ requests: 124, reads: 0, proposals: 0, refusals: 3 });
    } finally {
      clockMs = Date.parse(NOW);
    }
  });

  it("refuses the 2,001st request inside an hour, with a Retry-After that names the hour", async () => {
    const { secret, token } = await mint();
    const apps = [h.app, second];
    let sent = 0;
    // 2,000 requests over 20 minutes: the minute bucket reopens between batches, the hour bucket does not.
    for (let batch = 0; batch < 20; batch++) {
      for (let group = 0; group < 5; group++) {
        const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => ping(apps[(sent + i) % 2]!, secret)));
        sent += 20;
        expect(replies.filter((reply) => reply.status !== 200)).toEqual([]);
      }
      clockMs += MINUTE + 1000;
    }
    expect(sent).toBe(2000);
    try {
      for (const app of [second, h.app]) {
        const refused = await ping(app, secret);
        expect(refused.status).toBe(429);
        // Not the minute bucket (at most 60 s): the hour has about 40 minutes left.
        const wait = Number(refused.headers.get("retry-after"));
        expect(wait).toBeGreaterThan(2000);
        expect(wait).toBeLessThanOrEqual(3600);
      }
      const usage = await usageOf(token.id);
      expect(usage.totals).toEqual({ requests: 2002, reads: 0, proposals: 0, refusals: 2 });
    } finally {
      clockMs = Date.parse(NOW);
    }
  }, 180_000);
});
