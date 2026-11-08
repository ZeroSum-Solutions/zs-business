// The Connections screen (connections.md C-1, C-5): it shows Google Calendar and Shopify, the two connections the
// API serves, and no invented accounts, in the live app and in the demo.
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
  for (const live of [true, false]) {
    it(`shows Shopify and Google Calendar and no sample accounts (${live ? "live" : "demo"})`, () => {
      const html = screen(live);
      // The demo waits for its setup read before ordering the cards; the live render has no session yet.
      if (live) expect(html).toContain('data-testid="shopify-card"');
      expect(html).not.toContain("other-accounts-title");
      expect(html).not.toContain('data-testid="sample-badge"');
      const body = text(html);
      expect(body).not.toContain("Other accounts");
      expect(body).not.toMatch(/sample data/i);
      for (const name of SAMPLE_ACCOUNTS) expect(body, name).not.toContain(name);
      expect(body).not.toContain("can't be changed here yet");
    });
  }
});
