// Audit W4/W8: the dashboard asks the API for the rows it shows. A fake API with the real
// routes' filters and paging stands in, with more rows than the old 2,000-row page cap.
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const TENANT = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const RESOURCE = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61";
const HOUR = 3_600_000;
const id = (prefix: string, n: number) => `${prefix}-7d3f-4c8a-9b1e-${String(n).padStart(12, "0")}`;

interface Row { [key: string]: unknown }
function fakeApi(data: { bookings?: Row[]; contacts?: Row[]; deals?: Row[] }) {
  const requests: URL[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const page = (rows: Row[], url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    // The fake's cursor is a row index; the client only passes it back.
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const more = start + limit < rows.length;
    return json(200, { items: rows.slice(start, start + limit), limit, offset: 0, nextOffset: null, nextCursor: more ? String(start + limit) : null });
  };
  const api = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const q = url.searchParams;
      if (url.pathname === "/v1/booking/bookings") {
        const from = q.get("from"), to = q.get("to");
        return page((data.bookings ?? []).filter((row) => (!from || String(row.endsAt) > from) && (!to || String(row.startsAt) < to)), url);
      }
      const one = url.pathname.match(/^\/v1\/crm\/contacts\/(.+)$/);
      if (one) {
        const found = (data.contacts ?? []).find((row) => row.id === one[1]);
        return found ? json(200, found) : json(404, { error: { code: "NotFound", message: "Not found", details: {} } });
      }
      if (url.pathname === "/v1/crm/contacts") {
        const search = q.get("search")?.toLowerCase();
        const ids = q.get("ids")?.split(",");
        return page((data.contacts ?? []).filter((row) =>
          (!search || String(row.displayName).toLowerCase().includes(search)) && (!ids || ids.includes(String(row.id)))), url);
      }
      if (url.pathname === "/v1/crm/deals") {
        const contactId = q.get("contactId");
        return page((data.deals ?? []).filter((row) => !contactId || row.contactId === contactId), url);
      }
      return json(404, { error: { code: "NotFound", message: "Not found", details: {} } });
    },
  });
  return { api, requests };
}

const booking = (n: number, startsAt: string): Row => ({
  id: id("b8c2d4e6", n), tenantId: TENANT, resourceId: RESOURCE, startsAt,
  endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(), occupiedStartsAt: startsAt,
  occupiedEndsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(), bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  status: "confirmed", createdAt: "2026-01-01T00:00:00.000Z", source: "owner", intakeItemId: null, customer: null,
});
const contact = (n: number, name: string): Row => ({
  id: id("5e0c1a2b", n), tenantId: TENANT, displayName: name, email: null, phone: "+16465550100",
  consent: { email: null, sms: null }, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
});

describe("reads past 2,000 rows", () => {
  it("shows the current day's booking however many older bookings come first", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const history = Array.from({ length: 2_001 }, (_, n) => booking(n, new Date(start + n * HOUR).toISOString()));
    const { api, requests } = fakeApi({ bookings: [...history, booking(9_999, "2026-10-20T15:00:00.000Z")] });
    const day = await api.listBookings({ resourceId: RESOURCE, from: "2026-10-20T04:00:00.000Z", to: "2026-10-21T04:00:00.000Z" });
    expect(day.items.map((item) => item.startsAt)).toEqual(["2026-10-20T15:00:00.000Z"]);
    expect(day.incomplete).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("from")).toBe("2026-10-20T04:00:00.000Z");
    expect(requests[0]?.searchParams.get("to")).toBe("2026-10-21T04:00:00.000Z");
  });

  it("finds a customer by search however many customers come before them", async () => {
    const contacts = [...Array.from({ length: 2_500 }, (_, n) => contact(n, `Customer ${n}`)), contact(9_999, "Zelda Quist")];
    const { api, requests } = fakeApi({ contacts });
    const found = await api.listContacts({ search: "zelda" });
    expect(found.items.map((item) => item.displayName)).toEqual(["Zelda Quist"]);
    expect(found.nextCursor).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("search")).toBe("zelda");
    expect(requests[0]?.searchParams.get("sort")).toBe("name");
  });

  it("reads the customer list one page at a time", async () => {
    const { api, requests } = fakeApi({ contacts: Array.from({ length: 2_500 }, (_, n) => contact(n, `Customer ${n}`)) });
    const first = await api.listContacts();
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe("50");
    const second = await api.listContacts({ cursor: first.nextCursor! });
    expect(second.items[0]?.displayName).toBe("Customer 50");
    expect(requests[1]?.searchParams.get("cursor")).toBe("50");
    expect(requests[1]?.searchParams.has("offset")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("opens one customer with one request, and says not found for an unknown one", async () => {
    const contacts = [...Array.from({ length: 2_500 }, (_, n) => contact(n, `Customer ${n}`)), contact(9_999, "Zelda Quist")];
    const { api, requests } = fakeApi({ contacts });
    expect((await api.getContact(id("5e0c1a2b", 9_999))).displayName).toBe("Zelda Quist");
    expect(requests.map((url) => url.pathname)).toEqual([`/v1/crm/contacts/${id("5e0c1a2b", 9_999)}`]);
    await expect(api.getContact(id("5e0c1a2b", 123_456))).rejects.toMatchObject({ kind: "not_found", code: "NotFound" });
  });

  it("reads one customer's deals by contactId", async () => {
    const deal = (n: number, contactId: string): Row => ({
      id: id("d0a1b2c3", n), tenantId: TENANT, contactId, pipelineId: id("2a4c6e80", 1), stageId: id("2a4c6e80", 2),
      title: `Deal ${n}`, revision: 1, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    });
    const mine = id("5e0c1a2b", 1);
    const { api, requests } = fakeApi({ deals: [...Array.from({ length: 2_100 }, (_, n) => deal(n, id("5e0c1a2b", 2))), deal(9_999, mine)] });
    const deals = await api.listDeals({ contactId: mine });
    expect(deals.items.map((item) => item.title)).toEqual(["Deal 9999"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get("contactId")).toBe(mine);
  });
});
