// Server-renders a screen with the query cache filled, as a page would be on its first paint.
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ToastProvider } from "../../src/components/ui/toast";
import { createApi, type ApiRuntime } from "../../src/lib/api";
import { createDemoAdapter, type DemoApi } from "../../src/lib/api/demo/adapter";
import { DEMO_TENANT_ID } from "../../src/lib/api/demo/seed";
import { ApiProvider } from "../../src/lib/api/react";
import { scopeKeys, type ScopedKeys } from "../../src/lib/queries";
import { SessionProvider } from "../../src/lib/session";

export const keys = scopeKeys(DEMO_TENANT_ID);

export interface RenderOptions {
  fill?: (client: QueryClient) => void;
  /** Sign the demo in as staff instead of the owner. */
  staff?: boolean;
}

export function newRuntime(): ApiRuntime {
  return createApi({ mode: "demo" });
}

export function renderScreen(node: ReactNode, { fill = () => undefined, staff = false }: RenderOptions = {}): string {
  // A query that failed stays failed on this paint instead of starting a new read.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retryOnMount: false } } });
  fill(client);
  const runtime = newRuntime();
  if (staff) runtime.demo!.actAs("staff");
  return renderToString(h(ApiProvider, { runtime, children: null },
    h(QueryClientProvider, { client }, h(SessionProvider, null, h(ToastProvider, null, node)))));
}

/** Puts a failed read in the cache, as a query that has given up retrying leaves it. */
export function failQuery(client: QueryClient, queryKey: QueryKey, error: Error) {
  client.getQueryCache().build(client, { queryKey }).setState({
    data: undefined, dataUpdateCount: 0, dataUpdatedAt: 0, error, errorUpdateCount: 1, errorUpdatedAt: Date.now(),
    fetchFailureCount: 1, fetchFailureReason: error, fetchMeta: null, isInvalidated: false, status: "error", fetchStatus: "idle",
  });
}

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
