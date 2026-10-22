import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ToastProvider } from "../../src/components/ui/toast";
import type { ApiRuntime } from "../../src/lib/api";
import { createDemoAdapter, type DemoApi } from "../../src/lib/api/demo/adapter";
import { DEMO_TENANT_ID } from "../../src/lib/api/demo/seed";
import { ApiProvider } from "../../src/lib/api/react";
import { scopeKeys, type ScopedKeys } from "../../src/lib/queries";
import { SessionProvider } from "../../src/lib/session";

/**
 * A demo workspace whose reads are already in the query cache, so a screen renders on the
 * server as it first paints in the browser with that data. Tests fill the cache with `setQueryData`.
 */
export async function demoApp(now = new Date()) {
  const api = createDemoAdapter({ clock: { now: () => now } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const keys = scopeKeys(DEMO_TENANT_ID);
  const runtime = { api, mode: "demo", demo: api } as unknown as ApiRuntime;
  const render = (element: ReactElement) => renderToString(
    h(ApiProvider, { runtime, children: h(QueryClientProvider, { client: queryClient }, h(SessionProvider, null, h(ToastProvider, null, element))) }),
  ).replaceAll("<!-- -->", "");
  return { api: api as DemoApi, queryClient, keys, render };
}

export type DemoApp = Awaited<ReturnType<typeof demoApp>>;
export type { ScopedKeys };
