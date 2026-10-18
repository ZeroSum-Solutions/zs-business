import { createDemoAdapter, type DemoControls } from "./demo/adapter";
import { createDemoWorkspace } from "./demo/workspace";
import { createHttpClient } from "./http-client";
import type { ZsApi } from "./types";

export * from "./errors";
export type * from "./types";
export { byContactName, matchesSearch, normalizePhone } from "./types";
export type * from "./workspace-types";

export interface ApiRuntimeConfig {
  apiUrl?: string | undefined;
  token?: string | undefined;
}

export interface ApiRuntime {
  api: ZsApi;
  mode: "live" | "demo";
  /** Only set in demo mode: acts as a second person, to show conflicts. */
  demo: DemoControls | null;
}

/** Next.js inlines NEXT_PUBLIC_* at build time, so read them by their full names. */
export function readEnvConfig(): ApiRuntimeConfig {
  return {
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    token: process.env.NEXT_PUBLIC_API_TOKEN,
  };
}

/** The only place that picks HTTP or demo. Components use `useApi()`, never an adapter. */
export function createApi(config: ApiRuntimeConfig = readEnvConfig()): ApiRuntime {
  const apiUrl = config.apiUrl?.trim();
  if (!apiUrl) {
    const demo = createDemoAdapter({ latencyMs: 180 });
    return { api: { ...demo, ...createDemoWorkspace({ latencyMs: 180 }) }, mode: "demo", demo };
  }
  const token = config.token?.trim() || null;
  const http = createHttpClient({ baseUrl: apiUrl, getToken: () => token });
  // TODO(api): results, wallet, inbox, site, agents, connections and plan have no routes yet.
  return { api: { ...createDemoWorkspace(), ...http }, mode: "live", demo: null };
}
