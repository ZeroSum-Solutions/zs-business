// The only module that reads process.env or the system clock for the Node server.
import process from "node:process";
import { serve } from "@hono/node-server";
import { parseServerEnv } from "./config.js";
import { createServer } from "./server.js";

const env = parseServerEnv(process.env);
// DATABASE_URL must log in as the unprivileged runtime role (for example zs_runtime).
const { app, pool } = await createServer(env, { now: () => new Date() });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`zs-business API listening on http://localhost:${info.port}`);
  if (env.publicIntake === null) console.log("Public booking routes are off: PUBLIC_BOOKING_KEY_SECRET is not set");
});
const shutdown = () => {
  server.close();
  void pool.end();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
