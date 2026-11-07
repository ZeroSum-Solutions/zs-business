// The Shopify card and the Home notice (connections.md C-5, C-11, C-13): what the owner sees before a
// store connects, what the confirm screen says, who can act, and when Home speaks up.
import { type QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { CONNECTION_RETENTION_LINE, READ_SCOPE_DISCLOSURES } from "@zs/contracts";
import { ShopifyCard } from "../src/components/account/shopify-card";
import { ReconnectNotice } from "../src/components/home/reconnect-notice";
import { ApiError } from "../src/lib/api/errors";
import type { ManagedConnection, PendingManagedConnection } from "../src/lib/api";
import { REAUTHORIZE_HOME_LINE, REVOKE_FAILED_MESSAGE, STAFF_ERROR } from "../src/lib/managed-connections";
import { failQuery, keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/account/connections",
}));

const connection = (patch: Partial<ManagedConnection> = {}): ManagedConnection => ({
  id: "b7d9f1a3-5c7e-4a9b-8d1f-000000000001", toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com",
  status: "active", reauthorizeReason: null, revokeFailed: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z", ...patch,
});
const pending: PendingManagedConnection = {
  grantId: "g".repeat(43), toolkit: "shopify", shopDomain: "halden-rowe.myshopify.com", accountLabel: "Halden Rowe",
  expiresAt: "2026-11-06T12:10:00.000Z", tokensWithAccess: 2,
};

interface CardOptions { items?: ManagedConnection[]; pending?: PendingManagedConnection | null; notice?: Parameters<typeof ShopifyCard>[0]["notice"]; waiting?: boolean; staff?: boolean; fill?: (client: QueryClient) => void }
function card({ items = [], pending: waiting = null, notice = null, waiting: polling = false, staff = false, fill }: CardOptions = {}) {
  return renderScreen(h(ShopifyCard, { notice, onNotice: () => undefined, waiting: polling, onSettled: () => undefined }), {
    staff,
    fill: (client) => {
      client.setQueryData(keys.managedConnections, items);
      client.setQueryData(keys.managedPending, waiting);
      fill?.(client);
    },
  });
}
const text = (html: string) => html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const testid = (html: string, id: string) => text(new RegExp(`<([a-z0-9]+)[^>]*data-testid="${id}"[^>]*>[\\s\\S]*?</\\1>`).exec(html)?.[0] ?? "").trim();

describe("Shopify card: connect form", () => {
  it("asks an owner for the store address and offers Connect", () => {
    const html = card();
    expect(html).toContain('data-testid="shopify-connect-form"');
    expect(html).toContain('placeholder="your-store.myshopify.com"');
    expect(text(html)).toContain("Store address");
    expect(text(html)).toContain("Connect Shopify");
    expect(html).not.toContain('data-testid="shopify-confirm"');
  });

  it("describes a read-only connection and nothing else", () => {
    const body = text(card());
    expect(body).toContain("Let your agents read orders from your Shopify store. They can read only; nothing in your store is changed.");
  });

  it("offers to connect another store when one is already connected", () => {
    const html = card({ items: [connection()] });
    expect(text(html)).toContain("Connect another store");
    expect(html).toContain('data-testid="shopify-row"');
  });
});

describe("Shopify card: confirm screen (C-5, C-11)", () => {
  const html = () => card({ pending });

  it("shows the label, the shop domain, the provider scopes and the token count", () => {
    const page = html();
    expect(testid(page, "shopify-confirm-question")).toBe("Connect Halden Rowe (halden-rowe.myshopify.com)?");
    expect(testid(page, "shopify-confirm-domain")).toBe("halden-rowe.myshopify.com");
    expect(testid(page, "shopify-confirm-label-value")).toBe("Halden Rowe");
    expect(testid(page, "shopify-confirm-scopes")).toBe("read_orders, read_customers");
    expect(testid(page, "shopify-confirm-tokens")).toBe("2 tokens can read this store's orders.");
  });

  it("says one token in the singular and none when no token can read yet", () => {
    expect(testid(card({ pending: { ...pending, tokensWithAccess: 1 } }), "shopify-confirm-tokens")).toBe("1 token can read this store's orders.");
    expect(testid(card({ pending: { ...pending, tokensWithAccess: 0 } }), "shopify-confirm-tokens")).toBe("None can read orders yet.");
  });

  it("carries the C-11 disclosure and the retention line, word for word", () => {
    const page = html();
    expect(testid(page, "shopify-confirm-disclosure")).toBe(READ_SCOPE_DISCLOSURES["connections:read"].replace(/\s+/g, " "));
    expect(testid(page, "shopify-confirm-retention")).toBe(CONNECTION_RETENTION_LINE.replace(/\s+/g, " "));
  });

  it("connects nothing until the owner chooses: Cancel and Connect store are both offered", () => {
    const page = text(html());
    expect(page).toContain("Cancel");
    expect(page).toContain("Connect store");
    expect(page).toContain("If you did not just connect Shopify, choose Cancel.");
  });

  it("is a labelled region, so a screen reader announces what is being confirmed", () => {
    expect(html()).toMatch(/<div[^>]*role="region"[^>]*aria-labelledby="shopify-confirm-label"/);
  });
});

describe("Shopify card: rows", () => {
  it("shows the name, the domain and a Connected badge with a Disconnect button, and no Reconnect", () => {
    const html = card({ items: [connection()] });
    expect(testid(html, "shopify-status")).toBe("Connected");
    expect(testid(html, "shopify-domain")).toBe("halden-rowe.myshopify.com");
    expect(text(html)).toContain("Disconnect Halden Rowe");
    expect(text(html)).not.toContain("Reconnect Halden Rowe");
    expect(html).not.toContain('data-testid="shopify-warning"');
  });

  it("falls back to the domain when Shopify gave no name", () => {
    const html = card({ items: [connection({ accountLabel: null })] });
    expect(html).toMatch(/<h3[^>]*>halden-rowe\.myshopify\.com<\/h3>/);
  });

  it("offers Reconnect, and says agents are cut off, while a store needs the owner", () => {
    const html = card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error" })] });
    expect(testid(html, "shopify-status")).toBe("Reconnect needed");
    expect(text(html)).toContain("Reconnect Halden Rowe");
    expect(text(html)).toContain("Disconnect Halden Rowe");
    expect(testid(html, "shopify-warning")).toContain("Agents cannot read this store's orders until you reconnect or disconnect it.");
  });

  it("shows a store being removed without a button that acts on it", () => {
    const html = card({ items: [connection({ status: "disconnecting" })] });
    expect(testid(html, "shopify-status")).toBe("Disconnecting");
    expect(text(html)).toContain("Removing our access and asking Shopify to remove the app's access.");
    expect(text(html)).not.toMatch(/Disconnect Halden Rowe|Reconnect Halden Rowe/);
  });

  it("hides a retired store, and tells the owner to remove the app when Shopify did not confirm (C-13)", () => {
    const retired = card({ items: [connection({ status: "disconnected", revokeFailed: true })] });
    expect(retired).not.toContain('data-testid="shopify-row"');
    const failed = card({ items: [connection({ status: "disconnecting", revokeFailed: true })] });
    expect(testid(failed, "shopify-warning")).toBe(REVOKE_FAILED_MESSAGE);
  });

  it("keeps the disconnect and reconnect words behind their dialogs until asked for", () => {
    const html = card({ items: [connection({ status: "reauthorize", reauthorizeReason: "provider_status" })] });
    expect(html).not.toContain('data-testid="shopify-disconnect-copy"');
    expect(html).not.toContain('data-testid="shopify-reconnect-copy"');
  });
});

describe("Shopify card: notices", () => {
  it("shows what Shopify's return said, and can be dismissed", () => {
    const html = card({ notice: { tone: "error", message: "That connect link expired. Try again from this page." } });
    expect(html).toMatch(/role="alert"[^>]*data-testid="shopify-return"|data-testid="shopify-return"[^>]*role="alert"/);
    expect(testid(html, "shopify-return")).toContain("That connect link expired.");
    expect(html).toMatch(/<button[^>]*aria-label="Dismiss"/);
  });

  it("shows a success notice as a status", () => {
    const html = card({ notice: { tone: "success", message: "Shopify connected." } });
    expect(html).toMatch(/role="status"[^>]*data-testid="shopify-return"|data-testid="shopify-return"[^>]*role="status"/);
  });

  it("says it is waiting while Shopify has not finished", () => {
    expect(testid(card({ waiting: true }), "shopify-waiting")).toBe("Waiting for Shopify to finish connecting.");
    expect(card({ waiting: false })).not.toContain('data-testid="shopify-waiting"');
  });
});

describe("Shopify card: who sees what", () => {
  it("shows staff only that an owner must connect, with no form, rows or waiting grant", () => {
    const html = card({ staff: true, items: [connection()], pending });
    expect(text(html)).toContain("Only an owner can connect or disconnect Shopify.");
    expect(html).not.toContain('data-testid="shopify-connect-form"');
    expect(html).not.toContain('data-testid="shopify-row"');
  });

  it("asks staff to get an owner, not to try again", () => {
    const html = card({ staff: true, notice: { tone: "error", message: "Shopify could not be connected. Try again from this page." } });
    expect(testid(html, "shopify-return")).toBe(STAFF_ERROR);
    expect(html).not.toContain("Try again from this page.");
  });

  it("says Shopify is not set up when the server has no connection settings (404)", () => {
    const html = card({ fill: (client) => failQuery(client, keys.managedConnections, new ApiError("not_found", "x", 404)) });
    expect(testid(html, "shopify-not-set-up")).toBe("Shopify connections are not set up on this server yet.");
    expect(html).not.toContain('data-testid="shopify-connect-form"');
  });
});

describe("Home notice (C-13)", () => {
  const notice = (items: ManagedConnection[] | undefined, staff = false) =>
    renderScreen(h(ReconnectNotice), { staff, fill: (client) => { if (items) client.setQueryData(keys.managedConnections, items); } });

  it("tells an owner while any store needs reconnecting, with a link to Connections", () => {
    const html = notice([connection(), connection({ id: "b7d9f1a3-5c7e-4a9b-8d1f-000000000002", status: "reauthorize", reauthorizeReason: "auth_error" })]);
    expect(testid(html, "home-reconnect")).toContain(REAUTHORIZE_HOME_LINE);
    expect(html).toContain('href="/account/connections"');
  });

  it("is quiet when every store is fine, none are connected, the read has not landed, or the viewer is staff", () => {
    expect(notice([connection()])).not.toContain("home-reconnect");
    expect(notice([])).not.toContain("home-reconnect");
    expect(notice([connection({ status: "disconnecting" })])).not.toContain("home-reconnect");
    expect(notice(undefined)).not.toContain("home-reconnect");
    expect(notice([connection({ status: "reauthorize" })], true)).not.toContain("home-reconnect");
  });
});
