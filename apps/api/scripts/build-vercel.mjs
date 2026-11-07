// Bundles the Vercel functions into ESM files and writes Vercel's Build Output API layout
// (.vercel/output). Two Vercel projects deploy from this one script, because a project's
// environment variables are visible to every function in it:
//   api    (`pnpm build:vercel`): src/vercel.ts only, every path routes to it. No cron functions and
//          no crons, so worker-only secrets are never set on that project.
//   worker (`pnpm build:vercel:worker`): /cron/delivery, /cron/billing, /cron/calendar,
//          /cron/activepieces and /cron/followup, each its own function. No API app: every other
//          path is a 404 (a request that matches no route).
// The esbuild options are in bundle-options.mjs. Run from apps/api; the optional second argument
// is the output directory (default .vercel/output; test/worker-split.test.ts builds into a temp dir).
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundleOptions } from "./bundle-options.mjs";

const targets = ["api", "worker"];
const target = process.argv[2];
if (!targets.includes(target)) throw new Error(`Usage: node scripts/build-vercel.mjs <${targets.join("|")}>`);
const output = process.argv[3] ? pathToFileURL(`${resolve(process.argv[3])}/`) : new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
// The crons live in their own Vercel project, so the API project never holds a service database
// login or any other worker secret (resend.md R-9, stripe.md S-8, google-calendar.md G-3,
// activepieces.md W-14, agents.md G-13); the calendar function is also the only code that holds
// the token private key. No schedule unless the build sets one, so a deploy never starts sending,
// moving money, calling Google or webhooks, or drafting by itself; DELIVERY_WORKER=on,
// BILLING_WORKER=on, CALENDAR_WORKER=on, ACTIVEPIECES_WEBHOOK_WORKER=on and FOLLOWUP_AGENT=on are
// the second switches, at run time.
const crons = target === "api" ? [] : [
  { path: "/cron/delivery", entry: "../src/vercel-delivery.ts", scheduleVar: "DELIVERY_CRON_SCHEDULE" },
  { path: "/cron/billing", entry: "../src/vercel-billing.ts", scheduleVar: "BILLING_CRON_SCHEDULE" },
  { path: "/cron/calendar", entry: "../src/vercel-calendar.ts", scheduleVar: "CALENDAR_CRON_SCHEDULE" },
  { path: "/cron/activepieces", entry: "../src/vercel-activepieces.ts", scheduleVar: "ACTIVEPIECES_CRON_SCHEDULE" },
  { path: "/cron/followup", entry: "../src/vercel-followup.ts", scheduleVar: "FOLLOWUP_CRON_SCHEDULE" },
].map((cron) => ({ ...cron, fn: new URL(`functions${cron.path}.func/`, output), schedule: process.env[cron.scheduleVar] }));
for (const cron of crons)
  if (cron.schedule !== undefined && !/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(cron.schedule))
    throw new Error(`${cron.scheduleVar} must be a five-field cron expression`);
await rm(output, { recursive: true, force: true });
if (target === "api") await mkdir(fn, { recursive: true });
for (const cron of crons) await mkdir(cron.fn, { recursive: true });

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
for (const dir of [...(target === "api" ? [fn] : []), ...crons.map((cron) => cron.fn)]) {
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
  // Worker: only the cron paths are routed, so anything else matches no route and is a 404.
  routes: target === "api" ? [{ src: "/(.*)", dest: "/index" }] : crons.map((cron) => ({ src: cron.path, dest: cron.path })),
  ...(scheduled.length ? { crons: scheduled } : {}),
}, null, 2));
console.log(`Wrote ${process.argv[3] ?? "apps/api/.vercel/output"} (${target})`);
