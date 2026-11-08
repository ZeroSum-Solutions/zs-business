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
import { createDealWithValue, dealValueFor, NewDealButton, NO_OPEN_STAGE_REASON, NO_PIPELINE_REASON, PIPELINES_NOT_LOADED, SETUP_NOT_LOADED } from "../src/components/customers/new-deal-dialog";
import { SetupLine } from "../src/components/home/setup-line";
import { ApplyTemplate, CALENDAR_CLASH_ADVICE, OWNER_ONLY_TOGGLE, SENDING_OFF, SetupView, STAFF_SETUP_DESCRIPTION } from "../src/components/setup/setup-view";
import { ApiError } from "../src/lib/api";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_PIPELINE } from "../src/lib/api/demo/seed";
import { dealTarget } from "../src/lib/setup";
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
  applied: {
    templateId, templateVersion: 1, appliedAt: "2026-11-07T10:00:00.000Z", pipelineId: PIPELINE, resourceId: RESOURCE, bookingPageId: PAGE,
    bookingPageTitle: "Book a consultation", bookingUrl: "https://book.example.com/book/k", published,
  },
  timeZone: "Europe/London",
  templates,
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
  // No booking page list is filled: the screen takes the page's title and address from the setup read.
  const fill = (read: SetupRead, connections: unknown[] = []) => (client: QueryClient) => {
    client.setQueryData(keys.setup, read);
    client.setQueryData(keys.calendarConnections, connections);
  };
  const connection = (status: string) => ({ id: PAGE, provider: "google", resourceId: RESOURCE, calendarId: "primary", accountEmail: null, status, lastSyncedAt: null, lastError: null, createdAt: "2026-11-07T10:00:00.000Z" });

  it("shows the template, the page off line with its switch and no link, the Google note, the agents and the area links", () => {
    const html = render(h(SetupView), fill(applied("jewelry")));
    expect(html).toContain("Jewelry: custom and bridal");
    expect(html).toContain("Book a consultation");
    expect(html).toContain(">Off line<");
    expect(html).toMatch(/id="setup-page-live"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="setup-page-live"/);
    expect(html).not.toMatch(/<button[^>]*id="setup-page-live"[^>]*disabled/);
    // The public address 404s while the page is off line, so no link is offered yet.
    expect(html).not.toContain("https://book.example.com/book/k");
    expect(html).toContain("Google Calendar is not connected yet");
    expect(html).toContain(CALENDAR_CLASH_ADVICE);
    expect(html).toContain('href="/agents#reminder-title"');
    expect(html).toContain('href="/agents#review-title"');
    expect(html.match(new RegExp(SENDING_OFF, "g"))).toHaveLength(2);
    for (const href of ["/calendar", "/customers", "/account/connections"]) expect(html).toContain(`href="${href}"`);
  });

  it("shows a live page as Live with its link, and no Google note once the calendar has an active connection", () => {
    const html = render(h(SetupView), fill(applied("agency", true), [connection("active")]));
    expect(html).toContain(">Live<");
    expect(html).toContain('href="https://book.example.com/book/k"');
    expect(html).not.toContain("Google Calendar is not connected yet");
    expect(html).toContain('href="/agents#reminder-title"');
    expect(html).not.toContain('href="/agents#review-title"');
  });

  it("keeps the Google note for a connection that needs a reconnect, and says so on a failed read", () => {
    const reconnect = render(h(SetupView), fill(applied("agency"), [connection("reauthorize")]));
    expect(reconnect).toContain('data-testid="google-not-connected"');
    expect(reconnect).toContain("Google Calendar needs to be reconnected");
    expect(reconnect).toContain(CALENDAR_CLASH_ADVICE);
    const failed = render(h(SetupView), (client) => {
      client.setQueryData(keys.setup, applied("agency"));
      failQuery(client, keys.calendarConnections, new ApiError("server", "Something went wrong on our side. Try again."));
    });
    expect(failed).toContain('data-testid="google-unknown"');
    expect(failed).toContain("couldn&#x27;t check your Google Calendar connection".replace("&#x27;", "'"));
  });

  it("gives staff the page title and, while it is live, the link, without the owner-only page list", () => {
    const off = render(h(SetupView), fill(applied("crafts")), true);
    expect(off).toMatch(/<button[^>]*id="setup-page-live"[^>]*disabled=""|<button[^>]*disabled=""[^>]*id="setup-page-live"/);
    expect(off).toContain(OWNER_ONLY_TOGGLE);
    expect(off).toContain("Book a consultation");
    const live = render(h(SetupView), fill(applied("crafts", true)), true);
    expect(live).toContain('href="https://book.example.com/book/k"');
  });

  it("shows each message's own timing and channel from the preview", () => {
    const sms = { ...templates[3]!, messages: templates[3]!.messages.map((message) => ({ ...message, channel: "sms" as const, timingHours: 1 })) };
    const html = render(h(ApplyTemplate, { template: sms, profileZone: null, onBack: () => undefined }), () => undefined);
    expect(html).toContain("1 hour before the appointment, by text message");
    expect(html).toContain("1 hour after the appointment, by text message");
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

  it("does not read a failed setup as 'already applied': it says so with a retry, to owners and staff", () => {
    for (const staff of [false, true]) {
      const html = render(h(SetupLine), (client) => failQuery(client, keys.setup, new ApiError("server", "Something went wrong on our side. Try again.")), staff);
      expect(html, String(staff)).toContain('data-testid="setup-line-error"');
      expect(html, String(staff)).toContain("Try again");
    }
  });
});

describe("recommended connections (IT-8)", () => {
  it("puts the template's recommended connections first, in its order, with their line, and none before setup", () => {
    const after = render(h(ConnectionsView), (client) => client.setQueryData(keys.setup, applied("jewelry")));
    const shopify = after.indexOf('data-testid="recommended-shopify"');
    const calendar = after.indexOf('data-testid="recommended-google_calendar"');
    expect(shopify).toBeGreaterThan(after.indexOf("Connect Google Calendar and Shopify here"));
    expect(calendar).toBeGreaterThan(shopify);
    expect(after.indexOf('data-testid="shopify-card"')).toBeGreaterThan(shopify);
    expect(after.indexOf('data-testid="shopify-card"')).toBeLessThan(calendar);
    expect(after.indexOf('data-testid="gcal-card"')).toBeGreaterThan(calendar);
    expect(after.match(/Recommended for Jewelry: custom and bridal/g)).toHaveLength(2);
    // Fitness recommends only Google Calendar: it comes first and Shopify follows with no line.
    const fitness = render(h(ConnectionsView), (client) => client.setQueryData(keys.setup, applied("fitness")));
    expect(fitness).not.toContain('data-testid="recommended-shopify"');
    expect(fitness.indexOf('data-testid="gcal-card"')).toBeLessThan(fitness.indexOf('data-testid="shopify-card"'));
    const before = render(h(ConnectionsView), (client) => client.setQueryData(keys.setup, fresh));
    expect(before).not.toContain("Recommended for");
  });

  it("waits for the setup read before ordering, and on a failed read keeps the default order with no recommended lines", () => {
    const pending = render(h(ConnectionsView), () => undefined);
    expect(pending).not.toContain('data-testid="shopify-card"');
    expect(pending).not.toContain('data-testid="gcal-card"');
    const failed = render(h(ConnectionsView), (client) => failQuery(client, keys.setup, new ApiError("server", "Something went wrong on our side. Try again.")));
    expect(failed).not.toContain("Recommended for");
    expect(failed.indexOf('data-testid="gcal-card"')).toBeGreaterThan(-1);
    expect(failed.indexOf('data-testid="gcal-card"')).toBeLessThan(failed.indexOf('data-testid="shopify-card"'));
  });
});

describe("recommended connections when a refetch fails with cached setup (IT-8)", () => {
  it("shows no recommended lines and keeps the default order once the setup read has failed, even with cached data", () => {
    const html = render(h(ConnectionsView), (client) => {
      client.setQueryData(keys.setup, applied("jewelry"));
      client.getQueryCache().find({ queryKey: keys.setup })!.setState({
        status: "error", fetchStatus: "idle", error: new ApiError("server", "Something went wrong on our side. Try again."), errorUpdateCount: 1, errorUpdatedAt: Date.now(),
        fetchFailureCount: 1, fetchFailureReason: new ApiError("server", "Something went wrong on our side. Try again."),
      });
      expect(client.getQueryData(keys.setup)).toBeDefined();
    });
    expect(html).toContain('data-testid="gcal-card"');
    expect(html).not.toContain("Recommended for");
    expect(html.indexOf('data-testid="gcal-card"')).toBeLessThan(html.indexOf('data-testid="shopify-card"'));
  });
});

describe("New deal (IT-10)", () => {
  const SEED_AND_TEMPLATE = (applyId: string | null) => (client: QueryClient) => {
    client.setQueryData(keys.pipelines, [
      { id: "aaa-template-comes-second", name: "Zed", stages: [{ id: "t1", name: "Lead", position: 0, outcome: "open" }] },
      DEMO_PIPELINE,
    ]);
    client.setQueryData(keys.setup, applyId === null ? fresh : { ...applied("jewelry"), applied: { ...applied("jewelry").applied!, pipelineId: applyId } });
  };

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

  it("is enabled with a pipeline when setup says no template was applied", () => {
    const html = render(h(NewDealButton, { contactId: "c" }), (client) => {
      client.setQueryData(keys.pipelines, [DEMO_PIPELINE]);
      client.setQueryData(keys.setup, fresh);
    });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(html).not.toContain(NO_PIPELINE_REASON);
  });

  it("waits for the setup read: busy and disabled while it is pending, an error and no fallback pipeline when it failed", () => {
    const pending = render(h(NewDealButton, { contactId: "c" }), (client) => client.setQueryData(keys.pipelines, [DEMO_PIPELINE]));
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(pending).toMatch(/<button[^>]*aria-busy="true"/);
    const failed = render(h(NewDealButton, { contactId: "c" }), (client) => {
      client.setQueryData(keys.pipelines, [DEMO_PIPELINE]);
      failQuery(client, keys.setup, new ApiError("server", "Something went wrong on our side. Try again."));
    });
    expect(failed).toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(failed).toContain(SETUP_NOT_LOADED);
  });

  it("targets the applied template's pipeline beside a seed pipeline, never the first by name", () => {
    // The applied pipeline sits second in the list: a fallback to pipelines[0] would pick the other.
    const enabled = render(h(NewDealButton, { contactId: "c" }), SEED_AND_TEMPLATE(DEMO_PIPELINE.id));
    expect(enabled).not.toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    // Its pipeline gone from the list: no pipeline, and the other pipeline does not stand in.
    const gone = render(h(NewDealButton, { contactId: "c" }), SEED_AND_TEMPLATE("deleted-pipeline"));
    expect(gone).toMatch(/<button[^>]*disabled=""[^>]*>.*New deal/);
    expect(gone).toContain(NO_PIPELINE_REASON);
  });

  it("uses its own words when the pipeline has no open stage", () => {
    const html = render(h(NewDealButton, { contactId: "c" }), (client) => {
      client.setQueryData(keys.pipelines, [{ id: "closed", name: "Closed", stages: [{ id: "w", name: "Won", position: 0, outcome: "won" }] }]);
      client.setQueryData(keys.setup, fresh);
    });
    expect(html).toContain(NO_OPEN_STAGE_REASON);
    expect(html).not.toContain(NO_PIPELINE_REASON);
  });

  it("asks for a currency instead of guessing one when a value is typed before the profile currency is known (IT-10)", () => {
    // Profile not read and none picked: the typed value is a currency problem, never a USD value.
    expect(dealValueFor("1250", false, "USD")).toEqual({ problem: "currency" });
    // No value typed: nothing to price, so no currency is needed.
    expect(dealValueFor("  ", false, "USD")).toEqual({ value: null });
    // The profile currency, or one the owner picked, is used as it is.
    expect(dealValueFor("1250", true, "EUR")).toEqual({ value: { amountMinor: 125_000, currency: "EUR" } });
    expect(dealValueFor("12x", true, "EUR")).toEqual({ problem: "amount" });
  });

  it("creates the deal in the template pipeline's first open stage, then saves its value", async () => {
    const api = createDemoAdapter();
    const { pipelineId } = api.applyTemplateElsewhere("jewelry");
    const pipelines = await api.listPipelines();
    expect(pipelines.length).toBeGreaterThan(1);
    const target = dealTarget(pipelines, pipelineId);
    expect(target).toMatchObject({ pipelineId });
    if ("problem" in target) throw new Error(target.problem);
    const contact = (await api.listContacts()).items[0]!;
    let n = 0;
    const result = await createDealWithValue(api, { contactId: contact.id, ...target, title: "Engagement ring" },
      { amountMinor: 250_000, currency: "USD" }, () => `key-${++n}`);
    expect(result).toMatchObject({ deal: { title: "Engagement ring" }, valueError: null });
    const deal = (await api.listDeals({ contactId: contact.id })).items.find((item) => item.title === "Engagement ring");
    expect(deal).toMatchObject({ pipelineId, stageId: target.stageId, value: { amountMinor: 250_000, currency: "USD" }, revision: 2 });
  });

  it("keeps the deal and reports the value step when only that step fails, and a retry saves the value without a second deal", async () => {
    const api = createDemoAdapter();
    const contact = (await api.listContacts()).items[0]!;
    let fail = true;
    const flaky = {
      createDeal: api.createDeal,
      setDealDetails: (change: Parameters<typeof api.setDealDetails>[0], options: Parameters<typeof api.setDealDetails>[1]) => {
        if (fail) return Promise.reject(new ApiError("network", "offline"));
        return api.setDealDetails(change, options);
      },
    };
    let n = 0;
    const input = { contactId: contact.id, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[0]!.id, title: "Repair" };
    const first = await createDealWithValue(flaky, input, { amountMinor: 100, currency: "USD" }, () => `key-${++n}`);
    expect(first.valueError).toBeInstanceOf(ApiError);
    const count = async () => (await api.listDeals({ contactId: contact.id })).items.filter((item) => item.title === "Repair").length;
    expect(await count()).toBe(1);
    fail = false;
    const retry = await createDealWithValue(flaky, input, { amountMinor: 100, currency: "USD" }, () => `key-${++n}`, first.deal);
    expect(retry.valueError).toBeNull();
    expect(await count()).toBe(1);
    expect((await api.listDeals({ contactId: contact.id })).items.find((item) => item.title === "Repair")?.value).toMatchObject({ amountMinor: 100 });
  });
});
