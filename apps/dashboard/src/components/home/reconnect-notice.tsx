"use client";

import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { MANAGE_MANAGED_CONNECTIONS, REAUTHORIZE_HOME_LINE, needsReauthorize } from "@/lib/managed-connections";
import { useManagedConnections } from "@/lib/queries";
import { useCan } from "@/lib/session";

/**
 * One line on Home for owners while a connected store needs them to reconnect it (connections.md C-13). It
 * reads the connections list the Connections page reads, and shows nothing for staff, while loading, or when
 * the read fails: Home stays quiet unless it knows.
 */
export function ReconnectNotice() {
  const canManage = useCan(MANAGE_MANAGED_CONNECTIONS);
  const connections = useManagedConnections(canManage);
  if (!canManage || !needsReauthorize(connections.data)) return null;
  return (
    <p role="status" data-testid="home-reconnect" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2 lg:mb-4">
      <WarningCircle size={16} aria-hidden className="shrink-0 text-warn" />
      <span>{REAUTHORIZE_HOME_LINE}</span>
      <Link href="/account/connections" className="inline-flex min-h-11 items-center gap-1 font-semibold text-fg underline-offset-2 hover:underline">
        Open Connections<ArrowRight size={14} aria-hidden />
      </Link>
    </p>
  );
}
