"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createApi, type ApiRuntime } from "./index";

const ApiContext = createContext<ApiRuntime | null>(null);

declare global {
  interface Window {
    __zsDemo?: ApiRuntime["demo"];
  }
}

export function ApiProvider({ children, runtime }: { children: ReactNode; runtime?: ApiRuntime }) {
  const [value] = useState(() => runtime ?? createApi());
  useEffect(() => {
    if (value.demo) window.__zsDemo = value.demo;
    return () => {
      delete window.__zsDemo;
    };
  }, [value]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiRuntime(): ApiRuntime {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be used inside <ApiProvider>");
  return value;
}

export function useApi() {
  return useApiRuntime().api;
}
