// The setup screens (industry-templates.md IT-7, IT-8, IT-10, IT-11), rendered as their first paint:
// four cards, the full preview with hours and the zone, the applied view and its switch, the staff
// view read-only, the Home line before setup only, recommended connections first, and New deal.
const viewerZone = process.env.TZ;
process.env.TZ = "Asia/Tokyo";

import { INDUSTRY_TEMPLATE_IDS, INDUSTRY_TEMPLATES, industryTemplatePreview, type SetupRead } from "@zs/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/components/account/connections-view";
import { createDealWithValue, NewDealButton, NO_PIPELINE_REASON, PIPELINES_NOT_LOADED } from "../src/components/customers/new-deal-dialog";
import { SetupLine } from "../src/components/home/setup-line";
import { ApplyTemplate, OWNER_ONLY_TOGGLE, SENDING_OFF, SetupView, STAFF_SETUP_DESCRIPTION } from "../src/components/setup/setup-view";
import { ApiError } from "../src/lib/api";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_PIPELINE } from "../src/lib/api/demo/seed";
import { failQuery, keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/setup",
}));

afterAll(() => {
  if (viewerZone === undefined) delete process.env.TZ;
  else process.env.TZ = viewerZone;
});

const PAGE = "7c9e1b3d-5f7a-4b9c-8d1e-0000000000aa";
const RESOURCE = "0b7e5c1a-9d2f-4a3b-8c6d-0000000000aa";
const PIPELINE = "2a4c6e80-1b3d-4f5a-9c7e-0000000000aa";
const templates = INDUSTRY_TEMPLATE_IDS.map((id) => industryTemplatePreview(INDUSTRY_TEMPLATES[id]));
const fresh: SetupRead = { applied: null, timeZone: null, templates };
const applied = (templateId: (typeof INDUSTRY_TEMPLATE_IDS)[number], published = false): SetupRead => ({
  applied: { templateId, templateVersion: 1, appliedAt: "2026-11-07T10:00:00.000Z", pipelineId: PIPELINE, resourceId: RESOURCE, bookingPageId: PAGE, published },
  timeZone: "Europe/London",
  templates,
});
const page = (published: boolean) => ({
  id: PAGE, title: "Book a consultation", published, disclosureVersion: "2026-11", resourceIds: [RESOURCE], publicKey: "k",
  bookingUrl: "https://book.example.com/book/k", embedScript: "", embedIframe: "",
});
const text = (html: string) => html.replaceAll("<!-- -->", "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
const render = (node: Parameters<typeof renderScreen>[0], fill: (client: QueryClient) => void, staff = false) =>
  text(renderScreen(node, { fill, staff }));

describe("/setup before a template is applied", () => {
  it("shows the four templates as cards with stages, appointments, hours, page title and connections", () => {
    const html = render(h(SetupView), (client) => client.setQueryData(keys.setup, fresh));
    for (const template of templates) {
      expect(html).toContain(`data-testid="template-${template.id}"`);
      expect(html).toContain(template.label);
      expect(html).toContain(template.bookingPage.title);
      expect(html).toContain(template.pipeline.stages.map((stage) => stage.name).join(", "));
    }
    expect(html).toContain("Consultation, 45 minutes");
    expect(html).toContain("Mon–Fri 9:00 AM–5:00 PM");
    expect(html).toContain("Sat 10:00 AM–4:00 PM");
    expect(html).toContain("Shopify, Google Calendar");
    expect(html.match(/See the full preview/g)).toHaveLength(4);
  });

  it("is read-only for staff: no preview to confirm", () => {
    const html = render(h(SetupView), (client) => client.setQueryData(keys.setup, fresh), true);
    expect(html).toContain(STAFF_SETUP_DESCRIPTION);
    expect(html.match(/data-testid="template-/g)).toHaveLength(4);
    expect(html).not.toContain("See the full preview");
  });

  it("shows a failed read with Try again", () => {
    const html = render(h(SetupView), (client) => failQuery(client, keys.setup, new ApiError("server", "Something went wrong on our side. Try again.")));
    expect(html).toContain("Something went wrong on our side");
  });
});

describe("the preview and confirm", () => {
  const preview = (profileZone: string | null) =>
    render(h(ApplyTemplate, { template: templates[3]!, profileZone, onBack: () => undefined }), () => undefined);

  it("shows the full resolved preview: stages, hours, buffers, notice, page, messages", () => {
    const html = preview(null);
    expect(html).toContain("Gym or personal trainer");
    expect(html).toContain("Pipeline: New clients");
    expect(html).toContain("Signed up");
    expect(html).toContain("Mon–Fri 6:00 AM–8:00 PM");
    expect(html).toContain("Sat 8:00 AM–2:00 PM");
    expect(html).toContain("30 minutes, starting every 15 minutes");
    expect(html).toContain("At least 2 hours ahead, up to 60 days ahead");
    expect(html).toContain("Booking page: Book a free intro");
    expect(html).toContain("24 hours before the appointment, by email");
    expect(html).toContain("24 hours after the appointment, by email");
    expect(html).toContain(SENDING_OFF);
    expect(html).toContain("Set up with this template");
  });

  it("starts the zone from the profile, else from the browser", () => {
    expect(preview("Europe/London")).toMatch(/<option value="Europe\/London" selected="">/);
    expect(preview(null)).toMatch(/<option value="Asia\/Tokyo" selected="">/);
  });
});

describe("/setup after apply", () => {
  const fill = (read: SetupRead, connections: unknown[] = []) => (client: QueryClient) => {
    client.setQueryData(keys.setup, read);
    client.setQueryData(keys.bookingPages, [page(read.applied?.published ?? false)]);
    client.setQueryData(keys.calendarConnections, connections);
  };

  it("shows the template, the page off line with its switch and link, the Google note, the agents and the area links", () => {
    const html = render(h(SetupView), fill(applied("jewelry")));
    expect(html).toContain("Jewelry: custom and bridal");
    expect(html).toContain(">Off line<");
    expect(html).toMatch(/id="setup-page-live"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="setup-page-live"/);
    expect(html).not.toMatch(/<button[^>]*id="setup-page-live"[^>]*disabled/);
    expect(html).toContain('href="https://book.example.com/book/k"');
    expect(html).toContain("Google Calendar is not connected yet");
    expect(html).toContain('href="/agents#reminder-title"');
    expect(html).toContain('href="/agents#review-title"');
    expect(html.match(new RegExp(SENDING_OFF, "g"))).toHaveLength(2);
    for (const href of ["/calendar", "/customers", "/account/connections"]) expect(html).toContain(`href="${href}"`);
  });

  it("shows a live page as Live, and no Google note once the calendar is connected", () => {
    const connection = { id: PAGE, provider: "google", resourceId: RESOURCE, calendarId: "primary", accountEmail: null, status: "active", lastSyncedAt: null, lastError: null, createdAt: "2026-11-07T10:00:00.000Z" };
    const html = render(h(SetupView), fill(applied("agency", true), [connection]));
    expect(html).toContain(">Live<");
    expect(html).not.toContain("Google Calendar is not connected yet");
    expect(html).toContain('href="/agents#reminder-title"');
    expect(html).not.toContain('href="/agents#review-title"');
  });

  it("disables the switch for staff and says why", () => {
    const html = render(h(SetupView), fill(applied("crafts")), true);
    expect(html).toMatch(/<button[^>]*id="setup-page-live"[^>]*disabled=""|<button[^>]*disabled=""[^>]*id="setup-page-live"/);
    expect(html).toContain(OWNER_ONLY_TOGGLE);
  });
});

describe("Home's setup line", () => {
  it("links owners to /setup and tells staff their owner hasn't finished, only before setup", () => {
    const owner = render(h(SetupLine), (client) => client.setQueryData(keys.setup, fresh));
    expect(owner).toContain('href="/setup"');
    const staff = render(h(SetupLine), (client) => client.setQueryData(keys.setup, fresh), true);
    expect(staff).toContain("Your owner hasn't finished setup yet.");
    expect(staff).not.toContain('href="/setup"');
    expect(render(h(SetupLine), (client) => client.setQueryData(keys.setup, applied("fitness")))).not.toContain('data-testid="setup-line"');
    expect(render(h(SetupLine), () => undefined)).not.toContain('data-testid="setup-line"');
    expect(owner).toContain('data-testid="setup-line"');
  });
});

describe("recommended connections (IT-8)", () => {
  it("puts the template's recommended connection first with its line, and none before setup", () => {
    const after = render(h(ConnectionsView), (client) => client.setQueryData(keys.setup, applied("jewelry")));
    expect(after).toContain("Recommended for Jewelry: custom and bridal");
    // Shopify is recommended too, but this environment does not offer it.
    expect(after).not.toContain('data-testid="recommended-shopify"');
    const line = after.indexOf('data-testid="recommended-google_calendar"');
    expect(line).toBeGreaterThan(after.indexOf("Connect Google Calendar here"));
    expect(after.indexOf("Google Calendar", line + 60)).toBeGreaterThan(line);
    const before = render(h(ConnectionsView), (client) => client.setQueryData(keys.setup, fresh));
    expect(before).not.toContain("Recommended for");
  });
});

describe("New deal (IT-10)", () => {
  it("is disabled with the reason while there is no pipeline", () => {
    const html = render(h(NewDealButton, { contactId: "c" }), (client) => {
      client.setQueryData(keys.pipelines, []);
      client.setQueryData(keys.setup, fresh);
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(html).toMatch(/<button[^>]*aria-describedby="new-deal-reason"/);
    expect(html).toMatch(new RegExp(`id="new-deal-reason"[^>]*>${NO_PIPELINE_REASON}`));
  });

  it("says why when the pipelines did not load, and is busy, not silently disabled, while they load", () => {
    const failed = render(h(NewDealButton, { contactId: "c" }), (client) => {
      failQuery(client, keys.pipelines, new ApiError("server", "Something went wrong on our side. Try again."));
      client.setQueryData(keys.setup, fresh);
    });
    expect(failed).toMatch(/<button[^>]*aria-describedby="new-deal-reason"/);
    expect(failed).toContain(PIPELINES_NOT_LOADED);
    const loading = render(h(NewDealButton, { contactId: "c" }), () => undefined);
    expect(loading).toMatch(/<button[^>]*aria-busy="true"/);
    expect(loading).not.toContain(NO_PIPELINE_REASON);
  });

  it("is enabled with a pipeline", () => {
    const html = render(h(NewDealButton, { contactId: "c" }), (client) => {
      client.setQueryData(keys.pipelines, [DEMO_PIPELINE]);
      client.setQueryData(keys.setup, fresh);
    });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(html).not.toContain(NO_PIPELINE_REASON);
  });

  it("creates the deal in the open stage, then saves its value", async () => {
    const api = createDemoAdapter();
    const { pipelineId } = api.applyTemplateElsewhere("jewelry");
    const pipeline = (await api.listPipelines()).find((item) => item.id === pipelineId)!;
    const contact = (await api.listContacts()).items[0]!;
    let n = 0;
    const result = await createDealWithValue(api, { contactId: contact.id, pipelineId, stageId: pipeline.stages[0]!.id, title: "Engagement ring" },
      { amountMinor: 250_000, currency: "USD" }, () => `key-${++n}`);
    expect(result).toEqual({ title: "Engagement ring", valueError: null });
    const deal = (await api.listDeals({ contactId: contact.id })).items.find((item) => item.title === "Engagement ring");
    expect(deal).toMatchObject({ stageId: pipeline.stages[0]!.id, value: { amountMinor: 250_000, currency: "USD" }, revision: 2 });
  });

  it("keeps the deal and reports the value step when only that step fails", async () => {
    const api = createDemoAdapter();
    const contact = (await api.listContacts()).items[0]!;
    const failing = { createDeal: api.createDeal, setDealDetails: async () => { throw new ApiError("network", "offline"); } };
    let n = 0;
    const result = await createDealWithValue(failing, { contactId: contact.id, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[0]!.id, title: "Repair" },
      { amountMinor: 100, currency: "USD" }, () => `key-${++n}`);
    expect(result.valueError).toBeInstanceOf(ApiError);
    expect((await api.listDeals({ contactId: contact.id })).items.some((item) => item.title === "Repair")).toBe(true);
  });
});
