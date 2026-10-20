import { randomBytes } from "node:crypto";
import type { NextConfig } from "next";

// One ID per build, shared with the build workers through the environment. The service
// worker is registered as /sw.js?v=<id>, so each build installs a fresh offline cache.
process.env.ZS_BUILD_ID ||= randomBytes(6).toString("hex");
const buildId = process.env.ZS_BUILD_ID;

/**
 * Sent on every dashboard response, pages and /api alike: no other site may frame the
 * dashboard (clickjacking). There is no script-src: Next's hydration runs inline scripts,
 * and a nonce would make every page dynamic.
 */
export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const config: NextConfig = {
  reactStrictMode: true,
  // next dev would otherwise write apps/dashboard/AGENTS.md when it detects a coding agent.
  agentRules: false,
  // @zs/contracts ships TypeScript source with NodeNext-style ".js" import specifiers.
  // Turbopack cannot map those to ".ts" files yet, so dev and build run on webpack.
  transpilePackages: ["@zs/contracts"],
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  // The build type-checks too, so a type error never ships.
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Google's code is in this address: the page it redirects to must not get it as a Referer.
      // Later entries win for the same header (google-calendar.md G-2).
      { source: "/api/calendar/google/callback", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  // e2e:live builds into its own folder so it can run next to the demo build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  generateBuildId: () => buildId,
  // Public values only. ZS_API_URL and the Supabase settings stay on the server (app/api proxy);
  // the browser learns only whether to use it.
  env: {
    NEXT_PUBLIC_API_MODE: process.env.ZS_API_URL?.trim() ? "live" : "demo",
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default config;
