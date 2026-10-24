"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { roleCan, type Permission } from "@zs/contracts";
import { z } from "zod";
import { isApiError } from "./api";
import type { DemoControls } from "./api/demo/adapter";
import { DEMO_BUSINESS, DEMO_OWNER, DEMO_STAFF, DEMO_TENANT_ID } from "./api/demo/seed";
import { useApiRuntime } from "./api/react";

/**
 * Who the cached data belongs to. Every query key starts with the tenant, so data cached for
 * one business can never answer for another. The tenant comes from the server (/api/session
 * in live mode, the seed in demo mode), never from a token the browser holds.
 */
export type Session =
  | { status: "loading" }
  /** `businessName` and `email` are missing when an older API does not send them. */
  | { status: "signed_in"; tenantId: string; userId: string; role: "owner" | "staff"; businessName?: string; email?: string }
  /** `no_access`: signed in, but not (or no longer) a member of this business. */
  | { status: "signed_out"; reason: SignedOutReason }
  /**
   * Live mode, after the person chose Sign out: the pages are gone and the cache is cleared,
   * but the server has not confirmed it ended the session, so nothing may say it did.
   * `failed`: the last attempt got no 2xx (or no answer at all) and can be retried.
   */
  | { status: "signing_out"; failed: boolean }
  /** `misconfigured`: live mode without the Supabase settings; the server refuses to serve. */
  | { status: "unavailable"; misconfigured?: boolean };

export type SignedOutReason = "expired" | "signed_out" | "no_access";

interface SessionValue {
  session: Session;
  /**
   * Ends the session: drops every cached answer and replaces the pages. "expired" (the API
   * answered 401) shows the signed-out screen at once. "signed_out" (the person chose Sign
   * out) does too in demo mode; in live mode it asks the server first and shows the
   * signed-out screen only once the server confirms. Calling it again retries.
   */
  signOut(reason: "expired" | "signed_out"): void;
  retry(): void;
  /**
   * The business changed its display name (business-profile.md BP-9), so the shell and Home show
   * it at once. It applies to the signed-in business only, and a new sign-in starts from the server's name.
   */
  setBusinessName(name: string): void;
}

const SessionContext = createContext<SessionValue | null>(null);

const SessionBody = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["owner", "staff"]),
  businessName: z.string().optional(),
  email: z.string().optional(),
});
/** A 200 from /api/session as a session; unknown keys are dropped, a body without the membership is `unavailable`. */
export function sessionFromBody(json: unknown): Session {
  const body = SessionBody.safeParse(json);
  if (!body.success) return { status: "unavailable" };
  const { businessName, email, ...member } = body.data;
  return {
    status: "signed_in", ...member,
    ...(businessName === undefined ? {} : { businessName }),
    ...(email === undefined ? {} : { email }),
  };
}
/** Demo mode: the seed's business, as whoever the adapter acts as (the owner unless `actAs` says otherwise). */
export function demoSession(demo: Pick<DemoControls, "currentActor"> | null): Session {
  const actor = demo?.currentActor() ?? { role: "owner" as const, userId: DEMO_OWNER.userId };
  const person = actor.role === "owner" ? DEMO_OWNER : DEMO_STAFF;
  return {
    status: "signed_in", tenantId: DEMO_TENANT_ID, userId: actor.userId, role: actor.role,
    businessName: DEMO_BUSINESS, email: person.email ?? "",
  };
}

declare global {
  interface Window {
    /** Demo builds only: lets tests read the cache keys and check it empties on sign-out. */
    __zsQueryClient?: QueryClient;
  }
}

/**
 * Asks the server to end the session (the cookies are httpOnly, so only it can clear them, and
 * it revokes the session in Supabase too). True only for a 2xx answer: a 502 means Supabase
 * could not be told, and a network error means the server may never have heard the request.
 */
export async function requestSignOut(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/sign-out", { method: "POST", credentials: "same-origin", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

/** Session states with no pages to show: the cache must stay empty. */
const isEnded = (session: Session) => session.status === "signed_out" || session.status === "signing_out";

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
    return sessionFromBody(await response.json());
  } catch {
    return { status: "unavailable" };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { mode, demo } = useApiRuntime();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session>(mode === "demo" ? demoSession(demo) : { status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [renamed, setRenamed] = useState<{ tenantId: string; name: string } | null>(null);

  // Demo mode: tests switch between the owner and a staff member (`__zsDemo.actAs`).
  useEffect(() => {
    if (mode !== "demo" || !demo) return;
    return demo.onActorChange(() => setSession((current) => (current.status === "signed_in" ? demoSession(demo) : current)));
  }, [mode, demo]);

  useEffect(() => {
    if (mode === "demo") return;
    let live = true;
    void fetchSession().then((next) => {
      if (live) setSession((current) => (isEnded(current) ? current : next));
    });
    return () => {
      live = false;
    };
  }, [mode, attempt]);

  const signingOut = useRef(false);
  const signOut = useCallback((reason: "expired" | "signed_out") => {
    if (mode === "demo" || reason === "expired") {
      // An expired session (a 401) needs no request, and must not override a sign-out the
      // person started: that screen still owes them the server's answer.
      setSession((current) => (isEnded(current) ? current : { status: "signed_out", reason }));
      return;
    }
    if (signingOut.current) return;
    signingOut.current = true;
    setSession({ status: "signing_out", failed: false });
    void requestSignOut().then((ended) => {
      signingOut.current = false;
      setSession(ended ? { status: "signed_out", reason: "signed_out" } : { status: "signing_out", failed: true });
    });
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
    if (session.status !== "signed_out" && session.status !== "signing_out") return;
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

  const setBusinessName = useCallback((name: string) => {
    setSession((current) => {
      if (current.status === "signed_in") setRenamed({ tenantId: current.tenantId, name });
      return current;
    });
  }, []);

  // The new name sits over the session's own; it belongs to the business that was renamed.
  const shown = useMemo<Session>(
    () => (session.status === "signed_in" && renamed?.tenantId === session.tenantId ? { ...session, businessName: renamed.name } : session),
    [session, renamed],
  );
  const value = useMemo(() => ({ session: shown, signOut, retry, setBusinessName }), [shown, signOut, retry, setBusinessName]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** Who is signed in, for the shell and greetings: null while loading or signed out. */
export interface Identity {
  businessName?: string;
  email?: string;
  role: "owner" | "staff";
}
export function useIdentity(): Identity | null {
  const { session } = useSession();
  if (session.status !== "signed_in") return null;
  const { businessName, email, role } = session;
  return { role, ...(businessName === undefined ? {} : { businessName }), ...(email === undefined ? {} : { email }) };
}

/** The signed-in tenant, or null while loading or signed out (queries stay disabled). */
export function useTenantId(): string | null {
  const { session } = useSession();
  return session.status === "signed_in" ? session.tenantId : null;
}

/**
 * The permission that approves an inbox reply (owners only): M3b's `approve`, which decides
 * the reply's approval record and runs the send (inbox-home.md I-6). The one place it is named.
 */
export const APPROVE_REPLIES: Permission = "approve";
/** The permission that reads Home results (owners only). */
export const READ_RESULTS: Permission = "reports";
/** Reads the follow-up agent and stops it (agents.md G-3, G-11): owners and staff. */
export const STOP_AGENTS: Permission = "inbox.drafts";
/** Changes the follow-up agent's settings, resumes it and runs it now (G-2, G-3): owners only. */
export const MANAGE_AGENTS: Permission = "agents";
/** Reads, applies and discards price-list intake jobs (document-intake.md DL-3, DL-13): owners only. */
export const MANAGE_CATALOG: Permission = "publish";
/** Changes the business profile (business-profile.md BP-6): owners only; every member reads it. */
export const MANAGE_BUSINESS: Permission = "business";

/**
 * Whether the signed-in member's role allows `permission` (M2a `ROLE_PERMISSIONS`). The API
 * checks every request itself; this only keeps the screen from offering what it would refuse.
 */
export function useCan(permission: Permission): boolean {
  const { session } = useSession();
  return session.status === "signed_in" && roleCan(session.role, permission);
}
