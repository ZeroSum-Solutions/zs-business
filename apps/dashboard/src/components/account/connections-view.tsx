"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { returnNotice, type ReturnNotice } from "@/lib/calendar-sync";
import { forgetPending, pendingRemembered, pendingStorage, rememberPending, returnNotice as managedReturnNotice } from "@/lib/managed-connections";
import { useKeys, useSetup } from "@/lib/queries";
import { orderConnections } from "@/lib/recommended-connections";
import { GoogleCalendarCard } from "./google-calendar-card";
import { ShopifyCard } from "./shopify-card";

/** The hub serves two connections, Google Calendar and Shopify (connections.md rev 2), and lists nothing else. */
const DESCRIPTION = "Accounts this business uses. Connect Google Calendar and Shopify here.";

/** The connection cards this environment offers, by catalog id. */
const OFFERED_CONNECTIONS = ["google_calendar", "shopify"] as const;

export function ConnectionsView() {
  const [notice, setNotice] = useState<ReturnNotice | null>(null);
  const [shopifyNotice, setShopifyNotice] = useState<ReturnNotice | null>(null);
  // Shopify has not finished: the card asks again a few times (connections.md C-5).
  const [shopifyWaiting, setShopifyWaiting] = useState(false);
  const settleShopify = useCallback(() => {
    forgetPending(pendingStorage());
    setShopifyWaiting(false);
  }, []);
  // A reload while Shopify had not finished goes on waiting; the wait it remembered ends with the attempt.
  useEffect(() => {
    if (pendingRemembered(pendingStorage(), Date.now())) setShopifyWaiting(true);
  }, []);
  const setup = useSetup();
  // industry-templates.md IT-8: the applied template's recommended connections come first. Wait for
  // the setup read to settle before ordering, so the cards do not jump; on a failed read the cards
  // keep their default order with no recommended lines.
  // A read that is not running (no session yet) has nothing to wait for.
  const settled = !(setup.isPending && setup.fetchStatus === "fetching");
  const template = setup.data?.templates.find((item) => item.id === setup.data?.applied?.templateId);
  const cards: Record<(typeof OFFERED_CONNECTIONS)[number], ReactNode> = {
    google_calendar: <GoogleCalendarCard notice={notice} onNotice={setNotice} />,
    shopify: <ShopifyCard notice={shopifyNotice} onNotice={setShopifyNotice} waiting={shopifyWaiting} onSettled={settleShopify} />,
  };
  return (
    <>
      <PageHeader title="Connections" description={DESCRIPTION} />
      <Suspense fallback={null}>
        <GoogleReturn onNotice={setNotice} />
        <ManagedReturn onNotice={setShopifyNotice} onWaiting={setShopifyWaiting} />
      </Suspense>
      {settled ? orderConnections(OFFERED_CONNECTIONS, template?.recommendedConnections ?? []).map(({ id, recommended }) => (
        <Fragment key={id}>
          {recommended && template ? <p className="mb-2 text-sm font-semibold text-muted" data-testid={`recommended-${id}`}>Recommended for {template.label}</p> : null}
          {cards[id]}
        </Fragment>
      )) : <LoadingRows rows={2} label="Loading connections" />}
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
