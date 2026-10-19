"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { isApiError } from "./api";
import { DEMO_TENANT_ID } from "./api/demo/seed";
import { useApiRuntime } from "./api/react";

/**
 * Who the cached data belongs to. Every query key starts with the tenant, so data cached for
 * one business can never answer for another. The tenant comes from the server (/api/session
 * in live mode, the seed in demo mode), never from a token the browser holds.
 */
export type Session =
  | { status: "loading" }
  | { status: "signed_in"; tenantId: string; userId: string; role: "owner" | "staff" }
  /** `no_access`: signed in, but not (or no longer) a member of this business. */
  | { status: "signed_out"; reason: SignedOutReason }
  /** `misconfigured`: live mode without the Supabase settings; the server refuses to serve. */
  | { status: "unavailable"; misconfigured?: boolean };

export type SignedOutReason = "expired" | "signed_out" | "no_access";

interface SessionValue {
  session: Session;
  /** Ends the session: drops every cached answer and shows the signed-out screen. */
  signOut(reason: "expired" | "signed_out"): void;
  retry(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

const SessionBody = z.object({ tenantId: z.string().min(1), userId: z.string().min(1), role: z.enum(["owner", "staff"]) });
const DEMO_SESSION: Session = { status: "signed_in", tenantId: DEMO_TENANT_ID, userId: "demo-owner", role: "owner" };

declare global {
  interface Window {
    /** Demo builds only: lets tests read the cache keys and check it empties on sign-out. */
    __zsQueryClient?: QueryClient;
  }
}

async function fetchSession(): Promise<Session> {
  try {
    const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) {
      // No session cookie at all is "signed out"; an ended or revoked session is "expired".
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return { status: "signed_out", reason: body?.error === "signed_out" ? "signed_out" : "expired" };
    }
    if (response.status === 403) return { status: "signed_out", reason: "no_access" };
    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return { status: "unavailable", misconfigured: body?.error === "misconfigured" };
    }
    if (!response.ok) return { status: "unavailable" };
    const body = SessionBody.safeParse(await response.json());
    return body.success ? { status: "signed_in", ...body.data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { mode } = useApiRuntime();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session>(mode === "demo" ? DEMO_SESSION : { status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (mode === "demo") return;
    let live = true;
    void fetchSession().then((next) => {
      if (live) setSession((current) => (current.status === "signed_out" ? current : next));
    });
    return () => {
      live = false;
    };
  }, [mode, attempt]);

  const signOut = useCallback((reason: "expired" | "signed_out") => {
    setSession((current) => (current.status === "signed_out" ? current : { status: "signed_out", reason }));
    // The session cookies are httpOnly, so only the server can clear them, and it revokes the
    // session in Supabase too. The screen changes at once either way.
    if (mode === "live" && reason === "signed_out") {
      void fetch("/api/sign-out", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    }
  }, [mode]);

  // Any 401 from a read or a write ends the session.
  useEffect(() => {
    const onError = (error: unknown) => {
      if (isApiError(error) && error.kind === "unauthorized") signOut("expired");
    };
    const queries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.action.error);
    });
    const mutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") onError(event.action.error);
    });
    return () => {
      queries();
      mutations();
    };
  }, [queryClient, signOut]);

  // Clear after the signed-out screen has replaced the pages, so no mounted query refills it.
  useEffect(() => {
    if (session.status !== "signed_out") return;
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [session.status, queryClient]);

  useEffect(() => {
    if (mode !== "demo") return;
    window.__zsQueryClient = queryClient;
    return () => {
      delete window.__zsQueryClient;
    };
  }, [mode, queryClient]);

  const retry = useCallback(() => {
    setSession({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  const value = useMemo(() => ({ session, signOut, retry }), [session, signOut, retry]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** The signed-in tenant, or null while loading or signed out (queries stay disabled). */
export function useTenantId(): string | null {
  const { session } = useSession();
  return session.status === "signed_in" ? session.tenantId : null;
}
