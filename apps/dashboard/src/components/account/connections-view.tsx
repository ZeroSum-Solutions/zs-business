"use client";

import { CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/sample";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import type { ConnectionStatus } from "@/lib/api";
import { useConnections } from "@/lib/queries";

const STATUS: Record<ConnectionStatus, { label: string; tone: "success" | "warn" | "neutral"; icon: typeof CheckCircle; action: string | null }> = {
  connected: { label: "Connected", tone: "success", icon: CheckCircle, action: null },
  needs_reconnect: { label: "Reconnect needed", tone: "warn", icon: WarningCircle, action: "Reconnect" },
  needs_permission: { label: "Permission needed", tone: "warn", icon: WarningCircle, action: "Allow access" },
  verifying: { label: "Checking", tone: "neutral", icon: Clock, action: null },
};

export function ConnectionsView() {
  const connections = useConnections();
  return (
    <>
      <PageHeader title="Connections" description="Accounts this business uses. Fix anything marked here and it shows as done on Home." sample />
      {connections.isPending ? <LoadingRows rows={6} /> : connections.isError ? <ErrorNote error={connections.error} retry={() => connections.refetch()} /> : (
        <ul className="divide-y divide-border-soft overflow-hidden rounded-md bg-surface shadow-ring">
          {connections.data.map((connection) => {
            const status = STATUS[connection.status];
            return (
              <li key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{connection.name}</h2>
                    <Badge tone={status.tone}><status.icon aria-hidden />{status.label}</Badge>
                  </div>
                  <p className="text-sm text-muted">{connection.purpose}</p>
                  <p className="text-xs text-meta">{connection.detail}</p>
                </div>
                {status.action ? (
                  <div className="flex flex-col items-start gap-1 sm:items-end">
                    <Button variant="secondary" disabled aria-describedby={`why-${connection.id}`}>{status.action}</Button>
                    <DisabledReason id={`why-${connection.id}`}>Available when connections go live.</DisabledReason>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
