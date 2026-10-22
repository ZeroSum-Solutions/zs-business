"use client";

import { ArrowRight, CalendarBlank, ChatCircleDots, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardTitle, Tray, TrayBody, TrayHeader, TrayTitle } from "@/components/ui/card";
import { KpiTile } from "@/components/ui/kpi-tile";
import { SampleBadge, useSampleOnly } from "@/components/ui/sample";
import { EmptyState, ErrorNote, LoadingRows, Skeleton } from "@/components/ui/states";
import { OWNER } from "@/components/shell/account-menu";
import { bookingCustomerName, type HomeResults } from "@/lib/api";
import { ORIGIN_LABELS, revenueSourceLabel } from "@/lib/lead-sources";
import { useBookings, useChecklist, useDisplayZone, useInboxCount, useResources, useResults, useThreads, useUsage } from "@/lib/queries";
import { resourceLabel } from "@/lib/resources";
import { READ_RESULTS, useCan } from "@/lib/session";
import { addDays, formatDateKey, formatDay, formatRange, formatTime, startOfZonedDay, weekdayOf, zonedDateKey, zonedParts } from "@/lib/time";
import { cn, currencyDigits, formatMinor, formatMoney, formatNumber, weekChange } from "@/lib/utils";
import type { BookingView } from "@/lib/api";

interface WeekCompare {
  thisWeek: number;
  lastWeek: number;
}

/** A count or an amount this week against the same span last week, as a KPI tile. */
function WeekTile({ id, label, compare, format, valueTestId, step = 1, className, children }: {
  id: string;
  label: string;
  compare: WeekCompare;
  format: (value: number) => string;
  valueTestId: string;
  /** Rolling frames snap to this many units, so a whole amount never flashes cents mid-roll. */
  step?: number;
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
    { label: "This week", value: compare.thisWeek, bar: "bg-primary" },
    { label: "Same time last week", value: compare.lastWeek, bar: "bg-border-strong" },
  ];
  return (
    <ul className="space-y-1.5 text-xs" aria-label="This week and last week">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="text-meta">{row.label}</span>
          <span className="tabular text-fg-2">{format(row.value)}</span>
          <span aria-hidden className="col-span-2 h-1.5 overflow-hidden rounded-pill bg-tray">
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
    <ul className="space-y-1.5 border-t border-border pt-3 text-sm" aria-label={`${label} by source`}>
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
      <Card className="col-span-2 lg:col-span-1" aria-labelledby="revenue-title">
        <CardTitle id="revenue-title" className="text-sm font-bold text-muted">Revenue this week</CardTitle>
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
      className="col-span-2 lg:col-span-1 lg:self-stretch"
    >
      <p className="tabular text-xs text-meta">
        {formatNumber(won.thisWeek)} won this week, {formatNumber(won.lastWeek)} last week.
      </p>
      <div className="border-t border-border pt-3">
        <h3 className="mb-2 text-xs font-bold tracking-[0.06em] text-muted uppercase">By lead source</h3>
        <ul className="grid gap-3 sm:grid-cols-3 sm:gap-5">
          {main.bySource.map((item) => (
            <li key={item.source} data-source={item.source}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg-2">{revenueSourceLabel(item.source)}</span>
                <span className="tabular font-medium text-fg">{formatMinor(item.thisWeek, main.currency)} <span className="text-xs font-normal text-meta">last {formatMinor(item.lastWeek, main.currency)}</span></span>
              </div>
              <div className="mt-1 space-y-0.5" aria-hidden>
                <div className="h-1.5 rounded-pill bg-primary" style={{ width: `${(item.thisWeek / maxSource) * 100}%` }} />
                <div className="h-1 rounded-pill bg-border-strong" style={{ width: `${(item.lastWeek / maxSource) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-center gap-4 text-xs text-meta">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-4 rounded-pill bg-primary" />This week</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1 w-4 rounded-pill bg-border-strong" />Last week</span>
        </p>
      </div>
      {others.length > 0 ? (
        <div className="border-t border-border pt-3">
          <h3 className="text-xs font-bold tracking-[0.06em] text-muted uppercase">Other currencies</h3>
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
  return (
    <Tray className="lg:col-span-12" aria-labelledby="results-title">
      <TrayHeader>
        <TrayTitle id="results-title">Results</TrayTitle>
        {results.isSuccess ? <RangesNote data={results.data} /> : null}
      </TrayHeader>
      {results.isPending ? (
        <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-[2fr_1fr_1fr] lg:gap-2"><Skeleton className="col-span-2 h-40 lg:col-span-1" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : results.isError ? (
        <ErrorNote error={results.error} retry={() => results.refetch()} />
      ) : (
        <TrayBody className="grid-cols-2 items-stretch lg:grid-cols-[2fr_1fr_1fr]">
          <RevenueTile data={results.data} />
          <WeekTile id="leads" label="New leads" compare={results.data.leads} format={formatNumber} valueTestId="tile-value">
            <SourceRows label="New leads" bySource={results.data.leads.bySource} />
          </WeekTile>
          <WeekTile id="bookings" label="Bookings" compare={results.data.bookings} format={formatNumber} valueTestId="tile-value">
            <SourceRows label="Bookings" bySource={results.data.bookings.bySource} />
          </WeekTile>
        </TrayBody>
      )}
    </Tray>
  );
}

function RangesNote({ data }: { data: HomeResults }) {
  const ranges = `This week: ${formatRange(data.thisWeek.from, data.thisWeek.to, data.zone)}. Compared with the same span of last week: ${formatRange(data.lastWeek.from, data.lastWeek.to, data.zone)}. Times in ${data.zone.replaceAll("_", " ")}.`;
  // The full ranges are read out and shown on hover; the line is the short form.
  return (
    <p className="text-caption text-muted" title={ranges}>
      <span aria-hidden>Since {formatDay(data.thisWeek.from, data.zone)}, compared with the same time last week</span>
      <span className="sr-only" data-testid="results-ranges">{ranges}</span>
    </p>
  );
}

function TrayLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="-my-2 inline-flex min-h-11 items-center gap-1 rounded-pill text-sm font-bold text-accent-ink hover:underline underline-offset-4">
      {children} <ArrowRight size={16} aria-hidden />
    </Link>
  );
}

/** A small rounded icon tile in front of a card's title. */
function IconTile({ tone, children }: { tone: "accent" | "warn" | "success" | "neutral"; children: ReactNode }) {
  const tones = {
    accent: "bg-accent-tint text-accent-ink",
    warn: "bg-warn-tint text-warn",
    success: "bg-success-tint text-success",
    neutral: "bg-tray text-muted",
  } as const;
  return <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-md", tones[tone])}>{children}</span>;
}

function Meter({ percent, className }: { percent: number; className?: string }) {
  return (
    <div aria-hidden className={cn("relative h-1.5", className)}>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
      <span className="absolute inset-y-0 left-0 rounded-pill bg-fg" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function UsageCard({ className }: { className?: string }) {
  const usage = useUsage();
  return (
    <Tray className={className} aria-labelledby="usage-title">
      <TrayHeader>
        <div className="flex flex-wrap items-center gap-2"><TrayTitle id="usage-title">Wallet and usage</TrayTitle><SampleBadge /></div>
      </TrayHeader>
      {usage.isPending ? <Card><LoadingRows rows={3} /></Card> : usage.isError ? <Card><ErrorNote error={usage.error} retry={() => usage.refetch()} /></Card> : (
        <TrayBody className="sm:grid-cols-3">
          <Card className="sm:col-span-3">
            <p className="text-sm font-bold text-muted">Balance</p>
            <p className="tabular mt-1 text-[32px] leading-none font-extrabold tracking-display text-fg">{formatMoney(usage.data.walletBalance, usage.data.currency, 2)}</p>
            <div
              role="meter"
              aria-label="Wallet balance"
              aria-valuemin={0}
              aria-valuemax={usage.data.walletTopUp}
              aria-valuenow={usage.data.walletBalance}
              aria-valuetext={`${formatMoney(usage.data.walletBalance, usage.data.currency, 2)} of ${formatMoney(usage.data.walletTopUp, usage.data.currency)}`}
              className="mt-4"
            >
              <Meter percent={(usage.data.walletBalance / usage.data.walletTopUp) * 100} />
            </div>
            <p className="mt-3 text-caption text-muted">Of your {formatMoney(usage.data.walletTopUp, usage.data.currency)} top-up. Prepaid: sending pauses at $0, so there are no surprise bills.</p>
          </Card>
          {usage.data.lines.map((line) => (
            <Card key={line.id}>
              <p className="text-sm font-bold text-muted">{line.label}</p>
              <p className="tabular mt-1 text-2xl leading-none font-extrabold tracking-display text-fg">
                {formatNumber(line.used)} <span className="text-caption font-semibold tracking-normal text-muted">of {formatNumber(line.cap)}</span>
              </p>
              <Meter percent={(line.used / line.cap) * 100} className="mt-4" />
            </Card>
          ))}
        </TrayBody>
      )}
    </Tray>
  );
}

function ChecklistCard({ className }: { className?: string }) {
  const checklist = useChecklist();
  const open = checklist.data?.filter((item) => item.status === "action").length ?? 0;
  return (
    <Tray className={className} aria-labelledby="checklist-title">
      <TrayHeader>
        <div className="flex flex-wrap items-center gap-2"><TrayTitle id="checklist-title">Connections</TrayTitle><SampleBadge /></div>
        <TrayLink href="/account/connections">Manage</TrayLink>
      </TrayHeader>
      <Card>
        <p className="sr-only">{open > 0 ? `${open} need${open === 1 ? "s" : ""} you` : "Everything is connected"}</p>
        {checklist.isPending ? <LoadingRows rows={3} /> : checklist.isError ? <ErrorNote error={checklist.error} retry={() => checklist.refetch()} /> : (
          <ul className="divide-y divide-border">
            {checklist.data.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <IconTile tone={item.status === "ok" ? "neutral" : "warn"}>
                  {item.status === "ok" ? <CheckCircle size={20} /> : <WarningCircle size={20} />}
                </IconTile>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-fg">{item.label}</p>
                  <p className="text-caption text-muted">{item.detail}</p>
                </div>
                <Badge tone={item.status === "ok" ? "success" : "warn"} className="shrink-0">{item.status === "ok" ? "Connected" : "Needs action"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Tray>
  );
}

/** "Later today", "Tomorrow" or the weekday, for a day group of appointments. */
function dayHeading(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Later today";
  if (dayKey === addDays(todayKey, 1)) return "Tomorrow";
  return formatDateKey(dayKey, "long").split(",")[0] ?? dayKey;
}

function NextAppointments({ className }: { className?: string }) {
  const from = useMemo(() => new Date().toISOString(), []);
  // The API returns the next four in start order, however many bookings there are.
  const bookings = useBookings({ from, limit: 4 });
  const resources = useResources();
  const nameOf = (id: string) => resources.data?.find((item) => item.id === id);
  const upcoming = bookings.data?.items ?? [];
  const zone = resources.data?.[0]?.timeZone ?? "America/New_York";
  const todayKey = zonedDateKey(from, zone);
  const days: { key: string; items: BookingView[] }[] = [];
  for (const booking of upcoming) {
    const key = zonedDateKey(booking.startsAt, nameOf(booking.resourceId)?.timeZone ?? zone);
    const last = days.at(-1);
    if (last?.key === key) last.items.push(booking);
    else days.push({ key, items: [booking] });
  }
  return (
    <Tray className={className} aria-labelledby="next-title">
      <TrayHeader>
        <TrayTitle id="next-title">Next appointments</TrayTitle>
        <TrayLink href="/calendar">Calendar</TrayLink>
      </TrayHeader>
      {/* Times need the calendar's zone, so wait for the resources too. */}
      {bookings.isPending || resources.isPending ? <Card><LoadingRows rows={3} /></Card> : bookings.isError ? <Card><ErrorNote error={bookings.error} retry={() => bookings.refetch()} /></Card> : resources.isError ? <Card><ErrorNote error={resources.error} retry={() => resources.refetch()} /></Card> : upcoming.length === 0 ? (
        <EmptyState title="No appointments coming up">Open slots show on the calendar.</EmptyState>
      ) : (
        <TrayBody className="flex-1 content-start">
          {days.map((day) => (
            <Card key={day.key}>
              <p className="mb-2 flex justify-between gap-3 text-xs font-bold tracking-[0.06em] text-muted uppercase">
                <span>{dayHeading(day.key, todayKey)}</span>
                <span>{formatDateKey(day.key)}</span>
              </p>
              <ul className="divide-y divide-border">
                {day.items.map((booking) => {
                  const resource = nameOf(booking.resourceId);
                  const bookingZone = resource?.timeZone ?? zone;
                  const customer = bookingCustomerName(booking);
                  return (
                    <li key={booking.id} className="flex gap-3 py-3 last:pb-0 sm:gap-4">
                      <p className="tabular w-20 shrink-0 pt-px text-sm font-bold text-fg">{formatTime(booking.startsAt, bookingZone)}</p>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-body font-semibold text-fg">{booking.title ?? (booking.source === "website" ? "Website booking" : "Appointment")}</h3>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Avatar name={customer} size="sm" />
                          <span className="min-w-0 truncate text-caption text-fg-2">{customer ?? "No customer linked"}</span>
                          {resource ? <Badge className="ml-auto" tone={resource.id === resources.data?.[0]?.id ? "accent" : "neutral"}>{resourceLabel(resource)}</Badge> : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </TrayBody>
      )}
    </Tray>
  );
}

const subscribeNever = () => () => {};
/** The current minute, client only: the server renders no clock, so nothing mismatches on hydration. */
function useNowMinute(): number | null {
  return useSyncExternalStore(subscribeNever, () => Math.floor(Date.now() / 60_000) * 60_000, () => null);
}

/** Who and what needs the owner now; Home's lede counts the same items as the tray shows. */
function useNeeds() {
  const waiting = useInboxCount();
  const threads = useThreads();
  const checklist = useChecklist();
  const from = useMemo(() => new Date().toISOString(), []);
  const bookings = useBookings({ from, limit: 4 });
  const resources = useResources();
  const next = bookings.data?.items[0];
  const zone = resources.data?.find((item) => item.id === next?.resourceId)?.timeZone ?? "America/New_York";
  const actions = checklist.data?.filter((item) => item.status === "action") ?? [];
  const people = threads.data?.pages[0]?.items.filter((thread) => thread.needsReply || thread.needsReview).map((thread) => thread.name) ?? [];
  const nextToday = next ? zonedDateKey(next.startsAt, zone) === zonedDateKey(from, zone) : false;
  const settled = !threads.isPending && !checklist.isPending && !bookings.isPending;
  const count = (waiting > 0 ? 1 : 0) + (actions.length > 0 ? 1 : 0) + (nextToday ? 1 : 0);
  return { waiting, threads, checklist, bookings, resources, next, zone, actions, people, settled, count };
}

/** "Teo, Linnea, Noor and 2 more": first names, as the owner would say them. */
function peopleLine(names: string[]): string {
  // "M. Okafor" stays whole: an initial alone names no one.
  const short = names.map((name) => {
    const first = name.split(/\s+/)[0] ?? name;
    return name.includes("@") || first.length <= 2 || first.endsWith(".") ? name : first;
  });
  if (short.length <= 4) return short.join(", ");
  return `${short.slice(0, 3).join(", ")} and ${short.length - 3} more`;
}

/** What needs the owner now, first on every screen size (BRIEF: "what needs me now"). */
function NeedsYou({ className }: { className?: string }) {
  const { waiting, threads, checklist, bookings, resources, next, zone, actions, people, count, settled } = useNeeds();
  const sampleOnly = useSampleOnly();
  const open = actions.length;
  // Never claim "clear" or "nothing" before the answer is in: say so while loading or after a failure.
  const unknown = (query: { isPending: boolean; isError: boolean }) =>
    query.isPending ? { title: "Checking…", detail: "Loading" } : query.isError ? { title: "Couldn't check", detail: "Open to try again" } : null;
  const inbox = unknown(threads);
  // The time needs the calendar's zone, so it waits for the resources too.
  const calendar = unknown(bookings) ?? (next ? unknown(resources) : null);
  const connections = unknown(checklist);
  const resource = resources.data?.find((item) => item.id === next?.resourceId);
  const customer = next ? bookingCustomerName(next) : null;

  const inboxTitle = inbox?.title ?? (waiting > 0 ? `${formatNumber(waiting)} waiting for you` : threads.hasNextPage ? "No recent replies waiting" : "Inbox clear");
  // The count reads the newest page of threads; with more pages, the claim says "recent".
  const inboxDetail = inbox?.detail ?? (waiting > 0 ? "Replies and reviews in Inbox" : threads.hasNextPage ? "Older conversations not checked" : "No replies or reviews waiting");
  const calendarTitle = calendar?.title ?? (next ? `Next: ${formatTime(next.startsAt, zone)}, ${formatDay(next.startsAt, zone)}` : "No appointments coming up");
  const calendarDetail = calendar?.detail ?? (next ? (next.title ?? customer ?? "Next appointment") : "Open slots are on the calendar");
  const connectionsTitle = connections?.title ?? (open > 0 ? `${formatNumber(open)} connection${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you` : "Everything is connected");
  // Live mode still reads the sample checklist (see SampleBadge); the tile says so too.
  const connectionsDetail = connections?.detail ?? (sampleOnly ? "Sample data until connections ship" : open > 0 ? "Fix these to keep requests coming in." : "Booking page, email and calendar");

  const row = (icon: ReactNode, tone: Parameters<typeof IconTile>[0]["tone"], title: string, detail: string, foot?: ReactNode, arrow = true) => (
    <span className="flex items-start gap-3 lg:gap-4">
      <IconTile tone={tone}>{icon}</IconTile>
      <span className="min-w-0 flex-1">
        <span className="tabular block text-body leading-6 font-bold text-fg">{title}</span>
        <span className="block text-caption text-muted">{detail}</span>
        {foot}
      </span>
      {arrow ? <ArrowRight size={18} aria-hidden className="mt-1 shrink-0 text-muted" /> : null}
    </span>
  );
  const linkCard = "card card-live block p-4 lg:px-6 lg:py-5";

  return (
    <Tray className={className} aria-label="Needs you now">
      <TrayHeader>
        <TrayTitle className="flex items-center gap-2">
          Needs you
          {settled ? <span className="tabular inline-flex size-[22px] items-center justify-center rounded-pill bg-ink text-xs font-extrabold text-ink-on" aria-label={`${count} ${count === 1 ? "item" : "items"}`}>{count}</span> : null}
        </TrayTitle>
      </TrayHeader>
      <TrayBody>
        <Link href="/inbox" className={linkCard}>
          {row(
            <ChatCircleDots size={22} />,
            inbox || (waiting === 0 && threads.hasNextPage) ? "neutral" : waiting > 0 ? "accent" : "success",
            inboxTitle,
            inboxDetail,
            !inbox && people.length > 0 ? (
              <span className="mt-2.5 flex items-center gap-2.5">
                <span aria-hidden className="flex shrink-0 -space-x-2">
                  {people.slice(0, 4).map((name, index) => <Avatar key={`${name}-${index}`} name={name} size="sm" className="ring-2 ring-surface" />)}
                </span>
                <span className="min-w-0 truncate text-caption text-fg-2">{peopleLine(people)}</span>
              </span>
            ) : undefined,
          )}
        </Link>
        <Link href="/calendar" className={linkCard}>
          {row(
            <CalendarBlank size={22} />,
            calendar ? "neutral" : "accent",
            calendarTitle,
            calendarDetail,
            !calendar && next ? (
              <span className="mt-2.5 flex flex-wrap items-center gap-2">
                <Avatar name={customer} size="sm" />
                <span className="min-w-0 truncate text-caption text-fg-2">{customer ?? "No customer linked"}</span>
                {resource ? <Badge>{resourceLabel(resource)}</Badge> : null}
              </span>
            ) : undefined,
          )}
        </Link>
        {!connections && open > 0 ? (
          <section className="card p-4 lg:px-6 lg:py-5" aria-label={connectionsTitle}>
            {row(<WarningCircle size={22} />, "warn", connectionsTitle, connectionsDetail, undefined, false)}
            <ul className="mt-4 divide-y divide-border rounded-md bg-inset px-3.5">
              {actions.map((item, index) => (
                <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-bold text-fg">{item.label}</p>
                    <p className="text-caption text-muted">{item.detail}</p>
                  </div>
                  {item.actionLabel ? (
                    <Button asChild variant={index === 0 ? "ink" : "secondary"} className="shrink-0">
                      <Link href="/account/connections">{item.actionLabel}</Link>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <Link href="/account/connections" className={linkCard}>
            {row(
              !connections && open > 0 ? <WarningCircle size={22} /> : <CheckCircle size={22} />,
              connections ? "neutral" : open > 0 ? "warn" : "success",
              connectionsTitle,
              connectionsDetail,
            )}
          </Link>
        )}
      </TrayBody>
    </Tray>
  );
}

/** Monday to Sunday of the current week, with a dot on days that have appointments. */
function WeekStrip({ className }: { className?: string }) {
  const now = useNowMinute();
  const zone = useDisplayZone();
  const resources = useResources();
  if (now === null || resources.isPending) return <div aria-hidden className={cn("h-[78px]", className)} />;
  return <WeekDays now={now} zone={zone} className={className} />;
}

function WeekDays({ now, zone, className }: { now: number; zone: string; className?: string | undefined }) {
  const today = zonedDateKey(now, zone);
  const monday = addDays(today, 1 - weekdayOf(today));
  const query = useMemo(() => ({
    from: startOfZonedDay(monday, zone).toISOString(),
    to: startOfZonedDay(addDays(monday, 7), zone).toISOString(),
    limit: 100,
  }), [monday, zone]);
  const bookings = useBookings(query);
  const counts = new Map<string, number>();
  for (const booking of bookings.data?.items ?? []) {
    const key = zonedDateKey(booking.startsAt, zone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  return (
    <ol aria-label="Days this week" className={cn("tray grid grid-cols-7 gap-0.5 p-1.5!", className)}>
      {days.map((key) => {
        const count = counts.get(key) ?? 0;
        const isToday = key === today;
        const past = key < today;
        const [weekday = "", rest = ""] = formatDateKey(key, "long").split(", ");
        const label = `${weekday}, ${rest}${isToday ? ", today" : ""}${count > 0 ? `, ${count} appointment${count === 1 ? "" : "s"}` : ""}`;
        return (
          <li
            key={key}
            aria-label={label}
            aria-current={isToday ? "date" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-[20px] py-2 text-[11px] font-bold tracking-[0.04em] uppercase",
              isToday ? "bg-surface text-accent-ink shadow-card" : past ? "text-muted" : "text-fg-2",
            )}
          >
            <span aria-hidden>{weekday.slice(0, 3)}</span>
            <b aria-hidden className={cn("tabular text-lg leading-6 font-extrabold tracking-normal", isToday ? "text-accent-ink" : past ? "text-muted" : "text-fg")}>{Number(key.slice(8))}</b>
            <i aria-hidden className={cn("size-1.5 rounded-pill", count > 0 ? "bg-primary" : "bg-transparent")} />
          </li>
        );
      })}
    </ol>
  );
}

function greeting(now: number, zone: string): string {
  const hour = Math.floor(zonedParts(now, zone).minute / 60);
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function HomeHeader({ reports }: { reports: boolean }) {
  const now = useNowMinute();
  const zone = useDisplayZone();
  const { count, settled } = useNeeds();
  const first = OWNER.name.split(" ")[0];
  const things = count === 0 ? "Nothing needs you right now." : `${count === 1 ? "One thing needs" : `${count === 2 ? "Two" : "Three"} things need`} you today.`;
  return (
    <header className="mb-5 grid items-end gap-6 lg:mb-8 lg:grid-cols-[1fr_minmax(0,520px)] lg:gap-8 lg:pt-2">
      <div className="min-w-0">
        <p className="min-h-5 text-caption font-semibold text-muted">{now === null ? null : formatDay(new Date(now), zone, "long")}</p>
        <h1 className="mt-1 text-2xl leading-tight font-extrabold tracking-display lg:text-3xl">This week</h1>
        <p className="mt-2 text-body text-muted">
          {now === null ? `Hello, ${first}.` : `${greeting(now, zone)}, ${first}.`}{" "}
          {settled ? things : null}{" "}
          {reports ? "Results compare with the same time last week." : null}
        </p>
      </div>
      <WeekStrip className="hidden lg:grid" />
    </header>
  );
}

export function HomeView() {
  // Staff have no `reports`: they neither see nor ask for results (H-5).
  const reports = useCan(READ_RESULTS);
  return (
    <>
      <HomeHeader reports={reports} />
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-flow-dense lg:grid-cols-12 lg:gap-4">
        <NeedsYou className="lg:col-span-7" />
        <WeekStrip className="lg:hidden" />
        <NextAppointments className="lg:col-span-5 lg:self-stretch" />
        {reports ? <ResultsSection /> : null}
        <ChecklistCard className="lg:col-span-5 lg:col-start-8" />
        <UsageCard className="lg:col-span-7" />
      </div>
    </>
  );
}
