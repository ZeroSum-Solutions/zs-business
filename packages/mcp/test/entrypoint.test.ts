// Runs the real stdio entry point: the pool it builds must survive a lost idle connection.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";

const MCP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

let database: TestDatabase;
let fixture: TwoTenantFixture;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
}, 60_000);
afterAll(async () => {
  await database?.close();
});

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
      ZS_TENANT_ID: fixture.a.tenantId,
      ZS_ACTOR_ID: randomUUID(),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let closed = false;
  transport.onclose = () => { closed = true; };
  const client = new Client({ name: "entrypoint-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const first = await client.callTool({ name: "list_resources", arguments: {} }) as CallToolResult;
    expect(first.isError, JSON.stringify(first)).toBeFalsy();
    // Only the child logs in as the runtime role in this database; end its idle connection.
    const { rows } = await database.pool.query<{ n: number }>(
      `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND usename = 'zs_runtime'`,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(closed, stderr).toBe(false);
    expect(stderr).toContain("57P01");
    const second = await client.callTool({ name: "list_resources", arguments: {} }) as CallToolResult;
    expect(second.isError, JSON.stringify(second)).toBeFalsy();
  } finally {
    await client.close();
  }
}, 30_000);
