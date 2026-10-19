// stdio entry point: the only module here that reads process.env or the system clock.
// DATABASE_URL logs in as the unprivileged runtime role; ZS_TENANT_ID and ZS_ACTOR_ID fix
// the principal for the whole process.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createMcpServer } from "./server.js";

const env = z.object({
  DATABASE_URL: z.string().min(1),
  ZS_TENANT_ID: z.uuid(),
  ZS_ACTOR_ID: z.uuid(),
}).parse(process.env);
// stdout carries the MCP protocol, so pool errors go to stderr. A lost idle connection is
// logged and replaced; it must not end the process.
const pool = createRuntimePool({
  connectionString: env.DATABASE_URL,
  max: 4,
  connectionTimeoutMs: 5000,
  applicationName: "zs-mcp",
  onError: ({ code, message }) => console.error("Database pool error", code ?? "", message),
});
await assertRuntimeLogin(pool).catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const server = createMcpServer({
  db: createScopedDatabase(pool),
  clock: { now: () => new Date() },
  generateId: randomUUID,
  principal: { tenantId: env.ZS_TENANT_ID, actorId: env.ZS_ACTOR_ID },
});
await server.connect(new StdioServerTransport());
const shutdown = async () => {
  await server.close();
  await pool.end();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
