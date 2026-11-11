"use client";

import { Check, Info, WarningCircle } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BillingPlan, HubPlan, PlanInterval, PlanStatus } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Segmented } from "@/components/ui/segmented";
import { ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { ApiError } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { browserZone, PLAN_WATCH_MS, usePlan } from "@/lib/queries";
import { formatDay } from "@/lib/time";
import { formatMoney, formatNumber } from "@/lib/utils";

// The plan carries no zone of its own and there is no business zone yet, so its dates are
// shown in the viewer's zone.
const day = (instant: string, zone: string) => formatDay(instant, zone, "long");
/** Plan prices are USD cents (plans.md PL-1). */
export const price = (cents: number) => formatMoney(cents / 100, "USD");

type Tone = "success" | "neutral" | "warn" | "danger" | "info";
export const PLAN_BADGE = {
  none: { label: "No plan", tone: "neutral" },
  trialing: { label: "Trial", tone: "info" },
  active: { label: "Active", tone: "success" },
  past_due: { label: "Payment failed", tone: "danger" },
  unpaid: { label: "Unpaid", tone: "danger" },
  canceled: { label: "Ended", tone: "neutral" },
  incomplete: { label: "Waiting for payment", tone: "warn" },
  incomplete_expired: { label: "Payment not finished", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" },
} as const satisfies Record<PlanStatus, { label: string; tone: Tone }>;

const HOLDS_PLAN: ReadonlySet<PlanStatus> = new Set(["trialing", "active", "past_due"]);

/** The line under the price: trial end, renewal or end. */
export function planDateLine(plan: BillingPlan, zone: string): string | null {
  if (plan.status === "trialing" && plan.trialEnd) return `Trial ends ${day(plan.trialEnd, zone)}. Your card is charged then.`;
  if (!plan.currentPeriodEnd || !HOLDS_PLAN.has(plan.status)) return null;
  return plan.cancelAtPeriodEnd ? `Ends ${day(plan.currentPeriodEnd, zone)}. Nothing more is charged.` : `Renews ${day(plan.currentPeriodEnd, zone)}`;
}

/** PL-22: the name of an operator-granted plan and, when it ends, the day. Null without an active grant. */
export function grantSummary(plan: BillingPlan, zone: string): { name: string; endLine: string | null } | null {
  const grant = plan.grant;
  if (!grant) return null;
  const name = plan.catalog.find((offer) => offer.plan === grant.plan)?.name ?? grant.plan;
  return { name, endLine: grant.grantedUntil ? `Included until ${day(grant.grantedUntil, zone)}.` : null };
}

/** PL-8: the banner a failed payment or an ended plan shows; null when billing is fine. */
export function billingNotice(plan: BillingPlan, zone: string): { tone: "warn" | "danger"; text: string } | null {
  if (plan.readOnly)
    return { tone: "danger", text: "Your business is read-only: you can see everything, but nothing new is sent or saved. Fix billing or choose a plan to turn it back on." };
  if (plan.paymentFailedAt && plan.readOnlyAfter)
    return { tone: "warn", text: `Your last payment failed. Update your card by ${day(plan.readOnlyAfter, zone)}, or the business turns read-only.` };
  if (plan.readOnlyAfter && !HOLDS_PLAN.has(plan.status))
    return { tone: "warn", text: `Your plan ends ${day(plan.readOnlyAfter, zone)}. After that the business is read-only until you choose a plan.` };
  return null;
}

function limitLines(limits: NonNullable<BillingPlan["limits"]>): string[] {
  return [
    `${limits.seats} team ${limits.seats === 1 ? "seat" : "seats"}`,
    `${limits.managedConnections} managed ${limits.managedConnections === 1 ? "connection" : "connections"}`,
    limits.automationTokens > 0 ? `${limits.automationTokens} automation tokens` : "No automation tokens",
    `${formatNumber(limits.emailsPerMonth)} emails a month`,
    limits.modelAgents ? "Agents that draft with AI" : "Rule-based agents",
    ...(limits.voice ? ["Voice and missed-call text back"] : []),
  ];
}

/** Sends the browser to a Stripe page. */
const go = (url: string) => { window.location.assign(url); };

/** PL-19: the words shown when the hub has no Shopify plan page URL for the business. */
export const SHOPIFY_ADMIN_HINT = "Open your Shopify admin, then Settings > Apps.";

/** PL-15, PL-19: Shopify's plan selection page, or the way to it when the URL is not known. */
function ShopifyManage({ url }: { url: string | null }) {
  if (!url) return <p className="text-sm text-fg-2">{SHOPIFY_ADMIN_HINT}</p>;
  return (
    <Button variant="secondary" asChild>
      {/* The page lives in the Shopify admin; it opens there, not inside the hub. */}
      <a href={url} target="_top" rel="noopener noreferrer">Manage billing in Shopify</a>
    </Button>
  );
}

function checkoutMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.reason === "checkout_open") return "A checkout is already open. Finish it, or wait an hour and start again.";
  if (error.reason === "plan_exists") return "You already have a plan. Change it in billing.";
  if (error.reason === "billing_provider") return "Your plan is billed through Shopify.";
  return undefined;
}

export function PlanView() {
  const api = useApi();
  const [returned, setReturned] = useState<"success" | "cancelled" | "shopify" | null>(null);
  const [watchUntil, setWatchUntil] = useState<number | undefined>(undefined);
  // Stripe returns here with ?checkout=…, Shopify's welcome link with ?shopify=welcome (PL-16);
  // read it once, without a Suspense boundary.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const value = query.get("checkout");
    if (value === "success" || value === "cancelled") setReturned(value);
    else if (query.get("shopify") === "welcome") {
      setReturned("shopify");
      setWatchUntil(Date.now() + PLAN_WATCH_MS);
    }
  }, []);
  const confirming = returned === "success" || returned === "shopify";
  // A Shopify change may leave the status as it was (one active plan for another), so the page
  // keeps reading for a while instead of stopping at the first settled answer (PL-18).
  const plan = usePlan({ poll: returned === "success", watchUntil });
  const holds = plan.data ? HOLDS_PLAN.has(plan.data.status) : false;
  // The Shopify note lasts while the page still reads the plan and nothing has changed yet.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (watchUntil === undefined) return;
    setWatching(true);
    const timer = window.setTimeout(() => setWatching(false), Math.max(0, watchUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [watchUntil]);
  const shape = plan.data ? `${plan.data.status}|${plan.data.plan}|${plan.data.interval}|${plan.data.founding}` : null;
  const [firstShape, setFirstShape] = useState<string | null>(null);
  useEffect(() => {
    if (returned === "shopify" && shape !== null) setFirstShape((first) => first ?? shape);
  }, [returned, shape]);
  const settled = returned === "success" ? holds
    : returned === "shopify" ? !watching || (firstShape !== null && shape !== firstShape) : false;
  const zone = browserZone();
  const [interval, setInterval] = useState<PlanInterval>("month");
  const [extra, setExtra] = useState(0);
  // One key per checkout intent: a lost answer retries with the same key and replays it (PL-4).
  const keys = useIntentKey();
  const intent = (chosen: HubPlan) => ({ plan: chosen, interval, extraConnections: interval === "month" ? extra : 0 });
  const checkout = useMutation({
    mutationFn: (chosen: HubPlan) => api.startPlanCheckout(intent(chosen), { idempotencyKey: keys.keyFor(intent(chosen)) }),
    onSettled: (_result, error, chosen) => keys.settle(intent(chosen), error ?? undefined),
    onSuccess: (result) => go(result.checkoutUrl),
    // PL-4: an open checkout answers its stored URL, so the owner goes back to it.
    onError: (error) => {
      if (error instanceof ApiError && error.reason === "checkout_open" && typeof error.details.checkoutUrl === "string") go(error.details.checkoutUrl);
    },
  });
  const portal = useMutation({ mutationFn: () => api.openBillingPortal(), onSuccess: (result) => go(result.url) });

  return (
    <>
      <PageHeader title="Plan" description="One monthly price, clear limits, and you can leave any time. Usage comes from your prepaid wallet." />
      {plan.isPending ? <LoadingRows rows={4} /> : plan.isError ? <ErrorNote error={plan.error} retry={() => plan.refetch()} /> : (() => {
        const data = plan.data;
        // PL-22: while an operator-granted plan is active there is nothing to pay and nothing to fix.
        const granted = grantSummary(data, zone);
        const notice = granted ? null : billingNotice(data, zone);
        const current = data.plan ? data.catalog.find((offer) => offer.plan === data.plan) : undefined;
        const shopify = data.billingProvider === "shopify";
        return (
          <div className="space-y-2">
            {confirming && !settled ? (
              <p role="status" className="flex items-start gap-3 rounded-md bg-info-tint p-4 text-sm text-info">
                <Info size={20} aria-hidden className="mt-px shrink-0" />
                {returned === "shopify"
                  ? "Thanks. Shopify is confirming your plan. A change can take a few minutes to show here; this page checks again on its own."
                  : "Thanks. Stripe is confirming your plan; it shows here in a moment."}
              </p>
            ) : null}
            {returned === "cancelled" && !holds ? (
              <p role="status" className="rounded-md bg-tray p-4 text-sm text-fg-2">Checkout was cancelled. Nothing was charged.</p>
            ) : null}
            {notice ? (
              <div role="alert" className={`flex flex-col gap-3 rounded-md p-4 text-sm sm:flex-row sm:items-center sm:justify-between ${notice.tone === "danger" ? "bg-danger-tint text-danger" : "bg-warn-tint text-warn"}`}>
                <p className="flex items-start gap-3"><WarningCircle size={20} aria-hidden className="mt-px shrink-0" />{notice.text}</p>
                {data.portalEnabled ? (
                  <Button variant="secondary" onClick={() => portal.mutate()} disabled={portal.isPending} aria-busy={portal.isPending}>Fix billing</Button>
                ) : shopify && data.shopifyManageUrl ? <ShopifyManage url={data.shopifyManageUrl} /> : null}
              </div>
            ) : null}

            {granted ? (
              <div className="tray">
                <Card aria-labelledby="plan-title">
                  <CardHeader>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle id="plan-title">Included plan: {granted.name}</CardTitle>
                        <Badge tone="success">Included</Badge>
                      </div>
                      {granted.endLine ? <p className="mt-2 text-sm text-muted">{granted.endLine}</p> : null}
                    </div>
                  </CardHeader>
                  {data.limits ? (
                    <ul className="space-y-2">
                      {limitLines(data.limits).map((item) => (
                        <li key={item} className="flex items-center gap-2 text-sm text-fg-2"><Check size={16} aria-hidden className="text-success" />{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              </div>
            ) : current && holds ? (
              <div className="tray grid grid-cols-1 gap-1.5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-2">
                <Card aria-labelledby="plan-title">
                  <CardHeader>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle id="plan-title">{current.name} plan</CardTitle>
                        <Badge tone={PLAN_BADGE[data.status].tone}>{PLAN_BADGE[data.status].label}</Badge>
                        {data.founding ? <Badge tone="accent">Founding rate</Badge> : null}
                      </div>
                      <p className="mt-2">
                        <span className="tabular text-3xl font-extrabold tracking-display text-fg">
                          {price((data.founding && current.foundingPrices ? current.foundingPrices : current.prices)[data.interval ?? "month"])}
                        </span>
                        <span className="text-sm text-muted">{data.interval === "year" ? " a year" : " a month"}</span>
                      </p>
                      {planDateLine(data, zone) ? <p className="text-sm text-muted">{planDateLine(data, zone)}</p> : null}
                    </div>
                  </CardHeader>
                  <ul className="space-y-2">
                    {limitLines(data.limits ?? current.limits).map((item) => (
                      <li key={item} className="flex items-center gap-2 text-sm text-fg-2"><Check size={16} aria-hidden className="text-success" />{item}</li>
                    ))}
                  </ul>
                  {data.extraConnections > 0 ? (
                    <p className="mt-4 text-sm text-muted">Includes {data.extraConnections} extra {data.extraConnections === 1 ? "connection" : "connections"} at {price(data.extraConnectionPrice)} a month each.</p>
                  ) : null}
                </Card>
                <Card aria-labelledby="billing-title" className="self-start">
                  <CardHeader><CardTitle id="billing-title">Billing</CardTitle></CardHeader>
                  {shopify ? (
                    <div className="space-y-3">
                      <p className="text-sm text-muted">Your plan is billed through Shopify. Change or cancel it on Shopify&apos;s plan page.</p>
                      <ShopifyManage url={data.shopifyManageUrl} />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted">Change your card, see invoices, switch plans or cancel on Stripe&apos;s secure page.</p>
                      {portal.isError ? <ErrorNote error={portal.error} /> : null}
                      <Button variant="secondary" onClick={() => portal.mutate()} disabled={!data.portalEnabled || portal.isPending}
                        aria-busy={portal.isPending} aria-describedby={data.portalEnabled ? undefined : "portal-off"}>
                        Manage billing
                      </Button>
                      {data.portalEnabled ? null : <DisabledReason id="portal-off">Billing is not available here yet.</DisabledReason>}
                    </div>
                  )}
                </Card>
              </div>
            ) : (
              <section aria-labelledby="choose-title" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="choose-title" className="text-lg font-bold">Choose a plan</h2>
                  <Segmented label="Billing period" value={interval} onChange={setInterval}
                    options={[{ value: "month", label: "Monthly" }, { value: "year", label: "Yearly, 2 months free" }]} />
                </div>
                {data.trialAvailable ? <p className="text-sm text-muted">Every plan starts with a {data.trialDays}-day free trial. Your card is charged when it ends.</p> : null}
                {shopify ? (
                  <div className="flex flex-col gap-3 rounded-md bg-tray p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-fg-2">Your business is billed through Shopify. Choose your plan on Shopify&apos;s plan page.</p>
                    <ShopifyManage url={data.shopifyManageUrl} />
                  </div>
                ) : null}
                {checkout.isError ? <ErrorNote error={checkout.error} message={checkoutMessage(checkout.error)} /> : null}
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  {data.catalog.map((offer) => {
                    const amount = (offer.foundingPrices ?? offer.prices)[interval];
                    const busy = checkout.isPending && checkout.variables === offer.plan;
                    return (
                      <Card key={offer.plan} aria-labelledby={`offer-${offer.plan}`}>
                        <CardHeader>
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <CardTitle id={`offer-${offer.plan}`}>{offer.name}</CardTitle>
                              {offer.foundingPrices ? <Badge tone="accent">Founding rate</Badge> : null}
                            </div>
                            <p className="mt-2">
                              <span className="tabular text-2xl font-extrabold tracking-display text-fg">{price(amount)}</span>
                              <span className="text-sm text-muted">{interval === "year" ? " a year" : " a month"}</span>
                            </p>
                            {offer.foundingPrices ? <p className="text-xs text-muted">List price {price(offer.prices[interval])}</p> : null}
                          </div>
                        </CardHeader>
                        <ul className="mb-4 space-y-2">
                          {limitLines(offer.limits).map((item) => (
                            <li key={item} className="flex items-center gap-2 text-sm text-fg-2"><Check size={16} aria-hidden className="text-success" />{item}</li>
                          ))}
                        </ul>
                        {shopify ? null : (
                          <Button className="w-full" onClick={() => checkout.mutate(offer.plan)} disabled={!data.checkoutEnabled || checkout.isPending}
                            aria-busy={busy} aria-describedby={data.checkoutEnabled ? undefined : "checkout-off"}>
                            {busy ? "Opening Stripe…" : `Choose ${offer.name}`}
                          </Button>
                        )}
                      </Card>
                    );
                  })}
                </div>
                {data.checkoutEnabled || shopify ? null : <DisabledReason id="checkout-off">Paying for a plan is not switched on here yet.</DisabledReason>}
                {/* PL-16: the add-on is not sold to a Shopify-billed business. */}
                {shopify ? null : interval === "month" ? (
                  <label className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
                    Extra managed connections, {price(data.extraConnectionPrice)} a month each
                    <input type="number" inputMode="numeric" min={0} max={20} value={extra}
                      onChange={(event) => setExtra(Math.max(0, Math.min(20, Math.trunc(Number(event.target.value) || 0))))}
                      className="min-h-11 w-20 rounded-md bg-surface px-3 text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" />
                  </label>
                ) : <p className="text-sm text-muted">Extra connections are sold with monthly plans.</p>}
              </section>
            )}
          </div>
        );
      })()}
    </>
  );
}
