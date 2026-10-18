"use client";

import { Check, CheckCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useApi } from "@/lib/api/react";
import { useKeys, usePlan } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { formatMoney } from "@/lib/utils";

export function PlanView() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const plan = usePlan();
  const [confirming, setConfirming] = useState(false);
  // The step's button replaces the one just pressed, so focus follows it; focusing also
  // scrolls it clear of the phone tab bar (see scroll-padding in globals.css).
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
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
      setConfirming(false);
      queryClient.setQueryData(keys.plan, updated);
    },
  });

  return (
    <>
      <PageHeader title="Plan" description="One price, clear limits, and you can leave any time." />
      {plan.isPending ? <LoadingRows rows={4} /> : plan.isError ? <ErrorNote error={plan.error} retry={() => plan.refetch()} /> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Card aria-labelledby="plan-title">
            <CardHeader>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle id="plan-title">{plan.data.name} plan</CardTitle>
                  {plan.data.status === "active" ? <Badge tone="success">Active</Badge> : <Badge tone="warn">Ends soon</Badge>}
                </div>
                <p className="mt-2">
                  <span className="tabular text-3xl font-semibold tracking-display text-fg">{formatMoney(plan.data.pricePerMonth, plan.data.currency)}</span>
                  <span className="text-sm text-muted"> a month</span>
                </p>
                <p className="text-sm text-muted">
                  {plan.data.status === "active"
                    ? `Renews ${formatDay(plan.data.renewsOn, "America/New_York", "long")}`
                    : `Ends ${formatDay(plan.data.endsOn ?? plan.data.renewsOn, "America/New_York", "long")}`}
                </p>
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
              <div role="status" className="flex items-start gap-3 text-sm text-fg-2">
                <CheckCircle size={20} aria-hidden className="mt-px shrink-0 text-success" />
                <p>
                  Your plan is cancelled. It stays on until {formatDay(plan.data.endsOn ?? plan.data.renewsOn, "America/New_York", "long")}, and nothing more will be charged.
                  Your customers and bookings stay available to export.
                </p>
              </div>
            ) : confirming ? (
              <div className="space-y-3">
                <p className="text-sm text-fg-2">
                  Your plan stays on until {formatDay(plan.data.renewsOn, "America/New_York", "long")}. After that, nothing more is charged. Your wallet balance is refunded.
                </p>
                {cancel.isError ? <ErrorNote error={cancel.error} /> : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button ref={confirmRef} variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending} aria-busy={cancel.isPending}>Confirm cancel</Button>
                  <Button variant="ghost" onClick={() => goToStep(false)}>Keep my plan</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted">No calls, no forms. Two taps and you are done.</p>
                <Button ref={cancelRef} variant="danger-outline" onClick={() => goToStep(true)}>Cancel plan</Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
