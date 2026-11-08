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
    expect(body).toContain("$2.50 held for sends in progress, of $41.18");
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
});

describe("the connections checklist", () => {
  it("reads each row from its connection list", () => {
    expect(connectionChecklist([], null).map((item) => [item.id, item.status])).toEqual([["google_calendar", "off"]]);
    expect(connectionChecklist([{ ...CALENDAR, status: "reauthorize" }], [STORE]).map((item) => item.status)).toEqual(["action", "ok"]);
    expect(connectionChecklist([{ ...CALENDAR, status: "disconnected" }], [{ ...STORE, readBlocked: true }]).map((item) => item.status)).toEqual(["off", "action"]);
    expect(connectionChecklist([CALENDAR], [{ ...STORE, status: "disconnected" }])[1]).toMatchObject({ status: "off", actionLabel: null });
  });
});
