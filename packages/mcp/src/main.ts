// stdio entry point: the only module here that reads process.env or the system clock.
// DATABASE_URL logs in as the unprivileged runtime role. ZS_ACCESS_TOKEN is a member's
// Supabase access token, verified with the JWT_* settings the API uses; every tool call
// re-verifies it and re-checks the session and membership, like an HTTP request.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool } from "pg";
import { z } from "zod";
import { createVerifierFromConfig, parseJwtEnv } from "@zs/core";
import { assertRuntimeLogin, createScopedDatabase } from "@zs/db";
import { createMcpServer } from "./server.js";

const env = z.object({
  DATABASE_URL: z.string().min(1),
  ZS_ACCESS_TOKEN: z.string().min(1),
}).parse(process.env);
const jwt = parseJwtEnv(process.env);
const clock = { now: () => new Date() };
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
await assertRuntimeLogin(pool).catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const server = createMcpServer({
  db: createScopedDatabase(pool),
  clock,
  generateId: randomUUID,
  verifier: createVerifierFromConfig(jwt, clock),
  accessToken: env.ZS_ACCESS_TOKEN,
});
await server.connect(new StdioServerTransport());
const shutdown = async () => {
  await server.close();
  await pool.end();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
