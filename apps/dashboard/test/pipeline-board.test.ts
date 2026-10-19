// Audit W7: the board must render every pipeline state an API can return, not only the seed's.
// Server-rendered with the query cache filled, as a page would be on its first paint.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PipelineBoard } from "../src/components/customers/pipeline-board";
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
  stages: [{ id: uuid(11), name: "Inquiry", position: 0 }, { id: uuid(12), name: "Won", position: 1 }],
};
const repairs: PipelineSummary = { id: uuid(2), name: "Repairs", stages: [{ id: uuid(21), name: "Received", position: 0 }] };
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
});
