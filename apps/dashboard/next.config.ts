import type { NextConfig } from "next";

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
};

export default config;
