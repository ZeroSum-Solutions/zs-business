"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Skeleton } from "@/components/ui/states";
import type { WeekCompare } from "@/lib/api";
import { useBookings, useChecklist, useResources, useResults, useUsage } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";
import { cn, formatMoney, formatNumber, weekChange } from "@/lib/utils";

function Change({ value }: { value: WeekCompare }) {
  const change = weekChange(value.thisWeek, value.lastWeek);
  if (change === null) return <span className="text-xs text-meta">No data last week</span>;
  const up = change >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", up ? "text-success" : "text-danger")}>
      <Icon size={14} weight="bold" aria-hidden />
      <span className="tabular">{up ? "Up" : "Down"} {Math.abs(change)}%</span>
      <span className="font-normal text-meta">vs last week</span>
    </span>
  );
}

function StatTile({ label, value, compare }: { label: string; value: string; compare: WeekCompare }) {
  return (
    <Card className="flex flex-col gap-1">
      <p className="text-sm text-muted">{label}</p>
      <p className="tabular text-2xl font-semibold tracking-display text-fg">{value}</p>
      <Change value={compare} />
      <p className="tabular text-xs text-meta">Last week {formatNumber(compare.lastWeek)}</p>
    </Card>
  );
}

function ResultsSection() {
  const results = useResults();
  if (results.isPending) return <div className="grid grid-cols-2 gap-3 lg:col-span-12"><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  if (results.isError) return <div className="lg:col-span-12"><ErrorNote error={results.error} retry={() => results.refetch()} /></div>;
  const data = results.data;
  const maxSource = Math.max(...data.revenueBySource.map((item) => Math.max(item.thisWeek, item.lastWeek)), 1);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:col-span-5 lg:grid-cols-1 xl:grid-cols-2 lg:content-start">
        <StatTile label="New leads" value={formatNumber(data.leads.thisWeek)} compare={data.leads} />
        <StatTile label="Bookings" value={formatNumber(data.bookings.thisWeek)} compare={data.bookings} />
      </div>
      <Card className="lg:col-span-7 lg:row-span-2" aria-labelledby="revenue-title">
        <CardHeader>
          <div>
            <CardTitle id="revenue-title">Revenue this week</CardTitle>
            <p className="tabular mt-2 text-3xl font-semibold tracking-display text-fg">{formatMoney(data.revenue.thisWeek, data.currency)}</p>
            <div className="mt-1"><Change value={data.revenue} /></div>
          </div>
        </CardHeader>
        <h3 className="mb-3 text-sm font-medium text-fg-2">By source</h3>
        <ul className="space-y-3">
          {data.revenueBySource.map((item) => (
            <li key={item.source}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg-2">{item.source}</span>
                <span className="tabular font-medium text-fg">{formatMoney(item.thisWeek, data.currency)}</span>
              </div>
              <div className="mt-1.5 space-y-1" aria-hidden>
                <div className="h-1.5 rounded-pill bg-accent" style={{ width: `${(item.thisWeek / maxSource) * 100}%` }} />
                <div className="h-1 rounded-pill bg-border-strong/50" style={{ width: `${(item.lastWeek / maxSource) * 100}%` }} />
              </div>
              <p className="sr-only">Last week {formatMoney(item.lastWeek, data.currency)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-center gap-4 text-xs text-meta">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-4 rounded-pill bg-accent" />This week</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1 w-4 rounded-pill bg-border-strong/50" />Last week</span>
        </p>
      </Card>
    </>
  );
}

function UsageCard() {
  const usage = useUsage();
  return (
    <Card className="lg:col-span-5" aria-labelledby="usage-title">
      <CardHeader>
        <div>
          <CardTitle id="usage-title">Wallet and usage</CardTitle>
          <CardDescription>Prepaid. Sending pauses at $0, so there are no surprise bills.</CardDescription>
        </div>
      </CardHeader>
      {usage.isPending ? <LoadingRows rows={3} /> : usage.isError ? <ErrorNote error={usage.error} retry={() => usage.refetch()} /> : (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">Balance</span>
            <span className="tabular text-xl font-semibold text-fg">{formatMoney(usage.data.walletBalance, usage.data.currency, 2)}</span>
          </div>
          <div
            role="meter"
            aria-label="Wallet balance"
            aria-valuemin={0}
            aria-valuemax={usage.data.walletTopUp}
            aria-valuenow={usage.data.walletBalance}
            aria-valuetext={`${formatMoney(usage.data.walletBalance, usage.data.currency, 2)} of ${formatMoney(usage.data.walletTopUp, usage.data.currency)}`}
            className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-warm"
          >
            <div className="h-full rounded-pill bg-accent" style={{ width: `${Math.min(100, (usage.data.walletBalance / usage.data.walletTopUp) * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-meta">Of your {formatMoney(usage.data.walletTopUp, usage.data.currency)} top-up</p>
          <ul className="mt-5 space-y-3">
            {usage.data.lines.map((line) => (
              <li key={line.id} className="text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-fg-2">{line.label}</span>
                  <span className="tabular text-muted">{formatNumber(line.used)} of {formatNumber(line.cap)}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-pill bg-surface-warm" aria-hidden>
                  <div className="h-full rounded-pill bg-fg-2/60" style={{ width: `${Math.min(100, (line.used / line.cap) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ChecklistCard() {
  const checklist = useChecklist();
  const open = checklist.data?.filter((item) => item.status === "action").length ?? 0;
  return (
    <Card className="lg:col-span-5" aria-labelledby="checklist-title">
      <CardHeader>
        <div>
          <CardTitle id="checklist-title">Connections</CardTitle>
          <CardDescription>{open > 0 ? `${open} need${open === 1 ? "s" : ""} you` : "Everything is connected"}</CardDescription>
        </div>
      </CardHeader>
      {checklist.isPending ? <LoadingRows rows={3} /> : checklist.isError ? <ErrorNote error={checklist.error} retry={() => checklist.refetch()} /> : (
        <ul className="divide-y divide-border-soft">
          {checklist.data.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              {item.status === "ok"
                ? <CheckCircle size={20} aria-hidden className="mt-0.5 shrink-0 text-success" />
                : <WarningCircle size={20} aria-hidden className="mt-0.5 shrink-0 text-warn" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{item.label}</p>
                <p className="text-sm text-muted">{item.detail}</p>
                <span className="sr-only">{item.status === "ok" ? "Connected" : "Needs action"}</span>
              </div>
              {item.actionLabel ? (
                <Button asChild variant="secondary" className="shrink-0">
                  <Link href="/account/connections">{item.actionLabel}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NextAppointments() {
  const from = useMemo(() => new Date().toISOString(), []);
  const bookings = useBookings({ from });
  const resources = useResources();
  const nameOf = (id: string) => resources.data?.find((item) => item.id === id);
  const upcoming = bookings.data?.slice(0, 4) ?? [];
  return (
    <Card className="lg:col-span-7" aria-labelledby="next-title">
      <CardHeader>
        <CardTitle id="next-title">Next appointments</CardTitle>
        <Link href="/calendar" className="-my-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline underline-offset-4">
          Calendar <ArrowRight size={16} aria-hidden />
        </Link>
      </CardHeader>
      {bookings.isPending ? <LoadingRows rows={3} /> : bookings.isError ? <ErrorNote error={bookings.error} retry={() => bookings.refetch()} /> : upcoming.length === 0 ? (
        <EmptyState title="No appointments coming up">Open slots show on the calendar.</EmptyState>
      ) : (
        <ul className="divide-y divide-border-soft">
          {upcoming.map((booking) => {
            const resource = nameOf(booking.resourceId);
            const zone = resource?.timeZone ?? "America/New_York";
            return (
              <li key={booking.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                <div className="w-20 shrink-0">
                  <p className="tabular text-sm font-semibold text-fg">{formatTime(booking.startsAt, zone)}</p>
                  <p className="text-xs text-meta">{formatDay(booking.startsAt, zone)}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{booking.title ?? "Appointment"}</p>
                  <p className="truncate text-sm text-muted">{booking.contactName ?? "No customer linked"}</p>
                </div>
                {resource ? <Badge tone={resource.kind === "showroom" ? "accent" : "neutral"}>{resource.kind === "showroom" ? "Showroom" : "Repair"}</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function HomeView() {
  return (
    <>
      <PageHeader title="This week" description="Results for Halden & Rowe, compared with last week." />
      <div className="grid grid-cols-1 gap-3 lg:grid-flow-dense lg:grid-cols-12 lg:gap-4">
        <ResultsSection />
        <NextAppointments />
        <UsageCard />
        <ChecklistCard />
      </div>
    </>
  );
}
