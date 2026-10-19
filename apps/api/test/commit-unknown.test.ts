import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, createOrFindContactOutputSchema } from "@zs/contracts";
import { createRuntimePool, createScopedDatabase, DatabaseUnavailable, type ScopedDatabase } from "@zs/db";
import { createApp, createHs256Verifier } from "../src/app.js";
import { call, clock, createApiHarness, ORIGIN, SECRET, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

/**
 * A TCP proxy to the test database, as the runtime login, that passes a connection's COMMIT on
 * to Postgres but never passes the answer back: the commit happens and its reply is lost.
 */
async function commitReplyLosingProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    let stalled = false;
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      // The simple-query message for COMMIT ends in its NUL; "READ COMMITTED" does not match.
      if (chunk.includes("COMMIT\0")) stalled = true;
    });
    upstream.on("data", (chunk) => { if (!stalled) client.write(chunk); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(databaseUrl);
  url.username = "zs_runtime";
  url.password = "";
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.href,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("a COMMIT whose reply is lost at the deadline", () => {
  it("answers 503, reports the outcome as unknown, and the retry with the same key replays the committed contact", async () => {
    const proxy = await commitReplyLosingProxy(h.database.url);
    const pool = createRuntimePool({ connectionString: proxy.url, max: 2, connectionTimeoutMs: 2000, onError: () => undefined });
    const inner = createScopedDatabase(pool);
    const failures: unknown[] = [];
    const db: ScopedDatabase = {
      tenant: (tenantId, work, options) => inner.tenant(tenantId, work, options)
        .catch((error: unknown) => { failures.push(error); throw error; }),
    };
    const stalling = createApp({
      verifier: createHs256Verifier(SECRET, { clock }),
      clock,
      db,
      generateId: randomUUID,
      config: { allowedOrigins: [ORIGIN], requestTimeoutMs: 500 },
    });
    try {
      const key = randomUUID();
      const body = { displayName: "Lost Reply", email: "lost-reply@example.com" };
      const first = await call(stalling, "POST", "/v1/crm/contacts", { token: h.a.token, key, body });
      expect(first.status).toBe(503);
      expect(apiErrorBodySchema.parse(first.body).error.code).toBe("Unavailable");
      // The transaction says its COMMIT may have applied, not that nothing committed.
      await expect.poll(() => failures.length, { timeout: 1000, interval: 50 }).toBe(1);
      expect(failures[0]).toBeInstanceOf(DatabaseUnavailable);
      expect((failures[0] as DatabaseUnavailable).reason).toBe("commit_unknown");

      // It did apply.
      const rows = await h.database.pool.query<{ id: string }>(
        "SELECT id FROM crm_contacts WHERE tenant_id = $1 AND normalized_email = $2",
        [h.a.tenantId, body.email],
      );
      expect(rows.rows).toHaveLength(1);

      // The caller retries with the same key and gets the committed contact, not a second write.
      const retried = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key, body });
      expect(retried.status).toBe(201);
      const replayed = createOrFindContactOutputSchema.parse(retried.body).result;
      expect(replayed).toMatchObject({ created: true, contact: { id: rows.rows[0]!.id } });
      const after = await h.database.pool.query(
        "SELECT 1 FROM crm_contacts WHERE tenant_id = $1 AND normalized_email = $2",
        [h.a.tenantId, body.email],
      );
      expect(after.rowCount).toBe(1);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  });
});
