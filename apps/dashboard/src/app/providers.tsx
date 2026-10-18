"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { isApiError } from "@/lib/api";
import { ApiProvider } from "@/lib/api/react";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Conflicts, auth and validation errors will not fix themselves on retry.
            retry: (count, error) => count < 2 && (!isApiError(error) || error.kind === "network" || error.kind === "server"),
          },
          mutations: { retry: false },
        },
      }),
  );

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  return (
    <ApiProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}
