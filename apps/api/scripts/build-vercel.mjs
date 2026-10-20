// Bundles src/vercel.ts into one ESM file and writes Vercel's Build Output API layout
// (.vercel/output): /cron/delivery, /cron/billing, /cron/calendar and /cron/activepieces route to
// their own functions, every other path to the API function. Workspace packages ship
// TypeScript with NodeNext ".js" specifiers, which Vercel's own Node builder does not map,
// so the bundle is made here. Run from apps/api: `pnpm build:vercel`.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { build } from "esbuild";

const output = new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
const cronFn = new URL("functions/cron/delivery.func/", output);
const billingFn = new URL("functions/cron/billing.func/", output);
const calendarFn = new URL("functions/cron/calendar.func/", output);
const activepiecesFn = new URL("functions/cron/activepieces.func/", output);
await rm(output, { recursive: true, force: true });
for (const dir of [fn, cronFn, billingFn, calendarFn, activepiecesFn]) await mkdir(dir, { recursive: true });

const bundle = (entry, outfile) => build({
  entryPoints: [new URL(entry, import.meta.url).pathname],
  outfile: new URL("index.mjs", outfile).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // pg loads pg-native only when asked to; it is not installed.
  external: ["pg-native"],
  // CommonJS dependencies (pg) call require() for Node built-ins.
  banner: { js: "import { createRequire as __zsCreateRequire } from 'node:module'; const require = __zsCreateRequire(import.meta.url);" },
  // Map NodeNext ".js" specifiers in workspace TypeScript to their ".ts" sources.
  resolveExtensions: [".ts", ".js", ".mjs", ".json"],
  plugins: [{
    name: "ts-from-js",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, async (args) => {
        if (args.importer.includes("node_modules") && !args.importer.includes("/packages/")) return undefined;
        const result = await pluginBuild.resolve(args.path.replace(/\.js$/, ".ts"), { kind: args.kind, resolveDir: args.resolveDir });
        return result.errors.length === 0 ? { path: result.path } : undefined;
      });
    },
  }],
  logLevel: "warning",
});

await bundle("../src/vercel.ts", fn);
// resend.md R-9: the delivery cron is its own function, so the API's code never opens the
// service database login.
await bundle("../src/vercel-delivery.ts", cronFn);
// stripe.md S-8: the billing worker likewise, the only code that moves wallet money.
await bundle("../src/vercel-billing.ts", billingFn);
// google-calendar.md G-3, G-6: the calendar worker likewise, the only code that holds the token
// private key and writes external blocks.
await bundle("../src/vercel-calendar.ts", calendarFn);
// activepieces.md W-14: the webhook worker holds the service login too, so it is its own function.
await bundle("../src/vercel-activepieces.ts", activepiecesFn);

// The hosted booking page and widget read these at start-up (src/public/assets.ts).
await cp(new URL("../static/", import.meta.url), new URL("static/", fn), { recursive: true });
await writeFile(new URL(".vc-config.json", fn), JSON.stringify({
  runtime: "nodejs24.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 30,
}, null, 2));
await writeFile(new URL("package.json", fn), JSON.stringify({ type: "module" }));
for (const dir of [cronFn, billingFn, calendarFn, activepiecesFn]) {
  await writeFile(new URL(".vc-config.json", dir), JSON.stringify({
    runtime: "nodejs24.x",
    handler: "index.mjs",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    maxDuration: 30,
  }, null, 2));
  await writeFile(new URL("package.json", dir), JSON.stringify({ type: "module" }));
}
// No schedule unless the build sets one (for example "*/5 * * * *"), so a deploy never starts
// sending, moving money or calling Google by itself; DELIVERY_WORKER=on, BILLING_WORKER=on,
// CALENDAR_WORKER=on and ACTIVEPIECES_WEBHOOK_WORKER=on are the second switches, at run time.
const schedule = (name) => {
  const value = process.env[name];
  if (value !== undefined && !/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(value))
    throw new Error(`${name} must be a five-field cron expression`);
  return value;
};
const crons = [
  ["/cron/delivery", schedule("DELIVERY_CRON_SCHEDULE")],
  ["/cron/billing", schedule("BILLING_CRON_SCHEDULE")],
  ["/cron/calendar", schedule("CALENDAR_CRON_SCHEDULE")],
  ["/cron/activepieces", schedule("ACTIVEPIECES_CRON_SCHEDULE")],
].filter(([, value]) => value).map(([path, value]) => ({ path, schedule: value }));
await writeFile(new URL("config.json", output), JSON.stringify({
  version: 3,
  routes: [
    { src: "/cron/delivery", dest: "/cron/delivery" },
    { src: "/cron/billing", dest: "/cron/billing" },
    { src: "/cron/calendar", dest: "/cron/calendar" },
    { src: "/cron/activepieces", dest: "/cron/activepieces" },
    { src: "/(.*)", dest: "/index" },
  ],
  ...(crons.length > 0 ? { crons } : {}),
}, null, 2));
console.log("Wrote apps/api/.vercel/output");
