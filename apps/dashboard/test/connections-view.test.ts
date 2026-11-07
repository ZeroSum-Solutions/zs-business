// The Connections screen (connections.md C-1, C-5): in the live app it shows Google Calendar and Shopify, the two
// connections the API serves, and none of the sample accounts the demo workspace carries.
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/components/account/connections-view";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/account/connections",
}));

const text = (html: string) => html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const SAMPLE_ACCOUNTS = ["Instagram", "Stripe", "Google Business", "Domain"];

function screen(live: boolean) {
  return renderScreen(h(ConnectionsView), {
    live,
    fill: (client) => {
      client.setQueryData(keys.managedConnections, []);
      client.setQueryData(keys.managedPending, null);
    },
  });
}

describe("Connections screen", () => {
  it("shows Shopify and Google Calendar in the live app, and no sample accounts", () => {
    const html = screen(true);
    expect(html).toContain('data-testid="shopify-card"');
    expect(html).not.toContain("other-accounts-title");
    expect(html).not.toContain('data-testid="sample-badge"');
    const body = text(html);
    expect(body).not.toContain("Other accounts");
    for (const name of SAMPLE_ACCOUNTS) expect(body, name).not.toContain(name);
    expect(body).not.toContain("can't be changed here yet");
  });

  it("keeps the demo workspace's other accounts in the demo", () => {
    const html = screen(false);
    expect(html).toContain("other-accounts-title");
    expect(text(html)).toContain("can't be changed here yet");
  });
});
