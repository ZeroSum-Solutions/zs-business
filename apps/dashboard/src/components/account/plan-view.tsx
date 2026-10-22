"use client";

import { Check, Info } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DisabledReason, NOT_AVAILABLE, useSampleOnly } from "@/components/ui/sample";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useApi } from "@/lib/api/react";
import type { Plan } from "@/lib/api/workspace-types";
import { browserZone, useKeys, usePlan } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { formatMoney } from "@/lib/utils";

// The plan carries no zone of its own and there is no business zone yet, so its dates are
// shown in the viewer's zone.
const day = (instant: string, zone: string) => formatDay(instant, zone, "long");

export const PLAN_BADGE = {
  active: { label: "Active", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const satisfies Record<Plan["status"], { label: string; tone: "success" | "neutral" }>;

export function planDateLine(plan: Plan, zone: string): string {
  return plan.status === "active" ? `Renews ${day(plan.renewsOn, zone)}` : `Ends ${day(plan.endsOn ?? plan.renewsOn, zone)}`;
}

/** What confirming the cancel does. No contract refunds the wallet on cancel (stripe.md, delivery.md D-4). */
export function cancelTerms(renewsOn: string, zone: string): string {
  return `Your plan stays on until ${day(renewsOn, zone)}. After that, nothing more is charged.`;
}

export function cancelledNote(endsOn: string, zone: string): string {
  return `Your plan is cancelled. It stays on until ${day(endsOn, zone)}, and nothing more will be charged.`;
}

export function PlanView() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const plan = usePlan();
  const sampleOnly = useSampleOnly();
  const [confirming, setConfirming] = useState(false);
  // The step's button replaces the one just pressed, so focus follows it; focusing also
  // scrolls it clear of the phone tab bar (see scroll-padding in globals.css).
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Confirming removes the button that had focus, so focus moves to the outcome.
  const cancelledRef = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const zone = browserZone();
  const stepChanged = useRef(false);
  useEffect(() => {
    if (!stepChanged.current) return;
    stepChanged.current = false;
    (confirming ? confirmRef : cancelRef).current?.focus();
  }, [confirming]);
  const goToStep = (next: boolean) => {
    stepChanged.current = true;
    setConfirming(next);
  };
  const cancel = useMutation({
    mutationFn: () => api.cancelPlan(),
    onSuccess: (updated) => {
      cancelled.current = true;
      setConfirming(false);
      queryClient.setQueryData(keys.plan, updated);
    },
  });
  const status = plan.data?.status;
  useEffect(() => {
    if (status !== "cancelled" || !cancelled.current) return;
    cancelled.current = false;
    cancelledRef.current?.focus();
  }, [status]);

  return (
    <>
      <PageHeader title="Plan" description="One price, clear limits, and you can leave any time." sample />
      {plan.isPending ? <LoadingRows rows={4} /> : plan.isError ? <ErrorNote error={plan.error} retry={() => plan.refetch()} /> : (
        <div className="tray grid grid-cols-1 gap-1.5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-2">
          <Card aria-labelledby="plan-title">
            <CardHeader>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle id="plan-title">{plan.data.name} plan</CardTitle>
                  <Badge tone={PLAN_BADGE[plan.data.status].tone}>{PLAN_BADGE[plan.data.status].label}</Badge>
                </div>
                <p className="mt-2">
                  <span className="tabular text-3xl font-extrabold tracking-display text-fg">{formatMoney(plan.data.pricePerMonth, plan.data.currency)}</span>
                  <span className="text-sm text-muted"> a month</span>
                </p>
                <p className="text-sm text-muted">{planDateLine(plan.data, zone)}</p>
              </div>
            </CardHeader>
            <ul className="space-y-2">
              {plan.data.includes.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-fg-2"><Check size={16} aria-hidden className="text-success" />{item}</li>
              ))}
            </ul>
            <h3 className="mt-6 mb-2 text-sm font-medium text-fg-2">Limits</h3>
            <dl className="divide-y divide-border-soft">
              {plan.data.caps.map((cap) => (
                <div key={cap.label} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:justify-between sm:gap-4">
                  <dt className="text-sm text-muted">{cap.label}</dt>
                  <dd className="text-sm text-fg sm:text-right">{cap.value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card aria-labelledby="cancel-title" className="self-start">
            <CardHeader><CardTitle id="cancel-title">Cancel plan</CardTitle></CardHeader>
            {plan.data.status === "cancelled" ? (
              <div ref={cancelledRef} role="status" tabIndex={-1} className="flex items-start gap-3 rounded-md text-sm text-fg-2">
                <Info size={20} aria-hidden className="mt-px shrink-0 text-muted" />
                <p>{cancelledNote(plan.data.endsOn ?? plan.data.renewsOn, zone)}</p>
              </div>
            ) : confirming ? (
              <div className="space-y-3">
                <p className="text-sm text-fg-2">{cancelTerms(plan.data.renewsOn, zone)}</p>
                {cancel.isError ? <ErrorNote error={cancel.error} /> : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button ref={confirmRef} variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending} aria-busy={cancel.isPending}>Confirm cancel</Button>
                  <Button variant="ghost" onClick={() => goToStep(false)}>Keep my plan</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted">No calls, no forms. Two taps and you are done.</p>
                <Button
                  ref={cancelRef}
                  variant="danger-outline"
                  disabled={sampleOnly}
                  aria-describedby={sampleOnly ? "cancel-unavailable" : undefined}
                  onClick={() => goToStep(true)}
                >
                  Cancel plan
                </Button>
                {sampleOnly ? <DisabledReason id="cancel-unavailable">{NOT_AVAILABLE}</DisabledReason> : null}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
