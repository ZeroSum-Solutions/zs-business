import { randomBytes } from "node:crypto";
import type { NextConfig } from "next";

// One ID per build, shared with the build workers through the environment. The service
// worker is registered as /sw.js?v=<id>, so each build installs a fresh offline cache.
process.env.ZS_BUILD_ID ||= randomBytes(6).toString("hex");
const buildId = process.env.ZS_BUILD_ID;

const config: NextConfig = {
  reactStrictMode: true,
  // @zs/contracts ships TypeScript source with NodeNext-style ".js" import specifiers.
  // Turbopack cannot map those to ".ts" files yet, so dev and build run on webpack.
  transpilePackages: ["@zs/contracts"],
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // `pnpm typecheck` runs tsc (TypeScript 7) separately; the build does not re-check types.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  // e2e:live builds into its own folder so it can run next to the demo build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  generateBuildId: () => buildId,
  // Public values only. ZS_API_URL and ZS_API_TOKEN stay on the server (app/api proxy);
  // the browser learns only whether to use it.
  env: {
    NEXT_PUBLIC_API_MODE: process.env.ZS_API_URL?.trim() ? "live" : "demo",
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default config;
