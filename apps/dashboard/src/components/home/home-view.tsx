"use client";

import { ArrowRight, CalendarBlank, ChatCircleDots, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { BorderBeam } from "@/components/ui/border-beam";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiTile } from "@/components/ui/kpi-tile";
import { SampleBadge } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Skeleton } from "@/components/ui/states";
import { bookingCustomerName, type HomeResults } from "@/lib/api";
import { ORIGIN_LABELS, revenueSourceLabel } from "@/lib/lead-sources";
import { useBookings, useChecklist, useDisplayZone, useInboxCount, useResources, useResults, useUsage } from "@/lib/queries";
import { resourceLabel } from "@/lib/resources";
import { READ_RESULTS, useCan } from "@/lib/session";
import { spotlight } from "@/lib/spotlight";
import { formatDay, formatRange, formatTime } from "@/lib/time";
import { cn, currencyDigits, formatMinor, formatMoney, formatNumber, weekChange } from "@/lib/utils";

interface WeekCompare {
  thisWeek: number;
  lastWeek: number;
}

/** A count or an amount this week against the same span last week, as a KPI tile. */
function WeekTile({ id, label, compare, format, valueTestId, step = 1, beam = false, className, children }: {
  id: string;
  label: string;
  compare: WeekCompare;
  format: (value: number) => string;
  valueTestId: string;
  /** Rolling frames snap to this many units, so a whole amount never flashes cents mid-roll. */
  step?: number;
  /** A light travels the edge: for the one headline number on the page. */
  beam?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const change = weekChange(compare.thisWeek, compare.lastWeek);
  return (
    <KpiTile
      scrub={false}
      testId={`tile-${id}`}
      valueTestId={valueTestId}
      label={label}
      value={compare.thisWeek}
      format={(value) => format(Math.round(value / step) * step)}
      {...(change === null ? {} : { delta: change })}
      formatDelta={(value) => `${Math.abs(value)}%`}
      deltaLabel={change === null ? "None in the same span last week" : "vs last week"}
      sparkline={false}
      {...(beam ? { decoration: <BorderBeam /> } : {})}
      {...(className ? { className } : {})}
    >
      <WeekBars compare={compare} format={format} />
      {children}
    </KpiTile>
  );
}

/** This week against last week as two bars: two points say more as lengths than as a line. */
function WeekBars({ compare, format }: { compare: WeekCompare; format: (value: number) => string }) {
  const max = Math.max(compare.thisWeek, compare.lastWeek, 1);
  const rows = [
    { label: "This week", value: compare.thisWeek, bar: "bg-accent" },
    { label: "Same time last week", value: compare.lastWeek, bar: "bg-fg/20" },
  ];
  return (
    <ul className="space-y-1.5 text-xs" aria-label="This week and last week">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="text-meta">{row.label}</span>
          <span className="tabular text-fg-2">{format(row.value)}</span>
          <span aria-hidden className="col-span-2 h-1.5 overflow-hidden rounded-pill bg-fg/6">
            <span className={cn("block h-full rounded-pill", row.bar)} style={{ width: `${(row.value / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function SourceRows({ label, bySource }: {
  label: string;
  bySource: { source: keyof typeof ORIGIN_LABELS; thisWeek: number; lastWeek: number }[];
}) {
  return (
    <ul className="space-y-1.5 border-t border-border-soft pt-2 text-xs" aria-label={`${label} by source`}>
      {bySource.map((item) => (
        <li key={item.source} className="flex items-baseline justify-between gap-2" data-source={item.source}>
          <span className="min-w-0 text-fg-2">{ORIGIN_LABELS[item.source]}</span>
          <span className="tabular shrink-0 whitespace-nowrap text-fg">{formatNumber(item.thisWeek)} <span className="text-meta">last {formatNumber(item.lastWeek)}</span></span>
        </li>
      ))}
    </ul>
  );
}

function RevenueTile({ data }: { data: HomeResults }) {
  const [main, ...others] = data.revenue;
  const won = data.wonDeals;
  if (!main) {
    return (
      <Card className="col-span-2 lg:col-span-6" aria-labelledby="revenue-title">
        <CardTitle id="revenue-title" className="text-sm font-medium text-muted">Revenue this week</CardTitle>
        <EmptyState title={won.thisWeek + won.lastWeek === 0 ? "No deals won yet this week" : "Won deals have no value yet"}>
          {won.thisWeek + won.lastWeek === 0
            ? "Revenue shows here once a deal with a value moves to a won stage."
            : `${formatNumber(won.thisWeek)} won this week and ${formatNumber(won.lastWeek)} last week. Add a value on the pipeline board to count them.`}
        </EmptyState>
      </Card>
    );
  }
  // Whole amounts roll in whole units; an amount with cents rolls in cents.
  const scale = 10 ** currencyDigits(main.currency);
  const maxSource = Math.max(...main.bySource.map((item) => Math.max(item.thisWeek, item.lastWeek)), 1);
  return (
    <WeekTile
      id="revenue"
      label="Revenue this week"
      compare={main}
      format={(value) => formatMinor(value, main.currency)}
      valueTestId="revenue-value"
      step={main.thisWeek % scale === 0 ? scale : 1}
      beam
      className="col-span-2 lg:col-span-6 lg:self-stretch"
    >
      <p className="tabular text-xs text-meta">
        {formatNumber(won.thisWeek)} won this week, {formatNumber(won.lastWeek)} last week.
      </p>
      <div className="border-t border-border-soft pt-3">
        <h3 className="mb-2 text-xs font-medium text-fg-2">By lead source</h3>
        <ul className="space-y-2.5">
          {main.bySource.map((item) => (
            <li key={item.source} data-source={item.source}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg-2">{revenueSourceLabel(item.source)}</span>
                <span className="tabular font-medium text-fg">{formatMinor(item.thisWeek, main.currency)} <span className="text-xs font-normal text-meta">last {formatMinor(item.lastWeek, main.currency)}</span></span>
              </div>
              <div className="mt-1 space-y-0.5" aria-hidden>
                <div className="h-1.5 rounded-pill bg-accent" style={{ width: `${(item.thisWeek / maxSource) * 100}%` }} />
                <div className="h-1 rounded-pill bg-fg/20" style={{ width: `${(item.lastWeek / maxSource) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-center gap-4 text-xs text-meta">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-4 rounded-pill bg-accent" />This week</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1 w-4 rounded-pill bg-fg/20" />Last week</span>
        </p>
      </div>
      {others.length > 0 ? (
        <div className="border-t border-border-soft pt-3">
          <h3 className="text-xs font-medium text-fg-2">Other currencies</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {others.map((item) => (
              <li key={item.currency} className="flex justify-between gap-3">
                <span className="text-fg-2">{item.currency}</span>
                <span className="tabular text-fg">{formatMinor(item.thisWeek, item.currency)} <span className="text-xs text-meta">last week {formatMinor(item.lastWeek, item.currency)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </WeekTile>
  );
}

/** H-3..H-5: owners only. Weeks start on Monday in the business's calendar zone. */
function ResultsSection() {
  const resources = useResources();
  const zone = useDisplayZone();
  // Wait for the calendars, so the weeks are asked once, in the zone they are shown in.
  const query = useMemo(() => (resources.isPending ? null : { zone, weekStart: "monday" as const }), [resources.isPending, zone]);
  const results = useResults(query);
  if (results.isPending) return <div className="grid grid-cols-2 gap-3 lg:col-span-12 lg:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="col-span-2 h-40 lg:col-span-1" /></div>;
  if (results.isError) return <div className="lg:col-span-12"><ErrorNote error={results.error} retry={() => results.refetch()} /></div>;
  const data = results.data;
  const ranges = `This week: ${formatRange(data.thisWeek.from, data.thisWeek.to, data.zone)}. Compared with the same span of last week: ${formatRange(data.lastWeek.from, data.lastWeek.to, data.zone)}. Times in ${data.zone.replaceAll("_", " ")}.`;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 lg:col-span-12">
        <h2 className="text-[11px] leading-4 font-medium tracking-[0.08em] text-meta uppercase">Results</h2>
        {/* The full ranges are read out and shown on hover; the pill is the short form. */}
        <p className="rounded-pill bg-surface-warm px-2.5 py-1 text-xs text-fg-2 ring-1 ring-inset ring-border" title={ranges}>
          <span aria-hidden>Since {formatDay(data.thisWeek.from, data.zone)} · vs same time last week</span>
          <span className="sr-only" data-testid="results-ranges">{ranges}</span>
        </p>
      </div>
      <div className="grid grid-cols-2 items-start gap-3 lg:col-span-12 lg:grid-cols-12 lg:gap-4">
        {/* Side by side on a phone; stacked beside the taller revenue tile on a wide screen. */}
        <div className="col-span-2 grid grid-cols-2 items-start gap-3 lg:col-span-6 lg:grid-cols-1 lg:gap-4">
          <WeekTile id="leads" label="New leads" compare={data.leads} format={formatNumber} valueTestId="tile-value">
            <SourceRows label="New leads" bySource={data.leads.bySource} />
          </WeekTile>
          <WeekTile id="bookings" label="Bookings" compare={data.bookings} format={formatNumber} valueTestId="tile-value">
            <SourceRows label="Bookings" bySource={data.bookings.bySource} />
          </WeekTile>
        </div>
        <RevenueTile data={data} />
      </div>
    </>
  );
}

function UsageCard() {
  const usage = useUsage();
  return (
    <Card className="lg:col-span-5" aria-labelledby="usage-title">
      <CardHeader>
        <div>
          <div className="flex flex-wrap items-center gap-2"><CardTitle id="usage-title">Wallet and usage</CardTitle><SampleBadge /></div>
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
          <div className="flex flex-wrap items-center gap-2"><CardTitle id="checklist-title">Connections</CardTitle><SampleBadge /></div>
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
  // The API returns the next four in start order, however many bookings there are.
  const bookings = useBookings({ from, limit: 4 });
  const resources = useResources();
  const nameOf = (id: string) => resources.data?.find((item) => item.id === id);
  const upcoming = bookings.data?.items ?? [];
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
              <li key={booking.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 sm:gap-4">
                <div className="w-20 shrink-0">
                  <p className="tabular text-sm font-semibold text-fg">{formatTime(booking.startsAt, zone)}</p>
                  <p className="text-xs text-meta">{formatDay(booking.startsAt, zone)}</p>
                </div>
                <Avatar name={bookingCustomerName(booking)} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{booking.title ?? (booking.source === "website" ? "Website booking" : "Appointment")}</p>
                  <p className="truncate text-sm text-muted">{bookingCustomerName(booking) ?? "No customer linked"}</p>
                </div>
                {resource ? <Badge tone={resource.id === resources.data?.[0]?.id ? "accent" : "neutral"}>{resourceLabel(resource)}</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** What needs the owner now, first on every screen size (BRIEF: "what needs me now"). */
function NeedsYou() {
  const waiting = useInboxCount();
  const checklist = useChecklist();
  const from = useMemo(() => new Date().toISOString(), []);
  const next = useBookings({ from, limit: 4 }).data?.items[0];
  const resources = useResources();
  const zone = resources.data?.find((item) => item.id === next?.resourceId)?.timeZone ?? "America/New_York";
  const open = checklist.data?.filter((item) => item.status === "action").length ?? 0;
  const items = [
    {
      href: "/inbox",
      icon: ChatCircleDots,
      tone: waiting > 0 ? "text-info bg-info/12 ring-info/25" : "text-success bg-success/12 ring-success/25",
      title: waiting > 0 ? `${formatNumber(waiting)} waiting for you` : "Inbox clear",
      detail: waiting > 0 ? "Replies and reviews in Inbox" : "No replies or reviews waiting",
    },
    {
      href: "/calendar",
      icon: CalendarBlank,
      tone: "text-accent bg-accent/12 ring-accent/25",
      title: next ? `${formatTime(next.startsAt, zone)}, ${formatDay(next.startsAt, zone)}` : "No appointments coming up",
      detail: next ? (bookingCustomerName(next) ?? next.title ?? "Next appointment") : "Open slots are on the calendar",
    },
    {
      href: "/account/connections",
      icon: open > 0 ? WarningCircle : CheckCircle,
      tone: open > 0 ? "text-warn bg-warn/12 ring-warn/25" : "text-success bg-success/12 ring-success/25",
      title: open > 0 ? `${formatNumber(open)} connection${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you` : "Everything is connected",
      detail: open > 0 ? "Reconnect to keep requests coming in" : "Booking page, email and calendar",
    },
  ];
  return (
    <section aria-label="Needs you now" className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-12 lg:gap-4">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onPointerMove={spotlight}
          className="card-live flex min-h-16 items-center gap-3 rounded-lg bg-lit p-3 shadow-card lg:p-4"
        >
          <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-md ring-1 ring-inset", item.tone)}>
            <item.icon size={20} weight="fill" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="tabular block truncate text-sm font-semibold text-fg">{item.title}</span>
            <span className="block truncate text-xs text-meta">{item.detail}</span>
          </span>
          <ArrowRight size={16} aria-hidden className="shrink-0 text-meta" />
        </Link>
      ))}
    </section>
  );
}

export function HomeView() {
  // Staff have no `reports`: they neither see nor ask for results (H-5).
  const reports = useCan(READ_RESULTS);
  return (
    <>
      <PageHeader title="This week" description={reports ? "Results for Halden & Rowe, compared with the same time last week." : "Your next appointments at Halden & Rowe."} />
      <div className="grid grid-cols-1 gap-3 lg:grid-flow-dense lg:grid-cols-12 lg:gap-4">
        <NeedsYou />
        {reports ? <ResultsSection /> : null}
        <NextAppointments />
        <UsageCard />
        <ChecklistCard />
      </div>
    </>
  );
}
