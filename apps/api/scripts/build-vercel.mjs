// Bundles src/vercel.ts into one ESM file and writes Vercel's Build Output API layout
// (.vercel/output): /cron/delivery routes to the delivery function, every other path to the API
// function. Workspace packages ship
// TypeScript with NodeNext ".js" specifiers, which Vercel's own Node builder does not map,
// so the bundle is made here. Run from apps/api: `pnpm build:vercel`.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { build } from "esbuild";

const output = new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
const cronFn = new URL("functions/cron/delivery.func/", output);
await rm(output, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await mkdir(cronFn, { recursive: true });

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
await writeFile(new URL(".vc-config.json", cronFn), JSON.stringify({
  runtime: "nodejs24.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 30,
}, null, 2));
await writeFile(new URL("package.json", cronFn), JSON.stringify({ type: "module" }));
// No schedule unless the build sets one (for example "*/5 * * * *"), so a deploy never starts
// sending by itself; DELIVERY_WORKER=on is the second switch, at run time.
const schedule = process.env.DELIVERY_CRON_SCHEDULE;
if (schedule !== undefined && !/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(schedule))
  throw new Error("DELIVERY_CRON_SCHEDULE must be a five-field cron expression");
await writeFile(new URL("config.json", output), JSON.stringify({
  version: 3,
  routes: [{ src: "/cron/delivery", dest: "/cron/delivery" }, { src: "/(.*)", dest: "/index" }],
  ...(schedule ? { crons: [{ path: "/cron/delivery", schedule }] } : {}),
}, null, 2));
console.log("Wrote apps/api/.vercel/output");
