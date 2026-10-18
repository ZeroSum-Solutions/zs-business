import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertRuntimeLogin, createScopedDatabase } from "@zs/db";
import { createApp } from "./app.js";
import { createHs256Verifier } from "./auth.js";
import type { ServerEnv } from "./config.js";

/**
 * Builds the runtime pool and the app from a parsed environment, for the Node server
 * (main.ts) and the Vercel function (vercel.ts). Returns only after the pool's login passes
 * assertRuntimeLogin, so a misconfigured DATABASE_URL never serves a request.
 */
export async function createServer(env: ServerEnv, clock: { now(): Date }) {
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
  });
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
  return { app, pool };
}
