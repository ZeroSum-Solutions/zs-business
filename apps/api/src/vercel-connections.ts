// Vercel Node function for GET /cron/connections and the five signed POST /internal/connections/<operation>, the eight /internal/shopify/<operation> and POST /webhooks/shopify
// routes (docs/requirements/connections.md C-3, C-7, C-9). scripts/build-vercel.mjs bundles this file once and
// copies it into six function directories in the workers Vercel project (`pnpm build:vercel:worker`), so the API
// project never holds the Composio key or the service database login. Like vercel-calendar.ts, it reads
// process.env and the system clock; one worker and one pool per instance. Each path answers only its own route.
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { apiErrorBody } from "@zs/core";
import { parseConnectionsEnv } from "./connections/config.js";
import { connectionsInternalRoutes } from "./connections/internal.js";
import { createConnectionsRunner } from "./connections/runner.js";
import { startConnectionsWorker } from "./connections/start.js";
import { shopifyWebhookRoutes } from "./connections/shopify-webhook.js";
import { cronRoutes } from "./delivery/cron.js";

const env = parseConnectionsEnv(process.env);
const clock = { now: () => new Date() };
const started = env.worker === null ? null : startConnectionsWorker(env.worker, { clock });
const worker = started?.worker ?? null;
const native = started?.native ?? null;

const app = new Hono();
app.route("/", cronRoutes({
  path: "/cron/connections",
  killSwitch: "the CONNECTIONS_ variables",
  name: "Connections",
  cronSecret: env.cronSecret,
  runner: worker === null ? null : createConnectionsRunner(worker),
  onError: (error) => console.error("Connections run failed", error),
}));
app.route("/", connectionsInternalRoutes({
  worker,
  native,
  env: env.worker?.env ?? "preview",
  secrets: env.worker?.internalSecrets ?? { current: "" },
  clock,
  onRefused: (operation, reason) => console.warn("Connections internal request refused", { operation, reason }),
  onError: (error) => console.error("Connections internal request failed", error),
}));
app.route("/", shopifyWebhookRoutes({ native, onError: (error) => console.error("Shopify webhook failed", error) }));
app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));

export default getRequestListener(app.fetch);
