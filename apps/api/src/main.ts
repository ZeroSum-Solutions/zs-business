// The only module that reads process.env or the system clock for the server.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { serve } from "@hono/node-server";
import { assertRuntimeLogin, checkDatabase, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createApp } from "./app.js";
import { createSessionCheckFromConfig } from "@zs/core";
import { createVerifierFromConfig } from "./auth.js";
import { parseServerEnv } from "./config.js";

const env = parseServerEnv(process.env);
const clock = { now: () => new Date() };
// DATABASE_URL must log in as the unprivileged runtime role (for example zs_runtime).
const pool = createRuntimePool({
  connectionString: env.databaseUrl,
  max: env.poolMax,
  connectionTimeoutMs: env.connectTimeoutMs,
  applicationName: "zs-api",
  // A lost idle connection is logged and replaced; it must not end the process.
  onError: ({ code, message }) => console.error("Database pool error", code ?? "", message),
});
await assertRuntimeLogin(pool).catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const db = createScopedDatabase(pool);
const app = createApp({
  verifier: createVerifierFromConfig(env.jwt, clock),
  sessionCheck: createSessionCheckFromConfig(env.sessionCheck, { db, clock }),
  clock,
  db,
  generateId: randomUUID,
  config: { allowedOrigins: env.allowedOrigins, requestTimeoutMs: env.requestTimeoutMs },
  onError: (error) => console.error("Unhandled API error", error),
  ready: () => checkDatabase(pool),
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`zs-business API listening on http://localhost:${info.port}`);
});
const shutdown = () => {
  server.close();
  void pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
