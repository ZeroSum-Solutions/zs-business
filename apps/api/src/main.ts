// The only module that reads process.env or the system clock for the server.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { serve } from "@hono/node-server";
import { assertRuntimeLogin, checkDatabase, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createApp, DEFAULT_RATE_LIMITS, type PublicIntakeConfig, type RateLimits } from "./app.js";
import { createHs256Verifier } from "./auth.js";
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
  db: createScopedDatabase(pool),
  generateId: randomUUID,
  config: { allowedOrigins: env.allowedOrigins, requestTimeoutMs: env.requestTimeoutMs },
  ...(publicIntake === undefined ? {} : { publicIntake }),
  onError: (error) => console.error("Unhandled API error", error),
  ready: () => checkDatabase(pool),
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`zs-business API listening on http://localhost:${info.port}`);
  if (publicIntake === undefined) console.log("Public booking routes are off: PUBLIC_BOOKING_KEY_SECRET is not set");
});
const shutdown = () => {
  server.close();
  void pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
