// A customer page may start from a cached list row, but never from a list that a write
// invalidated: that row may be older than the record the write returned.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi, type ContactRecord } from "../src/lib/api";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { ApiProvider } from "../src/lib/api/react";
import { scopeKeys, useContact } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";

const keys = scopeKeys(DEMO_TENANT_ID);
const customer: ContactRecord = {
  id: "2a4c6e80-1b3d-4f5a-9c7e-000000000031", tenantId: DEMO_TENANT_ID, displayName: null, email: "maren@example.com",
  phone: null, consent: { email: null, sms: null }, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
};

function Name() {
  const contact = useContact(customer.id);
  return h("p", null, contact.data ? `shown:${contact.data.email}` : "loading");
}

function render(fill: (client: QueryClient) => void): string {
  const client = new QueryClient();
  client.setQueryData(keys.contacts(""), { pages: [{ items: [customer], nextOffset: null }], pageParams: [0] });
  fill(client);
  return renderToString(h(ApiProvider, { runtime: createApi({ mode: "demo" }), children: null },
    h(QueryClientProvider, { client }, h(SessionProvider, null, h(Name)))));
}

describe("useContact", () => {
  it("starts from a fresh cached list row", () => {
    expect(render(() => undefined)).toContain("shown:maren@example.com");
  });

  it("does not start from a list a write has invalidated", () => {
    const html = render((client) => { void client.invalidateQueries({ queryKey: keys.contactsAll, refetchType: "none" }); });
    expect(html).toContain("loading");
  });
});
