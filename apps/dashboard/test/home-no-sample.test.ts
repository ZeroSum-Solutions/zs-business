// Home shows only what the API answers: the wallet from GET /v1/wallet (delivery.md D-4) and the
// connections from the routes the Connections page reads (google-calendar.md G-5, connections.md C-13).
// No sample badge, no invented usage meters, accounts or top-up amounts.
import type { QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WalletSummary } from "@zs/contracts";
import { HomeView } from "../src/components/home/home-view";
import { ApiError, type CalendarConnection, type ManagedConnection } from "../src/lib/api";
import { connectionChecklist } from "../src/lib/connection-checklist";
import { failQuery, keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
}));

const text = (html: string) => html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const CALENDAR: CalendarConnection = {
  id: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c70", provider: "google", resourceId: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61",
  calendarId: "primary", accountEmail: "owner@example.com", status: "active", lastSyncedAt: "2026-11-06T10:00:00.000Z",
  lastError: null, createdAt: "2026-11-01T10:00:00.000Z",
};
const STORE: ManagedConnection = {
  id: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c80", toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com",
  status: "active", reauthorizeReason: null, revokeFailed: false, readBlocked: false,
  lastCheckedAt: "2026-11-06T10:00:00.000Z", createdAt: "2026-11-01T10:00:00.000Z",
};
const WALLET: WalletSummary = { currency: "usd", balance: 4118, reserved: 250, available: 3868 };

function home(fill: (client: QueryClient) => void, staff = false) {
  return renderScreen(h(HomeView), { staff, fill: (client) => {
    client.setQueryData(keys.resources, []);
    fill(client);
  } });
}

const SAMPLE = /sample data|Sample data|Coming soon|Wallet and usage|top-up\b.*\$\d|Instagram|Google Business/;

describe("Home without sample data", () => {
  it("shows the wallet and the connections the API returned, and nothing invented", () => {
    const html = home((client) => {
      client.setQueryData(keys.wallet, WALLET);
      client.setQueryData(keys.calendarConnections, [CALENDAR]);
      client.setQueryData(keys.managedConnections, [STORE]);
    });
    const body = text(html);
    expect(html).not.toContain('data-testid="sample-badge"');
    expect(body).not.toMatch(SAMPLE);
    // The wallet in its own minor units: available, and what is held of the balance.
    expect(body).toContain("Available $38.68");
    // A reservation can be any priced job (D-11), and the API gives no breakdown: no "sends".
    expect(body).toContain("$2.50 held for jobs in progress, of $41.18");
    expect(body).not.toContain("held for sends");
    // No usage meters or caps: the API has no usage route.
    expect(html).not.toContain('role="meter"');
    expect(body).not.toMatch(/\d+ of \d+/);
    // The two connections, from their routes.
    expect(html).toContain('data-testid="checklist-google_calendar"');
    expect(html).toContain('data-testid="checklist-shopify"');
    expect(body).toContain("1 booking calendar syncing busy times");
    expect(body).toContain("Halden Rowe");
    expect(body).toContain("No connection needs you");
  });

  it("says the wallet is empty, and calls nothing connected that is not", () => {
    const body = text(home((client) => {
      client.setQueryData(keys.wallet, { currency: "usd", balance: 0, reserved: 0, available: 0 });
      client.setQueryData(keys.calendarConnections, []);
      client.setQueryData(keys.managedConnections, []);
    }));
    expect(body).toContain("No money in the wallet yet");
    expect(body).not.toContain("Available");
    expect(body.match(/Not connected/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).not.toContain("Everything is connected");
  });

  it("loads, and fails with a retry, instead of filling in sample rows", () => {
    const loading = home(() => undefined);
    expect(loading).toContain('aria-label="Loading the wallet"');
    expect(text(loading)).not.toMatch(SAMPLE);
    const failed = text(home((client) => {
      failQuery(client, keys.wallet, new ApiError("server", "We could not reach the server.", 503));
      failQuery(client, keys.calendarConnections, new ApiError("server", "We could not reach the server.", 503));
      client.setQueryData(keys.managedConnections, []);
    }));
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("Available");
    expect(failed).not.toContain("booking calendar");
  });

  it("asks the owner to reconnect a store that needs it", () => {
    const body = text(home((client) => {
      client.setQueryData(keys.wallet, WALLET);
      client.setQueryData(keys.calendarConnections, [CALENDAR]);
      client.setQueryData(keys.managedConnections, [{ ...STORE, status: "reauthorize", reauthorizeReason: "auth_error" }]);
    }));
    expect(body).toContain("1 connection needs you");
    expect(body).toContain("Needs action");
  });

  it("shows staff no wallet and no Shopify row: both are the owner's", () => {
    const html = home((client) => {
      client.setQueryData(keys.wallet, WALLET);
      client.setQueryData(keys.calendarConnections, [CALENDAR]);
    }, true);
    expect(html).not.toContain("wallet-title");
    expect(text(html)).not.toContain("$38.68");
    expect(html).toContain('data-testid="checklist-google_calendar"');
    expect(html).not.toContain('data-testid="checklist-shopify"');
  });

  it("tells staff to ask an owner instead of offering a Reconnect they cannot use", () => {
    const body = text(home((client) => {
      client.setQueryData(keys.calendarConnections, [{ ...CALENDAR, status: "reauthorize" }]);
    }, true));
    expect(body).toContain("Ask an owner to reconnect it.");
    expect(body).toContain("Needs an owner");
    expect(body).not.toMatch(/\bReconnect\b/);
  });

  it("shows a first sync, a failed sync and a disconnect as what they are", () => {
    const waiting = text(home((client) => {
      client.setQueryData(keys.wallet, WALLET);
      client.setQueryData(keys.calendarConnections, [{ ...CALENDAR, lastSyncedAt: null }]);
      client.setQueryData(keys.managedConnections, [{ ...STORE, status: "disconnecting" }]);
    }));
    expect(waiting).toContain("1 booking calendar waiting for the first sync");
    expect(waiting).not.toContain("syncing busy times");
    expect(waiting).toContain("Disconnecting halden-rowe.myshopify.com");
    expect(waiting).not.toContain("Not connected");
    const failed = text(home((client) => {
      client.setQueryData(keys.wallet, WALLET);
      client.setQueryData(keys.calendarConnections, [{ ...CALENDAR, lastError: "run_deadline" }]);
      client.setQueryData(keys.managedConnections, [STORE]);
    }));
    expect(failed).toContain("Sync problem");
    expect(failed).toContain("The last sync took too long.");
    expect(failed).not.toContain("syncing busy times");
  });
});

describe("the connections checklist", () => {
  const id = (n: number) => `0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c${String(n).padStart(2, "0")}`;

  it("reads each row from its connection list", () => {
    expect(connectionChecklist([], null).map((item) => [item.id, item.status])).toEqual([["google_calendar", "off"]]);
    expect(connectionChecklist([{ ...CALENDAR, status: "reauthorize" }], [STORE]).map((item) => item.status)).toEqual(["action", "ok"]);
    expect(connectionChecklist([{ ...CALENDAR, status: "disconnected" }], [{ ...STORE, readBlocked: true }]).map((item) => item.status)).toEqual(["off", "action"]);
    expect(connectionChecklist([CALENDAR], [{ ...STORE, status: "disconnected" }])[1]).toMatchObject({ status: "off", actionLabel: null });
  });

  it("tells a synced calendar from one waiting for its first sync and one whose last sync failed", () => {
    expect(connectionChecklist([CALENDAR], null)[0]).toMatchObject({ status: "ok", badge: "Connected", detail: "1 booking calendar syncing busy times" });
    expect(connectionChecklist([{ ...CALENDAR, lastSyncedAt: null }], null)[0]).toMatchObject({ status: "pending", badge: "Waiting", detail: expect.stringContaining("waiting for the first sync") });
    expect(connectionChecklist([{ ...CALENDAR, lastError: "too_many_changes" }], null)[0]).toMatchObject({ status: "warn", badge: "Sync problem", detail: expect.stringContaining("Too many changes") });
    // Only the synced ones are counted as syncing.
    const two = connectionChecklist([CALENDAR, { ...CALENDAR, id: id(71), resourceId: id(62), lastSyncedAt: null }], null)[0]!;
    expect(two.status).toBe("pending");
  });

  it("keeps a disconnecting calendar or store as disconnecting, and says when the cleanup is stuck", () => {
    expect(connectionChecklist([{ ...CALENDAR, status: "disconnecting" }], null)[0]).toMatchObject({ status: "pending", badge: "Disconnecting", detail: expect.stringContaining("Removing its busy times") });
    expect(connectionChecklist([{ ...CALENDAR, status: "disconnecting", lastError: "revoke_failed" }], null)[0]).toMatchObject({ status: "warn", badge: "Disconnect stuck", detail: expect.stringContaining("still block slots") });
    expect(connectionChecklist([{ ...CALENDAR, status: "disconnecting", lastError: "token_unreadable" }], null)[0]!.detail).toContain("could not read the saved Google access");
    // A live connection of the same calendar is the current one: an older disconnect behind it is history (G-4).
    expect(connectionChecklist([CALENDAR, { ...CALENDAR, id: id(72), status: "disconnecting", lastError: "revoke_failed", createdAt: "2026-10-01T10:00:00.000Z" }], null)[0]!.status).toBe("ok");
    expect(connectionChecklist([], [{ ...STORE, status: "disconnecting" }])[1]).toMatchObject({ status: "pending", badge: "Disconnecting", actionLabel: null });
  });

  it("keeps a Shopify revoke warning until a newer connection of the same store replaces it", () => {
    const unrevoked: ManagedConnection = { ...STORE, status: "disconnected", revokeFailed: true };
    expect(connectionChecklist([], [unrevoked])[1]).toMatchObject({ status: "action", actionLabel: "See steps", detail: expect.stringContaining("Remove the app in your Shopify admin") });
    const newer: ManagedConnection = { ...STORE, id: id(81), createdAt: "2026-11-05T10:00:00.000Z" };
    expect(connectionChecklist([], [unrevoked, newer])[1]).toMatchObject({ status: "ok", detail: "Halden Rowe" });
    // A plain disconnected store is history.
    expect(connectionChecklist([], [{ ...STORE, status: "disconnected" }])[1]!.status).toBe("off");
  });

  it("offers Reconnect only to someone who can manage calendars", () => {
    const owner = connectionChecklist([{ ...CALENDAR, status: "reauthorize" }], null)[0]!;
    expect(owner).toMatchObject({ status: "action", actionLabel: "Reconnect" });
    const staff = connectionChecklist([{ ...CALENDAR, status: "reauthorize" }], null, { canManageCalendars: false })[0]!;
    expect(staff).toMatchObject({ status: "action", actionLabel: null, badge: "Needs an owner" });
    expect(staff.detail).toContain("Ask an owner to reconnect it.");
  });
});
