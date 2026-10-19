// stdio entry point: the only module here that reads process.env or the system clock.
// DATABASE_URL logs in as the unprivileged runtime role. ZS_ACCESS_TOKEN is a member's
// Supabase access token, verified with the JWT_* settings the API uses and its session checked
// with the same SESSION_CHECK settings; every tool call re-verifies it and re-checks the session
// and membership, like an HTTP request.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSessionCheckFromConfig, createVerifierFromConfig, parseJwtEnv, parseSessionCheckEnv } from "@zs/core";
import { assertLocalDatabaseUrl, assertRuntimeLogin, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createMcpServer } from "./server.js";

const env = z.object({
  DATABASE_URL: z.string().min(1),
  ZS_ACCESS_TOKEN: z.string().min(1),
}).parse(process.env);
const jwt = parseJwtEnv(process.env);
const sessionCheckConfig = parseSessionCheckEnv(process.env);
// The local auth stub exists only on loopback databases.
if (sessionCheckConfig.method === "local-stub") assertLocalDatabaseUrl(env.DATABASE_URL);
const clock = { now: () => new Date() };
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
const db = createScopedDatabase(pool);
const server = createMcpServer({
  db,
  clock,
  generateId: randomUUID,
  verifier: createVerifierFromConfig(jwt, clock),
  sessionCheck: createSessionCheckFromConfig(sessionCheckConfig, { db, clock }),
  accessToken: env.ZS_ACCESS_TOKEN,
});
await server.connect(new StdioServerTransport());
const shutdown = async () => {
  await server.close();
  await pool.end();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
