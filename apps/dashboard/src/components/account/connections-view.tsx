"use client";

import { CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason, useSampleOnly } from "@/components/ui/sample";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import type { ConnectionStatus } from "@/lib/api";
import { returnNotice, type ReturnNotice } from "@/lib/calendar-sync";
import { forgetPending, pendingRemembered, pendingStorage, rememberPending, returnNotice as managedReturnNotice } from "@/lib/managed-connections";
import { useConnections, useKeys } from "@/lib/queries";
import { GoogleCalendarCard } from "./google-calendar-card";
import { ShopifyCard } from "./shopify-card";

const STATUS: Record<ConnectionStatus, { label: string; tone: "success" | "warn" | "neutral"; icon: typeof CheckCircle; action: string | null }> = {
  connected: { label: "Connected", tone: "success", icon: CheckCircle, action: null },
  needs_reconnect: { label: "Reconnect needed", tone: "warn", icon: WarningCircle, action: "Reconnect" },
  needs_permission: { label: "Permission needed", tone: "warn", icon: WarningCircle, action: "Allow access" },
  verifying: { label: "Checking", tone: "neutral", icon: Clock, action: null },
};

/** The live app serves two connections, Google Calendar and Shopify (connections.md rev 2). */
const LIVE_DESCRIPTION = "Accounts this business uses. Connect Google Calendar and Shopify here.";
/** The demo workspace still carries sample accounts beside them; those rows are read-only (U3-7). */
const DEMO_DESCRIPTION = `${LIVE_DESCRIPTION} The other accounts can't be changed here yet.`;

export function ConnectionsView() {
  const [notice, setNotice] = useState<ReturnNotice | null>(null);
  const [shopifyNotice, setShopifyNotice] = useState<ReturnNotice | null>(null);
  // Shopify has not finished: the card asks again a few times (connections.md C-5).
  const [shopifyWaiting, setShopifyWaiting] = useState(false);
  const liveApp = useSampleOnly();
  const settleShopify = useCallback(() => {
    forgetPending(pendingStorage());
    setShopifyWaiting(false);
  }, []);
  // A reload while Shopify had not finished goes on waiting; the wait it remembered ends with the attempt.
  useEffect(() => {
    if (pendingRemembered(pendingStorage(), Date.now())) setShopifyWaiting(true);
  }, []);
  return (
    <>
      <PageHeader title="Connections" description={liveApp ? LIVE_DESCRIPTION : DEMO_DESCRIPTION} />
      <Suspense fallback={null}>
        <GoogleReturn onNotice={setNotice} />
        <ManagedReturn onNotice={setShopifyNotice} onWaiting={setShopifyWaiting} />
      </Suspense>
      <GoogleCalendarCard notice={notice} onNotice={setNotice} />
      <ShopifyCard notice={shopifyNotice} onNotice={setShopifyNotice} waiting={shopifyWaiting} onSettled={settleShopify} />
      <OtherAccounts />
    </>
  );
}

/**
 * Shopify's callback sends the owner back here with `?connection=confirm`, `?connection=pending` or
 * `?connection=error&reason=...` (connections.md C-5). Keep what it said on screen, read the waiting grant and the
 * connections again, and take the query off the address so a reload or a shared link does not repeat it.
 */
function ManagedReturn({ onNotice, onWaiting }: { onNotice: (notice: ReturnNotice | null) => void; onWaiting: (waiting: boolean) => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const outcome = params.get("connection");
  const reason = params.get("reason");
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (outcome === null) {
      handled.current = null;
      return;
    }
    const search = params.toString();
    if (handled.current === search) return;
    handled.current = search;
    onNotice(managedReturnNotice(outcome, reason));
    // Remember a pending wait in this tab, so a reload keeps asking; any other answer ends it.
    if (outcome === "pending") rememberPending(pendingStorage(), Date.now());
    else forgetPending(pendingStorage());
    onWaiting(outcome === "pending");
    void queryClient.invalidateQueries({ queryKey: keys.managedPending });
    void queryClient.invalidateQueries({ queryKey: keys.managedConnections });
    router.replace(pathname, { scroll: false });
  }, [params, outcome, reason, onNotice, onWaiting, queryClient, keys, router, pathname]);
  return null;
}

/**
 * Google sends the owner back here with `?calendar=confirm` when a grant waits for the owner to
 * confirm its account, or `?calendar=error&reason=…` (google-calendar.md G-2). Keep what it said
 * on screen, read the waiting grant and the connections again, and take the query off the address
 * so a reload or a shared link does not repeat it. `?calendar=connected` is still understood.
 */
function GoogleReturn({ onNotice }: { onNotice: (notice: ReturnNotice | null) => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const outcome = params.get("calendar");
  const reason = params.get("reason");
  // The address keeps the query until the replace lands; handle each return once.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (outcome === null) {
      handled.current = null;
      return;
    }
    const search = params.toString();
    if (handled.current === search) return;
    handled.current = search;
    const notice = returnNotice(outcome, reason);
    // A confirm return clears an older notice: the card asks about the waiting grant instead.
    if (notice || outcome === "confirm") onNotice(notice);
    void queryClient.invalidateQueries({ queryKey: keys.calendarPending });
    void queryClient.invalidateQueries({ queryKey: keys.calendarConnections });
    // Busy times from a new connection change which times are open.
    if (outcome === "connected") void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
    router.replace(pathname, { scroll: false });
  }, [params, outcome, reason, onNotice, queryClient, keys, router, pathname]);
  return null;
}

/**
 * The demo workspace's other accounts. The live app has none: Instagram, Stripe, Google Business and the
 * domain are not connections it serves, so it shows no sample rows for them.
 */
function OtherAccounts() {
  if (useSampleOnly()) return null;
  return <SampleAccounts />;
}

function SampleAccounts() {
  const connections = useConnections();
  return (
    <section aria-labelledby="other-accounts-title" className="tray">
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 pt-2 pb-2.5 lg:px-4">
        <h2 id="other-accounts-title" className="text-base font-bold text-fg">Other accounts</h2>
      </div>
      {connections.isPending ? <LoadingRows rows={6} /> : connections.isError ? <ErrorNote error={connections.error} retry={() => connections.refetch()} /> : (
        <ul className="card divide-y divide-border-soft overflow-hidden">
          {connections.data.map((connection) => {
            const status = STATUS[connection.status];
            return (
              <li key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold">{connection.name}</h3>
                    <Badge tone={status.tone}><status.icon aria-hidden />{status.label}</Badge>
                  </div>
                  <p className="text-sm text-muted">{connection.purpose}</p>
                  <p className="text-xs text-meta">{connection.detail}</p>
                </div>
                {status.action ? (
                  <div className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
                    <Button variant="secondary" disabled aria-describedby={`why-${connection.id}`}>{status.action}</Button>
                    <DisabledReason id={`why-${connection.id}`}>You can&apos;t change this here yet.</DisabledReason>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
