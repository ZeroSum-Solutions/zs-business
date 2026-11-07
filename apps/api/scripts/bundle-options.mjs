// The esbuild options for every Vercel function bundle. Shared by build-vercel.mjs and by
// test/worker-split.test.ts, which bundles src/vercel.ts in memory and checks what it can read.
// Workspace packages ship TypeScript with NodeNext ".js" specifiers, which Vercel's own Node
// builder does not map, so the bundles are made here.

/** @param {string} entry absolute path of the function's entry point */
export const bundleOptions = (entry) => ({
  entryPoints: [entry],
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
