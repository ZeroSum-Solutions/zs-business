import { randomUUID } from "node:crypto";
import { assertRuntimeLogin, checkDatabase, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createApp, DEFAULT_RATE_LIMITS, type PublicIntakeConfig, type RateLimits } from "./app.js";
import { createHs256Verifier } from "./auth.js";
import type { ServerEnv } from "./config.js";

/**
 * Builds the runtime pool and the app from a parsed environment, for the Node server
 * (main.ts) and the Vercel function (vercel.ts). Returns only after the pool's login passes
 * assertRuntimeLogin, so a misconfigured DATABASE_URL never serves a request.
 */
export async function createServer(env: ServerEnv, clock: { now(): Date }) {
  const pool = createRuntimePool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    connectionTimeoutMs: env.connectTimeoutMs,
    applicationName: "zs-api",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    // A lost idle connection is logged and replaced; it must not end the process.
    onError: ({ code, message }) => console.error("Database pool error", code ?? "", message),
  });
  await assertRuntimeLogin(pool).catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const publicIntake: PublicIntakeConfig | undefined = env.publicIntake === null ? undefined : {
    keySecrets: env.publicIntake.keySecrets,
    publicBaseUrl: env.publicIntake.publicBaseUrl,
    clientIp: env.publicIntake.clientIp,
    limits: Object.fromEntries(Object.entries(env.publicIntake.limitOverrides).map(([name, limit]) =>
      [name, { ...DEFAULT_RATE_LIMITS[name as keyof RateLimits], limit }])),
  };
  const app = createApp({
    verifier: createHs256Verifier(env.jwtSecret, {
      clock,
      maxLifetimeSeconds: env.jwtMaxLifetimeSeconds,
      clockSkewSeconds: env.jwtClockSkewSeconds,
      ...(env.jwtIssuer === undefined ? {} : { issuer: env.jwtIssuer }),
    }),
    clock,
    db: createScopedDatabase(pool, {
      // Hosted, the runtime URL is Supavisor's transaction pooler (port 6543), where a
      // backend cancel could stop another request's statement. Never "backend" here.
      cancel: "none",
      // A failed reset discards the connection; say so, since a pattern of them means trouble.
      onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
    }),
    generateId: randomUUID,
    config: { allowedOrigins: env.allowedOrigins, requestTimeoutMs: env.requestTimeoutMs },
    ...(publicIntake === undefined ? {} : { publicIntake }),
    onError: (error) => console.error("Unhandled API error", error),
    ready: () => checkDatabase(pool),
  });
  return { app, pool };
}
