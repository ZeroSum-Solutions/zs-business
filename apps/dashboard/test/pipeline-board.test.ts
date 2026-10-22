// Audit W7: the board must render every pipeline state an API can return, not only the seed's.
// Server-rendered with the query cache filled, as a page would be on its first paint.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PipelineBoard, staleDealMessage } from "../src/components/customers/pipeline-board";
import { ToastProvider } from "../src/components/ui/toast";
import { createApi, type ContactRecord, type DealRecord, type PipelineSummary } from "../src/lib/api";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { ApiProvider } from "../src/lib/api/react";
import { scopeKeys } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";

const keys = scopeKeys(DEMO_TENANT_ID);
const uuid = (n: number) => `2a4c6e80-1b3d-4f5a-9c7e-${String(n).padStart(12, "0")}`;
const sales: PipelineSummary = {
  id: uuid(1), name: "Sales",
  stages: [{ id: uuid(11), name: "Inquiry", position: 0, outcome: "open" }, { id: uuid(12), name: "Won", position: 1, outcome: "won" }],
};
const repairs: PipelineSummary = { id: uuid(2), name: "Repairs", stages: [{ id: uuid(21), name: "Received", position: 0, outcome: "open" }] };
const customer: ContactRecord = {
  id: uuid(31), tenantId: DEMO_TENANT_ID, displayName: "Maren Ashby", email: null, phone: "+16465550100",
  consent: { email: null, sms: null }, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
};
const deal: DealRecord = {
  id: uuid(41), tenantId: DEMO_TENANT_ID, contactId: customer.id, pipelineId: sales.id, stageId: uuid(12),
  title: "Signet ring", revision: 3, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z",
};

function render(pipelines: PipelineSummary[], fill: (client: QueryClient) => void = () => undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.pipelines, pipelines);
  fill(client);
  return renderToString(h(ApiProvider, { runtime: createApi({ mode: "demo" }), children: null },
    h(QueryClientProvider, { client }, h(SessionProvider, null, h(ToastProvider, null, h(PipelineBoard))))));
}

describe("pipeline board", () => {
  it("says no pipeline is set up when the business has none", () => {
    const html = render([]);
    expect(html).toContain("No pipeline yet");
    expect(html).not.toContain("Loading pipeline");
  });

  it("shows a setup state for a pipeline without stages, instead of crashing", () => {
    const html = render([{ id: uuid(3), name: "Sales", stages: [] }]);
    expect(html).toContain("Sales has no stages yet");
    expect(html).not.toContain("pipeline-choice");
  });

  it("offers a choice between several pipelines and shows the first one's stages and deals", () => {
    const html = render([sales, repairs], (client) => {
      client.setQueryData(keys.deals({ pipelineId: sales.id }), { items: [deal], incomplete: false, loaded: 1 });
      client.setQueryData(keys.contactNames([customer.id]), [customer]);
    });
    expect(html).toMatch(/<label[^>]*for="pipeline-choice"[^>]*>Pipeline<\/label>/);
    expect(html).toMatch(/<option value="2a4c6e80-1b3d-4f5a-9c7e-000000000001" selected="">Sales<\/option>/);
    expect(html).toContain(">Repairs</option>");
    expect(html).toContain('data-stage="Inquiry"');
    expect(html).toContain('data-stage="Won"');
    expect(html).not.toContain('data-stage="Received"');
    expect(html).toContain("Signet ring");
    expect(html).toContain("Maren Ashby");
  });

  it("shows a pipeline that has no other pipelines beside it without a choice", () => {
    const html = render([repairs], (client) => {
      client.setQueryData(keys.deals({ pipelineId: repairs.id }), { items: [], incomplete: false, loaded: 0 });
    });
    expect(html).not.toContain("pipeline-choice");
    expect(html).toContain('data-stage="Received"');
    expect(html).toContain("No deals here.");
  });

  // Audit W4: an empty stage of a list that stopped early may not be empty at all.
  it("says the list is incomplete beside a stage that shows no deals", () => {
    const html = render([sales], (client) => {
      client.setQueryData(keys.deals({ pipelineId: sales.id }), { items: [deal], incomplete: true, loaded: 2000 });
      client.setQueryData(keys.contactNames([customer.id]), [customer]);
    });
    expect(html).toContain("No deals here.");
    expect(html.replaceAll("<!-- -->", "")).toContain("List incomplete — showing first 2,000.");
  });

  // UI audit U2-9: one column per stage, however many the pipeline has.
  it("gives each stage its own column on wide screens, for any number of stages", () => {
    const six: PipelineSummary = { id: uuid(4), name: "Sales", stages: Array.from({ length: 6 }, (_, index) => ({ id: uuid(70 + index), name: `Step ${index + 1}`, position: index, outcome: "open" as const })) };
    const html = render([six], (client) => {
      client.setQueryData(keys.deals({ pipelineId: six.id }), { items: [], incomplete: false, loaded: 0 });
    });
    expect(html).not.toContain("lg:grid-cols-5");
    expect(html).toContain("--stages:6");
  });

  const board = () => render([sales], (client) => {
    client.setQueryData(keys.deals({ pipelineId: sales.id }), { items: [{ ...deal, updatedAt: new Date().toISOString(), wonAt: "2026-10-02T12:00:00.000Z" }], incomplete: false, loaded: 1 });
    client.setQueryData(keys.contactNames([customer.id]), [customer]);
  }).replaceAll("<!-- -->", "");

  // V-14: the stage select says what it is.
  it("labels each deal's stage select where everyone can see it", () => {
    expect(board()).toMatch(/<label for="stage-[^"]+"[^>]*>Stage<span class="sr-only"> of Signet ring<\/span><\/label>/);
  });

  // V-15: on phones the stage chips wrap instead of running off the edge.
  it("wraps the stage chips instead of cutting the last ones off", () => {
    expect(board()).toMatch(/role="group" aria-label="Stage" class="[^"]*flex-wrap/);
  });

  // V-16: a won date is a status, not a link.
  it("does not colour the won date like a link", () => {
    expect(board()).toMatch(/<span class="(?![^"]*text-(success|accent))[^"]*" data-testid="deal-won">/);
  });

  // V-17: "Updated just now", not "Updated Just now".
  it("writes when a deal changed in lower case, mid-sentence", () => {
    expect(board()).toContain("Updated just now");
  });

  // V-21: the note names the deal someone else changed.
  it("names the deal that someone else changed", () => {
    expect(staleDealMessage("Signet ring")).toBe("Someone changed Signet ring. Reloaded.");
  });
});
