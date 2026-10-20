// The demo adapter's Inbox, Home results and deal details follow inbox-home.md as the API does.
import { describe, expect, it } from "vitest";
import { homeResultsSchema, replyRecordSchema, threadDetailSchema, threadPageSchema } from "@zs/contracts";
import { ApiError, isDealChanged } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_BUSINESS_SUBJECT, DEMO_PIPELINE, REPAIR_ID, STAGE_IDS } from "../src/lib/api/demo/seed";

// Sunday 2026-10-18, 09:00 in New York: the week began Monday 2026-10-12.
const NOW = new Date("2026-10-18T13:00:00.000Z");
const WEEK = { zone: "America/New_York", weekStart: "monday" as const };

function adapter(now = NOW) {
  let ids = 0;
  let clock = now;
  const api = createDemoAdapter({
    clock: { now: () => clock },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return Object.assign(api, { advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } });
}

let keys = 0;
const key = () => ({ idempotencyKey: `inbox-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

async function thread(api: ReturnType<typeof adapter>, name: string) {
  const page = await api.listThreads({ limit: 100 });
  const summary = page.items.find((item) => item.name === name);
  if (!summary) throw new Error(`no thread for ${name}`);
  return api.getThread(summary.id);
}

describe("demo adapter: inbox", () => {
  it("lists one thread per customer and one per unlinked visitor, latest activity first, in contract shape", async () => {
    const api = adapter();
    const page = await api.listThreads({ limit: 100 });
    threadPageSchema.parse({ ...page, limit: 100, offset: 0, nextOffset: null });
    const names = page.items.map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(["Linnea Castellanos", "Noor Haddad", "Marguerite Okafor", "M. Okafor", "Teo Lindqvist", "Celeste Vandermeer"]));
    const times = page.items.map((item) => item.lastActivityAt);
    expect([...times].sort().reverse()).toEqual(times);
    const visitor = page.items.find((item) => item.name === "M. Okafor")!;
    expect(visitor).toMatchObject({ kind: "visitor", contactId: null, needsReview: true, needsReply: false, drafts: 0 });
    expect(visitor.id).toBe(`v_${visitor.intakeItemId}`);
    expect(page.items.find((item) => item.name === "Linnea Castellanos")).toMatchObject({ kind: "customer", needsReply: true, preview: "Looking at sapphire halos." });
    expect(page.items.find((item) => item.name === "Noor Haddad")).toMatchObject({ needsReply: true, drafts: 1 });
    // Marguerite's request was answered by an approved (and sent) reply.
    expect(page.items.find((item) => item.name === "Marguerite Okafor")).toMatchObject({ needsReply: false, drafts: 0 });
  });

  it("pages by cursor without repeating or skipping a thread", async () => {
    const api = adapter();
    const all = (await api.listThreads({ limit: 100 })).items.map((item) => item.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const next = await api.listThreads({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...next.items.map((item) => item.id));
      if (!next.nextCursor) break;
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(all);
  });

  it("shows a customer's website requests and replies oldest first", async () => {
    const api = adapter();
    const detail = threadDetailSchema.parse(await thread(api, "Noor Haddad"));
    expect(detail.entries.map((entry) => entry.type)).toEqual(["request", "reply"]);
    const [request, reply] = detail.entries;
    expect(request).toMatchObject({ type: "request", channel: "booking_page", notes: expect.stringContaining("engraving") });
    expect(request?.type === "request" && request.booking?.startsAt).toBeTruthy();
    expect(reply?.type === "reply" && reply.reply.status).toBe("draft");
    expect(detail.olderEntries).toBe(false);
  });

  it("says not found for a malformed or unknown thread", async () => {
    const api = adapter();
    expect(await failure(api.getThread("x_nope"))).toMatchObject({ kind: "not_found" });
    expect(await failure(api.getThread("c_00000000-0000-4000-8000-999999999999"))).toMatchObject({ kind: "not_found" });
  });

  it("drafts a reply with the default subject, approves it into the queue, and refuses a second step", async () => {
    const api = adapter();
    const linnea = await thread(api, "Linnea Castellanos");
    const draft = replyRecordSchema.parse(await api.draftReply({ contactId: linnea.contactId!, subject: null, body: "  Hello Linnea, sapphire halos are ready to view.  " }, key()));
    expect(draft).toMatchObject({ status: "draft", subject: DEMO_BUSINESS_SUBJECT, body: "Hello Linnea, sapphire halos are ready to view.", approvedAt: null });
    expect((await thread(api, "Linnea Castellanos")).drafts).toBe(1);

    api.advance(60_000);
    const approved = await api.approveReply(draft.id, key());
    expect(approved).toMatchObject({ status: "approved", settledAt: null });
    expect(approved.approvedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    const after = await thread(api, "Linnea Castellanos");
    // The approval answers the request: no reply needed any more, no draft waiting.
    expect(after).toMatchObject({ needsReply: false, drafts: 0 });

    const again = await failure(api.discardReply(draft.id, key()));
    expect(again).toMatchObject({ kind: "conflict", reason: "not_draft", details: { reason: "not_draft", status: "approved" } });
    expect(again?.message).toBe("This reply is no longer a draft. Someone approved or discarded it first.");
  });

  it("keeps a custom subject, and discards a draft so it leaves the thread", async () => {
    const api = adapter();
    const linnea = await thread(api, "Linnea Castellanos");
    const draft = await api.draftReply({ contactId: linnea.contactId!, subject: " Your visit ", body: "See you Tuesday." }, key());
    expect(draft.subject).toBe("Your visit");
    const discarded = await api.discardReply(draft.id, key());
    expect(discarded.status).toBe("discarded");
    expect((await thread(api, "Linnea Castellanos")).entries.some((entry) => entry.type === "reply")).toBe(false);
  });

  it("refuses an empty reply and a customer of another business", async () => {
    const api = adapter();
    const linnea = await thread(api, "Linnea Castellanos");
    expect(await failure(api.draftReply({ contactId: linnea.contactId!, subject: null, body: "   " }, key()))).toMatchObject({ kind: "validation", status: 400 });
    expect(await failure(api.draftReply({ contactId: "00000000-0000-4000-8000-999999999999", subject: null, body: "Hi" }, key()))).toMatchObject({ kind: "forbidden", status: 403 });
  });

  it("refuses to approve a reply to a customer without an email address", async () => {
    const api = adapter();
    const dashiell = await thread(api, "Dashiell Moreau");
    const draft = dashiell.entries.find((entry) => entry.type === "reply" && entry.reply.status === "draft");
    const error = await failure(api.approveReply(draft!.type === "reply" ? draft!.reply.id : "", key()));
    expect(error).toMatchObject({ kind: "conflict", reason: "no_email" });
  });

  it("answers not_draft when someone else approved the draft first", async () => {
    const api = adapter();
    const noor = await thread(api, "Noor Haddad");
    const draft = noor.entries.find((entry) => entry.type === "reply")!;
    const id = draft.type === "reply" ? draft.reply.id : "";
    api.approveReplyElsewhere(id);
    expect(await failure(api.approveReply(id, key()))).toMatchObject({ reason: "not_draft", details: { status: "approved" } });
  });

  it("replays a reply step for the same key and does not draft twice", async () => {
    const api = adapter();
    const linnea = await thread(api, "Linnea Castellanos");
    const input = { contactId: linnea.contactId!, subject: null, body: "Once only." };
    const options = key();
    api.loseNextResponse();
    expect(await failure(api.draftReply(input, options))).toMatchObject({ kind: "network" });
    const replayed = await api.draftReply(input, options);
    expect((await thread(api, "Linnea Castellanos")).entries.filter((entry) => entry.type === "reply").map((entry) => entry.type === "reply" && entry.reply.id)).toEqual([replayed.id]);
  });

  it("moves a visitor's request into the customer's thread once it is linked", async () => {
    const api = adapter();
    const visitor = (await api.listThreads({ limit: 100 })).items.find((item) => item.name === "M. Okafor")!;
    const before = await thread(api, "Marguerite Okafor");
    expect(before.entries.some((entry) => entry.type === "request" && entry.notes === "Clasp keeps opening.")).toBe(false);
    const item = (await api.listIntakeItems({ status: "possible_match" })).items.find((row) => row.id === visitor.intakeItemId)!;
    await api.linkIntakeItem({ itemId: item.id, contactId: item.matchedContactIds[0]! }, key());
    expect(await failure(api.getThread(visitor.id))).toMatchObject({ kind: "not_found" });
    const after = await thread(api, "Marguerite Okafor");
    expect(after.entries.some((entry) => entry.type === "request" && entry.notes === "Clasp keeps opening.")).toBe(true);
    expect(after.needsReply).toBe(true);
  });
});

describe("demo adapter: home results", () => {
  it("states both ranges and counts this week so far against the same span of last week", async () => {
    const api = adapter();
    const results = homeResultsSchema.parse(await api.getResults(WEEK));
    expect(results.thisWeek).toEqual({ from: "2026-10-12T04:00:00.000Z", to: "2026-10-19T04:00:00.000Z" });
    expect(results.lastWeek).toEqual({ from: "2026-10-05T04:00:00.000Z", to: "2026-10-11T13:00:00.000Z" });
    expect(results.leads).toMatchObject({ thisWeek: 2, lastWeek: 3 });
    expect(results.leads.bySource).toEqual([{ source: "website", thisWeek: 1, lastWeek: 0 }, { source: "manual", thisWeek: 1, lastWeek: 3 }]);
    expect(results.bookings.thisWeek).toBe(results.bookings.bySource.reduce((sum, item) => sum + item.thisWeek, 0));
    expect(results.bookings.bySource.map((item) => item.source)).toEqual(["website", "owner"]);
    expect(results.wonDeals).toEqual({ thisWeek: 2, lastWeek: 1 });
    expect(results.revenue).toEqual([{
      currency: "USD", thisWeek: 1_375_000, lastWeek: 125_000,
      bySource: [{ source: "website", thisWeek: 735_000, lastWeek: 0 }, { source: "walk_in", thisWeek: 640_000, lastWeek: 0 }, { source: "referral", thisWeek: 0, lastWeek: 125_000 }],
    }]);
  });

  it("counts a new booking and a new customer in this week", async () => {
    const api = adapter();
    const before = await api.getResults(WEEK);
    const { slots } = await api.getSlots({ resourceId: REPAIR_ID, from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" });
    await api.createBooking({ resourceId: REPAIR_ID, startsAt: slots[0]!.startsAt }, key());
    await api.createOrFindContact({ displayName: "Lior Benzaquen", email: "lior@example.com", phone: null }, key());
    const after = await api.getResults(WEEK);
    expect(after.bookings.thisWeek).toBe(before.bookings.thisWeek + 1);
    expect(after.bookings.bySource[1]!.thisWeek).toBe(before.bookings.bySource[1]!.thisWeek + 1);
    expect(after.leads.bySource[1]!.thisWeek).toBe(before.leads.bySource[1]!.thisWeek + 1);
  });

  it("weeks can start on Sunday", async () => {
    const results = await adapter().getResults({ zone: "America/New_York", weekStart: "sunday" });
    expect(results.thisWeek.from).toBe("2026-10-18T04:00:00.000Z");
    expect(results.lastWeek).toEqual({ from: "2026-10-11T04:00:00.000Z", to: "2026-10-11T13:00:00.000Z" });
  });

  it("refuses a zone that is not an IANA zone", async () => {
    expect(await failure(adapter().getResults({ zone: "Mars/Olympus", weekStart: "monday" }))).toMatchObject({ kind: "validation" });
  });
});

describe("demo adapter: deal details", () => {
  it("sets value and lead source with the revision check, and dates a win when the deal enters a won stage", async () => {
    const api = adapter();
    const deal = (await api.listDeals()).items.find((item) => item.title === "Matching wedding bands")!;
    expect(deal).toMatchObject({ value: null, leadSource: "social", wonAt: null });
    const updated = await api.setDealDetails({ dealId: deal.id, expectedRevision: deal.revision, value: { amountMinor: 520_000, currency: "USD" }, leadSource: "referral" }, key());
    expect(updated).toMatchObject({ value: { amountMinor: 520_000, currency: "USD" }, leadSource: "referral", revision: deal.revision + 1 });

    const stale = await failure(api.setDealDetails({ dealId: deal.id, expectedRevision: deal.revision, value: null, leadSource: null }, key()));
    expect(isDealChanged(stale)).toBe(true);
    expect(stale?.details.currentRevision).toBe(deal.revision + 1);

    const moved = await api.moveDealStage({ dealId: deal.id, pipelineId: DEMO_PIPELINE.id, stageId: STAGE_IDS.delivered, expectedRevision: updated.revision }, key());
    // The stage move answers with the frozen record; the list carries the won date.
    expect(moved).not.toHaveProperty("wonAt");
    const listed = (await api.listDeals()).items.find((item) => item.id === deal.id)!;
    expect(listed.wonAt).toBe(NOW.toISOString());
    const results = await api.getResults(WEEK);
    expect(results.revenue[0]!.thisWeek).toBe(1_375_000 + 520_000);
    expect(results.wonDeals.thisWeek).toBe(3);

    const back = await api.moveDealStage({ dealId: deal.id, pipelineId: DEMO_PIPELINE.id, stageId: STAGE_IDS.inquiry, expectedRevision: moved.revision }, key());
    expect((await api.listDeals()).items.find((item) => item.id === back.id)!.wonAt).toBeNull();
  });

  it("refuses a negative or fractional amount and an unknown deal", async () => {
    const api = adapter();
    const deal = (await api.listDeals()).items[0]!;
    expect(await failure(api.setDealDetails({ dealId: deal.id, expectedRevision: deal.revision, value: { amountMinor: -1, currency: "USD" }, leadSource: null }, key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.setDealDetails({ dealId: deal.id, expectedRevision: deal.revision, value: { amountMinor: 1, currency: "usd" }, leadSource: null }, key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.setDealDetails({ dealId: "00000000-0000-4000-8000-999999999999", expectedRevision: 1, value: null, leadSource: null }, key()))).toMatchObject({ kind: "forbidden" });
  });
});
