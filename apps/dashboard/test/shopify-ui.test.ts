// The Shopify card and the Home notice (connections.md C-5, C-11, C-13): what the owner sees before a
// store connects, what the confirm screen says, who can act, and when Home speaks up.
import { type QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { CONNECTION_RETENTION_LINE, READ_SCOPE_DISCLOSURES } from "@zs/contracts";
import { ShopifyCard } from "../src/components/account/shopify-card";
import { ReconnectNotice } from "../src/components/home/reconnect-notice";
import { ApiError } from "../src/lib/api/errors";
import { ClaimsUnavailable } from "../src/lib/shopify-claims";
import type { ManagedConnection, PendingManagedConnection } from "../src/lib/api";
import { READ_BLOCKED_MESSAGE, REAUTHORIZE_HOME_LINE, REVOKE_FAILED_MESSAGE, STAFF_ERROR } from "../src/lib/managed-connections";
import { failQuery, keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/account/connections",
}));

const connection = (patch: Partial<ManagedConnection> = {}): ManagedConnection => ({
  id: "b7d9f1a3-5c7e-4a9b-8d1f-000000000001", toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com",
  status: "active", reauthorizeReason: null, revokeFailed: false, readBlocked: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z", ...patch,
});
const pending: PendingManagedConnection = {
  grantId: "g".repeat(43), toolkit: "shopify", shopDomain: "halden-rowe.myshopify.com", accountLabel: "Halden Rowe",
  expiresAt: "2026-11-06T12:10:00.000Z", tokensWithAccess: 2,
};

interface CardOptions { items?: ManagedConnection[]; pending?: PendingManagedConnection | null; notice?: Parameters<typeof ShopifyCard>[0]["notice"]; waiting?: boolean; staff?: boolean; live?: boolean; fill?: (client: QueryClient) => void }
function card({ items = [], pending: waiting = null, notice = null, waiting: polling = false, staff = false, live = false, fill }: CardOptions = {}) {
  return renderScreen(h(ShopifyCard, { notice, onNotice: () => undefined, waiting: polling, onSettled: () => undefined }), {
    staff,
    live,
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

  it("with the native tier on (the claim route answers) asks for no store address: it points to the Shopify App Store (C-18, S1 2.3.1)", () => {
    const html = card({ fill: (client) => client.setQueryData(keys.shopifyClaim, null) });
    expect(html).not.toContain('data-testid="shopify-connect-form"');
    expect(html).not.toContain("your-store.myshopify.com");
    expect(text(html)).toContain("install ZS Business Connections from the Shopify App Store");
  });

  it("with the native tier on, a native store that needs the owner is reopened in Shopify admin: no Reconnect (C-18)", () => {
    const html = card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error", tier: "native" })], fill: (client) => client.setQueryData(keys.shopifyClaim, null) });
    expect(text(html)).toContain("open ZS Business Connections in your Shopify admin");
    expect(text(html)).not.toContain("Reconnect Halden Rowe");
  });

  it("with the native tier on, a row the API did not label (older server) keeps the reopen note (C-18)", () => {
    const html = card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error" })], fill: (client) => client.setQueryData(keys.shopifyClaim, null) });
    expect(text(html)).toContain("open ZS Business Connections in your Shopify admin");
    expect(text(html)).not.toContain("Reconnect Halden Rowe");
  });

  it("with the native tier on, a legacy Composio row in reauthorize shows a Reconnect action, not the reopen note (C-18)", () => {
    const html = card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error", tier: "composio" })], fill: (client) => client.setQueryData(keys.shopifyClaim, null) });
    expect(text(html)).toContain("Reconnect Halden Rowe");
    expect(html).not.toContain('data-testid="shopify-reopen-note"');
    expect(text(html)).not.toContain("open ZS Business Connections in your Shopify admin");
  });

  it("never asks for a store address when the claim read failed for a reason other than 'no native tier' (C-18)", () => {
    for (const error of [new Error("claim status failed"), new ClaimsUnavailable(403)]) {
      const html = card({ fill: (client) => failQuery(client, keys.shopifyClaim, error) });
      expect(html, error.message).not.toContain('data-testid="shopify-connect-form"');
      expect(html, error.message).not.toContain("your-store.myshopify.com");
      expect(html, error.message).toContain('data-testid="shopify-native-unknown"');
    }
  });

  it("asks for the store address only when the server answered that it has no native tier (404), or in the demo", () => {
    expect(card({ fill: (client) => failQuery(client, keys.shopifyClaim, new ClaimsUnavailable(404)) })).toContain('data-testid="shopify-connect-form"');
    expect(card()).toContain('data-testid="shopify-connect-form"');
  });

  it("describes a read-only connection and nothing else", () => {
    const body = text(card());
    expect(body).toContain("Let your agents read orders from your Shopify store. They can read only; nothing in your store is changed.");
  });

  it("offers no second store while one is live: a business has one Shopify connection (C-7)", () => {
    for (const status of ["active", "reauthorize", "disconnecting"] as const) {
      const html = card({ items: [connection({ status })] });
      expect(html, status).toContain('data-testid="shopify-row"');
      expect(html, status).not.toContain('data-testid="shopify-connect-form"');
      expect(text(html), status).not.toContain("Connect another store");
    }
  });

  it("offers the form again once the store is retired, even while its warning stays", () => {
    const html = card({ items: [connection({ status: "disconnected", revokeFailed: true })] });
    expect(html).toContain('data-testid="shopify-connect-form"');
    expect(text(html)).toContain("Store address");
    expect(text(html)).not.toContain("Connect another store");
  });
});

describe("Shopify card: confirm screen (C-5, C-11)", () => {
  const html = () => card({ pending });

  it("shows the label, the shop domain, the provider scopes and the token count", () => {
    const page = html();
    expect(testid(page, "shopify-confirm-question")).toBe("Connect Halden Rowe (halden-rowe.myshopify.com)?");
    expect(testid(page, "shopify-confirm-domain")).toBe("halden-rowe.myshopify.com");
    expect(testid(page, "shopify-confirm-label-value")).toBe("Halden Rowe");
    expect(testid(page, "shopify-confirm-scopes")).toBe("read_orders");
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

  it("says the store's app permissions block the reads, keeps the store connected and offers no Reconnect for it (C-8, C-10)", () => {
    const html = card({ items: [connection({ readBlocked: true })] });
    expect(testid(html, "shopify-status")).toBe("Connected");
    expect(testid(html, "shopify-warning")).toBe(READ_BLOCKED_MESSAGE);
    expect(READ_BLOCKED_MESSAGE).toContain("app's permissions");
    expect(text(html)).not.toContain("Reconnect Halden Rowe");
    expect(text(html)).toContain("Disconnect Halden Rowe");
    expect(testid(card({ items: [connection()] }), "shopify-warning")).toBe("");
    // A store that is no longer active shows its own state, not this notice.
    expect(text(card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error", readBlocked: true })] }))).not.toContain("permissions");
  });

  it("shows a store being removed without a button that acts on it", () => {
    const html = card({ items: [connection({ status: "disconnecting" })] });
    expect(testid(html, "shopify-status")).toBe("Disconnecting");
    expect(text(html)).toContain("Removing our access and asking Shopify to remove the app's access.");
    expect(text(html)).not.toMatch(/Disconnect Halden Rowe|Reconnect Halden Rowe/);
  });

  it("hides a retired store, but keeps one Shopify did not confirm in view with the Shopify admin warning (C-13)", () => {
    const retired = card({ items: [connection({ status: "disconnected" })] });
    expect(retired).not.toContain('data-testid="shopify-row"');
    const failed = card({ items: [connection({ status: "disconnecting", revokeFailed: true })] });
    expect(testid(failed, "shopify-warning")).toBe(REVOKE_FAILED_MESSAGE);
    const unconfirmed = card({ items: [connection({ status: "disconnected", accountLabel: null, revokeFailed: true })] });
    expect(testid(unconfirmed, "shopify-status")).toBe("Disconnected");
    expect(testid(unconfirmed, "shopify-warning")).toBe(REVOKE_FAILED_MESSAGE);
    expect(testid(unconfirmed, "shopify-domain")).toBe("halden-rowe.myshopify.com");
    expect(text(unconfirmed)).not.toMatch(/Disconnect Halden Rowe|Reconnect Halden Rowe|Disconnect halden-rowe/);
  });

  it("with no native tier, Reconnect shows for a composio row, and for an unlabelled one (C-18)", () => {
    for (const tier of ["composio", undefined] as const) {
      expect(text(card({ items: [connection({ status: "reauthorize", reauthorizeReason: "auth_error", ...(tier ? { tier } : {}) })] }))).toContain("Reconnect Halden Rowe");
    }
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

  it("shows staff no cached confirm panel or waiting line, whatever an earlier owner session left in the cache", () => {
    const html = card({ staff: true, pending, waiting: true });
    expect(html).not.toContain('data-testid="shopify-confirm"');
    expect(html).not.toContain('data-testid="shopify-waiting"');
    expect(html).not.toContain("Connect store");
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
