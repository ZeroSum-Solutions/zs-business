// M3c Home results (inbox-home.md H-3, H-4). Counts for this week so far and the same span of
// last week, inside ScopedDatabase.tenant (RLS); the tenant_id filters are defence in depth.
import type { HomeResults, LeadOrigin, ResultsQuery, RevenueSource } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { weekRanges } from "../home/week.js";

type Week = "this" | "last";
interface Tally { thisWeek: number; lastWeek: number }
const zero = (): Tally => ({ thisWeek: 0, lastWeek: 0 });
const add = (tally: Tally, week: Week, amount: number) => {
  if (week === "this") tally.thisWeek += amount;
  else tally.lastWeek += amount;
};
/** Sums arrive as numeric text; a total past 2^53 cannot be shown exactly, so it is refused. */
const count = (text: string) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Total is outside the safe integer range");
  return value;
};
const byThisWeek = <T extends Tally & { source?: string; currency?: string }>(a: T, b: T) =>
  b.thisWeek - a.thisWeek || b.lastWeek - a.lastWeek || String(a.source ?? a.currency).localeCompare(String(b.source ?? b.currency));

/** Which range a timestamp column falls in ($2..$5 are this week's and last week's bounds). */
const week = (column: string) =>
  `CASE WHEN ${column} >= $2 AND ${column} < $3 THEN 'this' WHEN ${column} >= $4 AND ${column} < $5 THEN 'last' END`;
const inRanges = (column: string) => `((${column} >= $2 AND ${column} < $3) OR (${column} >= $4 AND ${column} < $5))`;

export async function homeResults(tx: Transaction, tenantId: string, query: ResultsQuery, now: number): Promise<HomeResults> {
  const { thisWeek, lastWeek } = weekRanges(now, query.zone, query.weekStart);
  const params = [tenantId, new Date(thisWeek.from), new Date(thisWeek.to), new Date(lastWeek.from), new Date(lastWeek.to)];

  // Leads: contacts created. A website request that created the contact (P-7 new_contact) makes it a website lead.
  const leads = { ...zero(), bySource: new Map<LeadOrigin, Tally>([["website", zero()], ["manual", zero()]]) };
  for (const row of (await tx.query<{ week: Week; website: boolean; n: string }>(
    `SELECT ${week("c.created_at")} AS week,
            EXISTS (SELECT 1 FROM intake_items i WHERE i.tenant_id = c.tenant_id AND i.contact_id = c.id
                       AND i.status = 'new_contact') AS website,
            count(*)::text AS n
       FROM crm_contacts c WHERE c.tenant_id=$1 AND ${inRanges("c.created_at")} GROUP BY 1, 2`, params,
  )).rows) {
    add(leads, row.week, count(row.n));
    add(leads.bySource.get(row.website ? "website" : "manual")!, row.week, count(row.n));
  }

  // Bookings taken (created) in each range, by where they came from.
  const bookings = { ...zero(), bySource: new Map<"website" | "owner", Tally>([["website", zero()], ["owner", zero()]]) };
  for (const row of (await tx.query<{ week: Week; source: "website" | "owner"; n: string }>(
    `SELECT ${week("created_at")} AS week, source, count(*)::text AS n
       FROM bookings WHERE tenant_id=$1 AND ${inRanges("created_at")} GROUP BY 1, 2`, params,
  )).rows) {
    add(bookings, row.week, count(row.n));
    add(bookings.bySource.get(row.source)!, row.week, count(row.n));
  }

  // Revenue: value of deals won in each range, per currency and lead source.
  const wonDeals = zero();
  const revenue = new Map<string, Tally & { bySource: Map<RevenueSource, Tally> }>();
  for (const row of (await tx.query<{ week: Week; currency: string | null; source: RevenueSource; n: string; total: string | null }>(
    `SELECT ${week("won_at")} AS week, currency, coalesce(lead_source, 'unset') AS source,
            count(*)::text AS n, sum(value_minor)::text AS total
       FROM crm_deals WHERE tenant_id=$1 AND won_at IS NOT NULL AND ${inRanges("won_at")} GROUP BY 1, 2, 3`, params,
  )).rows) {
    add(wonDeals, row.week, count(row.n));
    if (row.currency === null || row.total === null) continue;
    const entry = revenue.get(row.currency) ?? { ...zero(), bySource: new Map() };
    const source = entry.bySource.get(row.source) ?? zero();
    add(entry, row.week, count(row.total));
    add(source, row.week, count(row.total));
    entry.bySource.set(row.source, source);
    revenue.set(row.currency, entry);
  }
  // Each sum was checked; so is each currency's total across sources.
  for (const entry of revenue.values())
    if (!Number.isSafeInteger(entry.thisWeek) || !Number.isSafeInteger(entry.lastWeek))
      throw new RangeError("Total is outside the safe integer range");

  const list = <S extends string>(map: Map<S, Tally>) => [...map].map(([source, tally]) => ({ source, ...tally }));
  return {
    zone: query.zone,
    weekStart: query.weekStart,
    thisWeek: { from: new Date(thisWeek.from).toISOString(), to: new Date(thisWeek.to).toISOString() },
    lastWeek: { from: new Date(lastWeek.from).toISOString(), to: new Date(lastWeek.to).toISOString() },
    leads: { thisWeek: leads.thisWeek, lastWeek: leads.lastWeek, bySource: list(leads.bySource) },
    bookings: { thisWeek: bookings.thisWeek, lastWeek: bookings.lastWeek, bySource: list(bookings.bySource) },
    wonDeals,
    revenue: [...revenue].map(([currency, entry]) => ({
      currency, thisWeek: entry.thisWeek, lastWeek: entry.lastWeek, bySource: list(entry.bySource).sort(byThisWeek),
    })).sort(byThisWeek),
  };
}
