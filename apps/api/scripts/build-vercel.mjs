// Bundles the Vercel functions into ESM files and writes Vercel's Build Output API layout
// (.vercel/output). Two Vercel projects deploy from this one script, because a project's
// environment variables are visible to every function in it:
//   api    (`pnpm build:vercel`): src/vercel.ts only, every path routes to it. No cron functions and
//          no crons, so worker-only secrets are never set on that project.
//   worker (`pnpm build:vercel:worker`): /cron/delivery, /cron/billing, /cron/calendar,
//          /cron/activepieces, /cron/followup and /cron/connections, plus the five signed
//          /internal/connections/<operation> routes, the eight /internal/shopify/<operation> routes and
//          POST /webhooks/shopify, each its own function. No API app: every other
//          path is a 404 (a request that matches no route).
// The esbuild options are in bundle-options.mjs. Run from apps/api; the optional second argument
// is the output directory. The default (.vercel/output) is cleaned before each build; an explicit
// directory must not exist or be empty, and the script never deletes inside it (test/worker-split.test.ts
// builds into a fresh temp dir).
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundleOptions } from "./bundle-options.mjs";
import { CRON_SCHEDULE_VARIABLES } from "./worker-env.mjs";

const targets = ["api", "worker"];
const cronEntries = [
  { path: "/cron/delivery", entry: "../src/vercel-delivery.ts", scheduleVar: "DELIVERY_CRON_SCHEDULE" },
  { path: "/cron/billing", entry: "../src/vercel-billing.ts", scheduleVar: "BILLING_CRON_SCHEDULE" },
  { path: "/cron/calendar", entry: "../src/vercel-calendar.ts", scheduleVar: "CALENDAR_CRON_SCHEDULE" },
  { path: "/cron/activepieces", entry: "../src/vercel-activepieces.ts", scheduleVar: "ACTIVEPIECES_CRON_SCHEDULE" },
  { path: "/cron/followup", entry: "../src/vercel-followup.ts", scheduleVar: "FOLLOWUP_CRON_SCHEDULE" },
  { path: "/cron/connections", entry: "../src/vercel-connections.ts", scheduleVar: "CONNECTIONS_CRON_SCHEDULE" },
];
// The connections worker's signed operations (connections.md C-3): the same entry file as the cron, one
// function per path, so each is its own anchored route and no function answers another's path.
const connectionOperations = ["link", "complete", "cancel", "run", "disconnect"];
// The native Shopify tier (C-21 to C-24): its nine signed operations and Shopify's webhook endpoint, same entry file.
const shopifyOperations = ["open", "create_hub", "redeem_claim", "sign_in", "claim_start", "claim_status", "claim_cancel", "claim_confirm", "orders"];
const internalEntries = [
  ...connectionOperations.map((operation) => ({ path: `/internal/connections/${operation}`, entry: "../src/vercel-connections.ts" })),
  ...shopifyOperations.map((operation) => ({ path: `/internal/shopify/${operation}`, entry: "../src/vercel-connections.ts" })),
  { path: "/webhooks/shopify", entry: "../src/vercel-connections.ts" },
];
const target = process.argv[2];
if (!targets.includes(target)) throw new Error(`Usage: node scripts/build-vercel.mjs <${targets.join("|")}> [empty-output-dir]`);
// The API project carries no crons. A schedule variable left on it would silently drop a live cron
// at the next deploy, so the build refuses (runbook: delete the names, then deploy the API once).
if (target === "api") {
  const left = CRON_SCHEDULE_VARIABLES.filter((name) => process.env[name] !== undefined);
  if (left.length > 0)
    throw new Error(`The api build has no crons, but ${left.join(", ")} ${left.length === 1 ? "is" : "are"} set. Move the schedule to the workers project and delete the name from this project first (apps/api/README.md, "Moving the crons out of a single project").`);
}
const explicitOutput = process.argv[3];
if (explicitOutput) {
  // Never a recursive delete of a path the caller chose: `.` or a home directory would be wiped.
  const info = await stat(resolve(explicitOutput)).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info !== null && !info.isDirectory()) throw new Error(`${explicitOutput} exists and is not a directory`);
  if (info !== null && (await readdir(resolve(explicitOutput))).length > 0)
    throw new Error(`${explicitOutput} is not empty; pass a path that does not exist or an empty directory`);
}
const output = explicitOutput ? pathToFileURL(`${resolve(explicitOutput)}/`) : new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
// The crons live in their own Vercel project, so the API project never holds a service database
// login or any other worker secret (resend.md R-9, stripe.md S-8, google-calendar.md G-3,
// activepieces.md W-14, agents.md G-13). Every function in the workers project sees that project's
// whole environment (the calendar token private key included), so the split is by project, not by
// function. No schedule unless the build sets one, so a deploy never starts sending, moving money,
// calling Google or webhooks, or drafting by itself; DELIVERY_WORKER=on, BILLING_WORKER=on,
// CALENDAR_WORKER=on, ACTIVEPIECES_WEBHOOK_WORKER=on and FOLLOWUP_AGENT=on are the second switches,
// at run time.
const crons = target === "api" ? [] : cronEntries
  .map((cron) => ({ ...cron, fn: new URL(`functions${cron.path}.func/`, output), schedule: process.env[cron.scheduleVar] }));
for (const cron of crons)
  if (cron.schedule !== undefined && !/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(cron.schedule))
    throw new Error(`${cron.scheduleVar} must be a five-field cron expression`);
// Only the default directory (this script's own build output) is cleaned.
if (!explicitOutput) await rm(output, { recursive: true, force: true });
if (target === "api") await mkdir(fn, { recursive: true });
for (const cron of crons) await mkdir(cron.fn, { recursive: true });
const internals = target === "api" ? [] : internalEntries.map((internal) => ({ ...internal, fn: new URL(`functions${internal.path}.func/`, output) }));
for (const internal of internals) await mkdir(internal.fn, { recursive: true });

const bundle = (entry, outfile) => build({
  ...bundleOptions(new URL(entry, import.meta.url).pathname),
  outfile: new URL("index.mjs", outfile).pathname,
});

if (target === "api") {
  await bundle("../src/vercel.ts", fn);
  // The hosted booking page and widget read these at start-up (src/public/assets.ts).
  await cp(new URL("../static/", import.meta.url), new URL("static/", fn), { recursive: true });
}
for (const cron of crons) await bundle(cron.entry, cron.fn);
// One bundle per entry file, copied into the other directories that share it.
const bundled = new Map(crons.map((cron) => [cron.entry, cron.fn]));
for (const internal of internals) {
  const first = bundled.get(internal.entry);
  if (first === undefined) {
    await bundle(internal.entry, internal.fn);
    bundled.set(internal.entry, internal.fn);
  } else await cp(new URL("index.mjs", first), new URL("index.mjs", internal.fn));
}
for (const dir of [...(target === "api" ? [fn] : []), ...crons.map((cron) => cron.fn), ...internals.map((internal) => internal.fn)]) {
  await writeFile(new URL(".vc-config.json", dir), JSON.stringify({
    runtime: "nodejs24.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    maxDuration: 30,
  }, null, 2));
  await writeFile(new URL("package.json", dir), JSON.stringify({ type: "module" }));
}
const scheduled = crons.filter((cron) => cron.schedule).map((cron) => ({ path: cron.path, schedule: cron.schedule }));
await writeFile(new URL("config.json", output), JSON.stringify({
  version: 3,
  // Worker: only the exact cron paths are routed (anchored), so anything else matches no route and is a 404.
  routes: target === "api" ? [{ src: "/(.*)", dest: "/index" }] : [...crons, ...internals].map((entry) => ({ src: `^${entry.path}$`, dest: entry.path })),
  ...(scheduled.length ? { crons: scheduled } : {}),
}, null, 2));
console.log(`Wrote ${process.argv[3] ?? "apps/api/.vercel/output"} (${target})`);
