"use client";

import { CheckCircle, PauseCircle, PlayCircle, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { AgentStatus } from "@/lib/api";
import { useAgents, useApprovals } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";

const STATUS: Record<AgentStatus, { label: string; tone: "success" | "neutral" | "warn"; icon: typeof PlayCircle }> = {
  running: { label: "Running", tone: "success", icon: PlayCircle },
  paused: { label: "Paused", tone: "neutral", icon: PauseCircle },
  needs_approval: { label: "Needs approval", tone: "warn", icon: WarningCircle },
};

export function AgentsView() {
  const agents = useAgents();
  const approvals = useApprovals();
  const toast = useToast();
  // UI-only for now: the kill switch does not reach a server yet.
  const [allPaused, setAllPaused] = useState(false);
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected">>({});
  const pending = approvals.data?.filter((item) => !decided[item.id]) ?? [];

  return (
    <>
      <PageHeader title="Agents" description="Helpers that work for you. Anything that speaks for the business waits for your approval." />

      <Card className={cn("mb-4 flex items-center gap-4", allPaused && "shadow-[inset_0_0_0_1px_var(--danger)]")}>
        <div className="min-w-0 flex-1">
          <h2 id="kill-label" className="text-base font-semibold">Pause all agents</h2>
          <p className="text-sm text-muted">{allPaused ? "All agents are paused. Nothing is sent until you turn this off." : "Stops every agent at once. Turn it off to resume."}</p>
        </div>
        <Switch
          aria-labelledby="kill-label"
          checked={allPaused}
          onCheckedChange={(checked) => {
            setAllPaused(checked);
            toast(checked ? "All agents paused." : "Agents resumed.", checked ? "info" : "success");
          }}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Card aria-labelledby="agents-title">
          <CardHeader><CardTitle id="agents-title">Your agents</CardTitle></CardHeader>
          {agents.isPending ? <LoadingRows rows={4} /> : agents.isError ? <ErrorNote error={agents.error} retry={() => agents.refetch()} /> : (
            <ul className="divide-y divide-border-soft">
              {agents.data.map((agent) => {
                const status = allPaused ? STATUS.paused : STATUS[agent.status];
                return (
                  <li key={agent.id} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">{agent.name}</h3>
                        <Badge tone={status.tone}><status.icon aria-hidden />{status.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-sm text-muted">{agent.description}</p>
                      <p className="mt-1 text-xs text-meta">Last ran {relativeTime(agent.lastRun)}. {agent.actionsThisWeek} actions this week.</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="approvals-title">
          <CardHeader>
            <div>
              <CardTitle id="approvals-title">Needs approval</CardTitle>
              <CardDescription>{pending.length === 0 ? "You are all caught up." : `${pending.length} waiting for you`}</CardDescription>
            </div>
          </CardHeader>
          {approvals.isPending ? <LoadingRows rows={2} /> : approvals.isError ? <ErrorNote error={approvals.error} retry={() => approvals.refetch()} /> : pending.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted"><CheckCircle size={20} aria-hidden className="text-success" />Nothing waiting.</p>
          ) : (
            <ul className="space-y-3">
              {pending.map((item) => (
                <li key={item.id} className="rounded-md bg-surface-warm p-3">
                  <p className="text-sm font-medium text-fg">{item.summary}</p>
                  <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-sm text-fg-2">{item.draft}</blockquote>
                  <p className="mt-2 text-xs text-meta">Drafted {relativeTime(item.createdAt)}</p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      disabled={allPaused}
                      onClick={() => { setDecided({ ...decided, [item.id]: "approved" }); toast("Approved. It will send shortly."); }}
                    >
                      Approve and send
                    </Button>
                    <Button variant="ghost" onClick={() => { setDecided({ ...decided, [item.id]: "rejected" }); toast("Draft discarded.", "info"); }}>
                      Discard
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
