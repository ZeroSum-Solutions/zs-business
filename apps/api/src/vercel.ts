// Vercel Node function entry, bundled by scripts/build-vercel.mjs. Like main.ts, it reads
// process.env and the system clock; one app and one pool per function instance.
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { parseServerEnv } from "./config.js";
import { parseEnrichmentEnv } from "@zs/core";
import { createServer } from "./server.js";

const { app } = await createServer(parseServerEnv(process.env), { now: () => new Date() }, { enrichment: parseEnrichmentEnv(process.env) });

export default getRequestListener(app.fetch);
