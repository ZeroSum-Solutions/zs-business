// Bundles src/vercel.ts into one ESM file and writes Vercel's Build Output API layout
// (.vercel/output): /cron/delivery and /cron/followup route to their own functions, every other
// path to the API function. Workspace packages ship TypeScript with NodeNext ".js" specifiers,
// which Vercel's own Node builder does not map, so the bundle is made here. Run from apps/api: `pnpm build:vercel`.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { build } from "esbuild";

const output = new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
// Each cron is its own function, so the API's code never opens a service database login
// (resend.md R-9, agents.md G-13). No schedule unless the build sets one, so a deploy never
// starts sending or drafting by itself; DELIVERY_WORKER=on and FOLLOWUP_AGENT=on are the second
// switches, at run time.
const crons = [
  { path: "/cron/delivery", entry: "../src/vercel-delivery.ts", scheduleVar: "DELIVERY_CRON_SCHEDULE" },
  { path: "/cron/followup", entry: "../src/vercel-followup.ts", scheduleVar: "FOLLOWUP_CRON_SCHEDULE" },
].map((cron) => ({ ...cron, fn: new URL(`functions${cron.path}.func/`, output), schedule: process.env[cron.scheduleVar] }));
for (const cron of crons)
  if (cron.schedule !== undefined && !/^[0-9*/,-]+( [0-9*/,-]+){4}$/.test(cron.schedule))
    throw new Error(`${cron.scheduleVar} must be a five-field cron expression`);
await rm(output, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
for (const cron of crons) await mkdir(cron.fn, { recursive: true });

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
for (const cron of crons) await bundle(cron.entry, cron.fn);

// The hosted booking page and widget read these at start-up (src/public/assets.ts).
await cp(new URL("../static/", import.meta.url), new URL("static/", fn), { recursive: true });
for (const dir of [fn, ...crons.map((cron) => cron.fn)]) {
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
  routes: [...crons.map((cron) => ({ src: cron.path, dest: cron.path })), { src: "/(.*)", dest: "/index" }],
  ...(scheduled.length ? { crons: scheduled } : {}),
}, null, 2));
console.log("Wrote apps/api/.vercel/output");
