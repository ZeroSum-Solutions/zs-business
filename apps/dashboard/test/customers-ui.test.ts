// UI audit U2 (customers): copy, zones, long names, missing records and the page's order.
// The viewer here is in Tokyo, so a date shown in New York's zone would read a day early.
const viewerZone = process.env.TZ;
process.env.TZ = "Asia/Tokyo";

import { createElement as h } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ContactDetail } from "../src/components/customers/contact-detail";
import { PipelineBoard } from "../src/components/customers/pipeline-board";
import { CustomersView } from "../src/components/customers/customers-view";
import { WebsiteRequests } from "../src/components/customers/website-requests";
import { amountHint } from "../src/components/customers/deal-details-dialog";
import { ApiError, type ContactRecord, type IntakeItemRecord } from "../src/lib/api";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { failQuery, keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/customers",
}));

afterAll(() => {
  if (viewerZone === undefined) delete process.env.TZ;
  else process.env.TZ = viewerZone;
});

const uuid = (n: number) => `2a4c6e80-1b3d-4f5a-9c7e-${String(n).padStart(12, "0")}`;
const LONG_NAME = "Bartholomew Alexander Fitzgerald-Montgomery-Vanderbilt the Third";
// 02:00 UTC on Oct 1 is Sep 30 in New York and Oct 1 in Tokyo.
const customer: ContactRecord = {
  id: uuid(31), tenantId: DEMO_TENANT_ID, displayName: LONG_NAME, email: null, phone: "+19175550188",
  consent: { email: { status: "granted", source: "Website form", recordedAt: "2026-10-01T02:00:00.000Z" } as never, sms: null },
  createdAt: "2026-10-01T02:00:00.000Z", updatedAt: "2026-10-01T02:00:00.000Z",
};

function detail(fill: Parameters<typeof renderScreen>[1] = {}) {
  // React marks text joins with empty comments; drop them to read the text.
  return renderScreen(h(ContactDetail, { id: customer.id }), fill).replaceAll("<!-- -->", "");
}

const withCustomer = { fill: (client: import("@tanstack/react-query").QueryClient) => {
  client.setQueryData(keys.contact(customer.id), customer);
  client.setQueryData(keys.deals({ contactId: customer.id }), {
    items: [{ id: uuid(41), tenantId: DEMO_TENANT_ID, contactId: customer.id, pipelineId: uuid(1), stageId: uuid(11), title: "Wedding set", revision: 1, createdAt: customer.createdAt, updatedAt: new Date().toISOString(), value: null, leadSource: null, wonAt: null }],
    incomplete: false, loaded: 1,
  });
  client.setQueryData(keys.pipelines, []);
} };

describe("customer page", () => {
  it("shows when the customer joined in the viewer's time zone, not New York's (U2-1)", () => {
    const html = detail(withCustomer);
    expect(html).toContain("Customer since Thu, Oct 1");
    expect(html).toContain("Website form, Thu, Oct 1");
  });

  it("calls deals deals, not commissions (U2-2)", () => {
    const html = detail(withCustomer);
    expect(html).not.toMatch(/commission/i);
    expect(html).toContain(">Deals<");
  });

  it("lets a long name wrap instead of cutting it off (U2-8)", () => {
    const heading = /<h1 class="([^"]*)"[^>]*>([^<]*)<\/h1>/.exec(detail(withCustomer));
    expect(heading?.[2]).toBe(LONG_NAME);
    expect(heading?.[1]).not.toContain("truncate");
    expect(heading?.[1]).toContain("break-words");
  });

  it("writes when a deal changed in lower case, mid-sentence (V-17)", () => {
    expect(detail(withCustomer)).toContain("Updated just now");
  });

  it("says a customer that cannot be found was not found, with a way back and no retry (U2-13)", () => {
    for (const error of [new ApiError("forbidden", "You do not have access to this."), new ApiError("not_found", "Not found."), new ApiError("validation", "Invalid id.")]) {
      const html = detail({ fill: (client) => failQuery(client, keys.contact(customer.id), error) });
      expect(html).toMatch(/<h1[^>]*>Customer not found<\/h1>/);
      expect(html).not.toContain("Try again");
      expect(html).toContain('href="/customers"');
    }
  });

  it("still offers a retry when the customer could not be read for now", () => {
    const html = detail({ fill: (client) => failQuery(client, keys.contact(customer.id), new ApiError("network", "You look offline. Check your connection and try again.")) });
    expect(html).toContain("Try again");
    expect(html).not.toContain("Customer not found");
  });
});

const request: IntakeItemRecord = {
  id: uuid(51), tenantId: DEMO_TENANT_ID, kind: "booking_request", status: "possible_match", channel: "booking_page", pageId: uuid(61),
  submitted: { name: "M. Okafor", email: "marguerite.okafor@example.com", phone: "+12125550199", notes: null },
  matchedContactIds: [], contactId: null,
} as unknown as IntakeItemRecord;

describe("customers page", () => {
  it("does not describe every business as taking commissions (U2-2)", () => {
    expect(renderScreen(h(CustomersView))).not.toMatch(/commission/i);
  });

  it("puts search above the website review queue, so results stay near it on phones (V-9)", () => {
    const html = renderScreen(h(CustomersView), { fill: (client) => {
      client.setQueryData(keys.intake("possible_match"), { items: [request], incomplete: false, loaded: 1 });
      client.setQueryData(keys.contactNames([]), []);
    } });
    expect(html.indexOf('id="contact-search"')).toBeGreaterThan(-1);
    expect(html.indexOf("Website bookings to review")).toBeGreaterThan(html.indexOf('id="contact-search"'));
  });

  it("keeps a phone number on one line (V-18)", () => {
    const html = renderScreen(h(WebsiteRequests), { fill: (client) => {
      client.setQueryData(keys.intake("possible_match"), { items: [request], incomplete: false, loaded: 1 });
      client.setQueryData(keys.contactNames([]), []);
    } });
    expect(html).toMatch(/<span class="[^"]*whitespace-nowrap[^"]*">\+1 212 555 0199<\/span>/);
  });

  it("does not repeat the offline note the customer list already shows (U2-15)", () => {
    const offline = new ApiError("network", "You look offline. Check your connection and try again.");
    const html = renderScreen(h(WebsiteRequests), { fill: (client) => failQuery(client, keys.intake("possible_match"), offline) });
    expect(html).not.toContain(offline.message);
    expect(html).toContain("Website bookings to review could not load.");
    expect(html).toContain("Try again");
  });
});

// The business's calendar is in New York; the viewer is in Tokyo.
const newYork = { id: uuid(71), tenantId: DEMO_TENANT_ID, name: "Front desk", timeZone: "America/New_York" } as never;
const sales = { id: uuid(1), name: "Sales", stages: [{ id: uuid(11), name: "Inquiry", position: 0, outcome: "open" }, { id: uuid(12), name: "Won", position: 1, outcome: "won" }] };

describe("pipeline board", () => {
  it("shows when a deal was won in the viewer's time zone, not the calendar's (U2-1)", () => {
    const won = { id: uuid(42), tenantId: DEMO_TENANT_ID, contactId: customer.id, pipelineId: sales.id, stageId: uuid(12), title: "Wedding set", revision: 2, createdAt: customer.createdAt, updatedAt: customer.updatedAt, value: null, leadSource: null, wonAt: "2026-10-01T02:00:00.000Z" };
    const html = renderScreen(h(PipelineBoard), { fill: (client) => {
      client.setQueryData(keys.resources, [newYork]);
      client.setQueryData(keys.pipelines, [sales]);
      client.setQueryData(keys.deals({ pipelineId: sales.id }), { items: [won], incomplete: false, loaded: 1 });
      client.setQueryData(keys.contactNames([customer.id]), [customer]);
    } }).replaceAll("<!-- -->", "");
    expect(html).toContain("Won Thu, Oct 1");
  });

  it("keeps a website booking in its calendar's time zone", () => {
    const booked = { ...request, booking: { resourceId: uuid(71), startsAt: "2026-10-01T02:00:00.000Z", endsAt: "2026-10-01T03:00:00.000Z" } } as IntakeItemRecord;
    const html = renderScreen(h(WebsiteRequests), { fill: (client) => {
      client.setQueryData(keys.resources, [newYork]);
      client.setQueryData(keys.intake("possible_match"), { items: [booked], incomplete: false, loaded: 1 });
      client.setQueryData(keys.contactNames([]), []);
    } }).replaceAll("<!-- -->", "");
    expect(html).toContain("Wed, Sep 30, 10:00 PM");
  });
});

describe("deal details", () => {
  it("words the amount hint from the currency's decimals (U2-14)", () => {
    expect(amountHint("JPY")).toBe("Enter a whole amount like 1250.");
    expect(amountHint("USD")).toBe("Enter an amount like 1250 or 1250.50.");
    expect(amountHint("BHD")).toBe("Enter an amount like 1250 or 1250.500.");
  });
});
