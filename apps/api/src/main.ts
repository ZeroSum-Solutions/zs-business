// The only module that reads process.env or the system clock for the server.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { assertRuntimeLogin, createScopedDatabase } from "@zs/db";
import { createApp } from "./app.js";
import { createHs256Verifier } from "./auth.js";
import { parseServerEnv } from "./config.js";

const env = parseServerEnv(process.env);
const clock = { now: () => new Date() };
// DATABASE_URL must log in as the unprivileged runtime role (for example zs_runtime).
const pool = new Pool({ connectionString: env.databaseUrl, max: 10 });
await assertRuntimeLogin(pool).catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const app = createApp({
  verifier: createHs256Verifier(env.jwtSecret, {
    clock,
    maxLifetimeSeconds: env.jwtMaxLifetimeSeconds,
    clockSkewSeconds: env.jwtClockSkewSeconds,
    ...(env.jwtIssuer === undefined ? {} : { issuer: env.jwtIssuer }),
  }),
  clock,
  db: createScopedDatabase(pool),
  generateId: randomUUID,
  config: { allowedOrigins: env.allowedOrigins },
  onError: (error) => console.error("Unhandled API error", error),
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
