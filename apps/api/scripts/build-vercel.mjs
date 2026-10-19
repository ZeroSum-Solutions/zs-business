// Bundles src/vercel.ts into one ESM file and writes Vercel's Build Output API layout
// (.vercel/output): every path routes to the one Node function. Workspace packages ship
// TypeScript with NodeNext ".js" specifiers, which Vercel's own Node builder does not map,
// so the bundle is made here. Run from apps/api: `pnpm build:vercel`.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const output = new URL("../.vercel/output/", import.meta.url);
const fn = new URL("functions/index.func/", output);
await rm(output, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [new URL("../src/vercel.ts", import.meta.url).pathname],
  outfile: new URL("index.mjs", fn).pathname,
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
await writeFile(new URL("config.json", output), JSON.stringify({
  version: 3,
  routes: [{ src: "/(.*)", dest: "/index" }],
}, null, 2));
console.log("Wrote apps/api/.vercel/output");
