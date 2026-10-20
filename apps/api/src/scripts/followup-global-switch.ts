// Operator entry point: flip the follow-up agent's global kill switch (agents.md G-3) for every
// tenant at once. `off` stops new drafts as soon as it returns; `on` lets tenants that are enabled
// and not killed draft again. Run from apps/api: `pnpm followup:global-switch off "reason"`.
// Uses FOLLOWUP_SERVICE_DATABASE_URL (and DATABASE_CA_CERT off loopback), like the runner.
import process from "node:process";
import { parse } from "pg-connection-string";
import { setGlobalAgentSwitch } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";

const [state, ...words] = process.argv.slice(2);
if (state !== "on" && state !== "off") {
  console.error('Usage: pnpm followup:global-switch on|off ["note"]');
  process.exit(2);
}
const url = process.env.FOLLOWUP_SERVICE_DATABASE_URL;
if (!url) throw new Error("FOLLOWUP_SERVICE_DATABASE_URL is required");
const caCert = process.env.DATABASE_CA_CERT;
const loopback = ["127.0.0.1", "::1", "localhost"].includes((parse(url).host ?? "").toLowerCase());
if (!loopback && caCert === undefined) throw new Error("DATABASE_CA_CERT is required off loopback");
const note = words.join(" ").trim();
if (note.length > 500) throw new Error("The note is at most 500 characters");

const pool = createRuntimePool({
  connectionString: url, max: 1, applicationName: "zs-followup-switch",
  onError: (summary) => console.error("Follow-up switch pool error", summary),
  ...(caCert === undefined ? {} : { ssl: { ca: caCert, rejectUnauthorized: true } }),
});
try {
  await asService(pool, (tx) => setGlobalAgentSwitch(tx, { killed: state === "off", note: note || null, now: new Date() }));
  console.log(state === "off" ? "Follow-up agent stopped for every tenant" : "Follow-up agent global switch is on");
} finally {
  await pool.end();
}
