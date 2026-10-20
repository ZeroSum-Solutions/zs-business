import { createDemoAdapter, type DemoControls } from "./demo/adapter";
import { createDemoWorkspace } from "./demo/workspace";
import { createHttpClient } from "./http-client";
import type { ZsApi } from "./types";

export * from "./errors";
export type * from "./types";
export { bookingCustomerName, byContactName, CONTACT_IDS_PER_CALL, CONTACT_PAGE_SIZE, matchesSearch, normalizePhone, THREAD_PAGE_SIZE } from "./types";
export type * from "./workspace-types";

/** Where the browser sends API calls in live mode: the same-origin proxy in app/api. */
export const API_PROXY_PATH = "/api";

export interface ApiRuntimeConfig {
  mode?: string | undefined;
}

export interface ApiRuntime {
  api: ZsApi;
  mode: "live" | "demo";
  /** Only set in demo mode: acts as a second person, to show conflicts. */
  demo: DemoControls | null;
}

/** next.config.ts sets NEXT_PUBLIC_API_MODE to "live" when the build has ZS_API_URL. It carries no URL or token. */
export function readEnvConfig(): ApiRuntimeConfig {
  return { mode: process.env.NEXT_PUBLIC_API_MODE };
}

/** The only place that picks HTTP or demo. Components use `useApi()`, never an adapter. */
export function createApi(config: ApiRuntimeConfig = readEnvConfig()): ApiRuntime {
  if (config.mode !== "live") {
    const demo = createDemoAdapter({ latencyMs: 180 });
    return { api: { ...demo, ...createDemoWorkspace({ latencyMs: 180 }) }, mode: "demo", demo };
  }
  // No token here: the proxy adds it on the server.
  const http = createHttpClient({ baseUrl: API_PROXY_PATH });
  // TODO(api): wallet and usage, the connections checklist, site, agents, connections and plan
  // have no routes yet. Inbox and Home results are live (inbox-home.md).
  return { api: { ...createDemoWorkspace(), ...http }, mode: "live", demo: null };
}
