"use client";

import { CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason, SampleBadge } from "@/components/ui/sample";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import type { ConnectionStatus } from "@/lib/api";
import { returnNotice, type ReturnNotice } from "@/lib/calendar-sync";
import { useConnections, useKeys } from "@/lib/queries";
import { GoogleCalendarCard } from "./google-calendar-card";

const STATUS: Record<ConnectionStatus, { label: string; tone: "success" | "warn" | "neutral"; icon: typeof CheckCircle; action: string | null }> = {
  connected: { label: "Connected", tone: "success", icon: CheckCircle, action: null },
  needs_reconnect: { label: "Reconnect needed", tone: "warn", icon: WarningCircle, action: "Reconnect" },
  needs_permission: { label: "Permission needed", tone: "warn", icon: WarningCircle, action: "Allow access" },
  verifying: { label: "Checking", tone: "neutral", icon: Clock, action: null },
};

export function ConnectionsView() {
  const [notice, setNotice] = useState<ReturnNotice | null>(null);
  return (
    <>
      <PageHeader title="Connections" description="Accounts this business uses. Fix anything marked here and it shows as done on Home." />
      <Suspense fallback={null}>
        <GoogleReturn onNotice={setNotice} />
      </Suspense>
      <GoogleCalendarCard notice={notice} />
      <OtherAccounts />
    </>
  );
}

/**
 * Google sends the owner back here with `?calendar=connected` or `?calendar=error&reason=…`
 * (google-calendar.md G-2). Keep what it said on screen, read the connections again, and take
 * the query off the address so a reload or a shared link does not repeat it.
 */
function GoogleReturn({ onNotice }: { onNotice: (notice: ReturnNotice) => void }) {
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
    if (notice) onNotice(notice);
    void queryClient.invalidateQueries({ queryKey: keys.calendarConnections });
    // Busy times from a new connection change which times are open.
    if (outcome === "connected") void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
    router.replace(pathname, { scroll: false });
  }, [params, outcome, reason, onNotice, queryClient, keys, router, pathname]);
  return null;
}

/** The accounts that still show the sample workspace in live mode. */
function OtherAccounts() {
  const connections = useConnections();
  return (
    <section aria-labelledby="other-accounts-title">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id="other-accounts-title" className="text-base font-semibold text-fg">Other accounts</h2>
        <SampleBadge />
      </div>
      {connections.isPending ? <LoadingRows rows={6} /> : connections.isError ? <ErrorNote error={connections.error} retry={() => connections.refetch()} /> : (
        <ul className="divide-y divide-border-soft overflow-hidden rounded-md bg-surface shadow-ring">
          {connections.data.map((connection) => {
            const status = STATUS[connection.status];
            return (
              <li key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{connection.name}</h3>
                    <Badge tone={status.tone}><status.icon aria-hidden />{status.label}</Badge>
                  </div>
                  <p className="text-sm text-muted">{connection.purpose}</p>
                  <p className="text-xs text-meta">{connection.detail}</p>
                </div>
                {status.action ? (
                  <div className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
                    <Button variant="secondary" disabled aria-describedby={`why-${connection.id}`}>{status.action}</Button>
                    <DisabledReason id={`why-${connection.id}`}>Available when connections go live.</DisabledReason>
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
