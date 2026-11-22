// Runs the real stdio entry point: the pool it builds must survive a lost idle connection.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, it, onTestFailed, onTestFinished } from "vitest";
import {
  createTestDatabase,
  createTwoTenantFixture,
  startAuthSession,
  upsertAuthUser,
  type TestDatabase,
  type TwoTenantFixture,
} from "@zs/db/testing";

const MCP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const SECRET = ["entry", "point", "x".repeat(32)].join("-");

let database: TestDatabase;
let fixture: TwoTenantFixture;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
}, 60_000);
afterAll(async () => {
  await database?.close();
});

/** A live owner of tenant A and a token for them, signed for the child's real clock. */
async function ownerToken(): Promise<string> {
  const tenantId = fixture.a.tenantId;
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
  const actorId = await upsertAuthUser(database.pool, { email, appMetadata: { tenant_id: tenantId } });
  const sessionId = await startAuthSession(database.pool, actorId);
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner',now(),now())",
    [tenantId, randomUUID(), email, actorId],
  ));
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: "authenticated", session_id: sessionId, app_metadata: { tenant_id: tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(actorId).setAudience("authenticated")
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 600)
    .sign(new TextEncoder().encode(SECRET));
}

it("keeps serving tools after its idle database connection is terminated", async () => {
  const url = new URL(database.url);
  url.username = "zs_runtime";
  let stderr = "";
  const transport = new StdioClientTransport({
    command: TSX,
    args: ["src/main.ts"],
    cwd: MCP_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url.href,
      JWT_VERIFIER: "hs256",
      JWT_SECRET: SECRET,
      SESSION_CHECK: "local-stub",
      ZS_ACCESS_TOKEN: await ownerToken(),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let closed = false;
  transport.onclose = () => { closed = true; };
  const client = new Client({ name: "entrypoint-test", version: "0.0.0" });
  // Closing the client ends the child, however the test ends.
  onTestFinished(() => client.close());
  onTestFailed(() => { console.error(`MCP child stderr:\n${stderr}`); });
  // The SDK's own 60 s request timeout could end a slow start; the test's timeout bounds it instead.
  const slow = { timeout: 170_000 };
  await client.connect(transport, slow);
  // Only the child logs in as the runtime role in this database; end its idle connection. The
  // pool closes a connection after 10 s idle, which a slow machine can outlast between the call
  // and the terminate, so call again until a terminate finds one. Only the count matters.
  const terminate = async () => (await database.pool.query<{ n: number }>(
    `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'zs_runtime'`,
  )).rows[0]?.n ?? 0;
  do {
    const first = await client.callTool({ name: "list_resources", arguments: {} }, undefined, slow) as CallToolResult;
    expect(first.isError, JSON.stringify(first)).toBeFalsy();
  } while (await terminate() === 0);
  // The pool logs the lost connection (57P01) and the child carries on to serve below.
  while (!stderr.includes("57P01")) {
    if (closed) throw new Error(`MCP child exited before logging 57P01: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(closed, stderr).toBe(false);
  const second = await client.callTool({ name: "list_resources", arguments: {} }, undefined, slow) as CallToolResult;
  expect(second.isError, JSON.stringify(second)).toBeFalsy();
  // Starting tsx and the child takes tens of seconds on a busy machine; nothing here is timed.
}, 180_000);
