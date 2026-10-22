// UI audit U3 (Agents and Connections): what the screens say and offer in each agent state,
// server-rendered with the query cache filled, as a page would be on its first paint.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FOLLOW_UP_SETTINGS, type FollowUpStatus } from "@zs/contracts";
import { AgentsView } from "../src/components/agents/agents-view";
import { ConnectionsView } from "../src/components/account/connections-view";
import { ToastProvider } from "../src/components/ui/toast";
import { agentState, blockedSentence, quietHoursLabel, STOP_REASONS, zoneName } from "../src/lib/agents";
import { createApi, type CalendarConnection, type Connection, type ResourceSummary } from "../src/lib/api";
import { DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { ApiProvider } from "../src/lib/api/react";
import { scopeKeys } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";
import { singleFlight } from "../src/lib/single-flight";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/account/connections",
  useSearchParams: () => new URLSearchParams(),
}));

const keys = scopeKeys(DEMO_TENANT_ID);
const AGENT = "703cddeb-3f35-8dec-8397-426f06fb05ee";
const status = (patch: Partial<FollowUpStatus> = {}): FollowUpStatus => ({
  settings: { ...DEFAULT_FOLLOW_UP_SETTINGS, enabled: true, timeZone: "America/New_York" },
  revision: 1, updatedAt: null, killed: null, globalKilled: false, canDraft: true, blockedBy: null, ...patch,
});
const killed = { at: "2026-10-20T12:00:00.000Z", by: AGENT, note: null };

function render(view: () => ReactElement, fill: (client: QueryClient) => void, role: "owner" | "staff" = "owner"): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  fill(client);
  const runtime = createApi({ mode: "demo" });
  runtime.demo!.actAs(role);
  return renderToString(h(ApiProvider, { runtime, children: null },
    h(QueryClientProvider, { client }, h(SessionProvider, null, h(ToastProvider, null, view()))))).replaceAll("<!-- -->", "");
}
const renderAgents = (next: FollowUpStatus, role: "owner" | "staff" = "owner") =>
  render(() => h(AgentsView), (client) => client.setQueryData(keys.followUp, next), role);
/** The opening tag of the button whose text holds `label`, or null. */
const button = (html: string, label: string) => html.match(new RegExp(`<button([^>]*)>(?:(?!</button>).)*?${label}`))?.[1] ?? null;
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ");

describe("agents screen", () => {
  it("U3-4: runs one stop at a time, however fast the taps come", async () => {
    let calls = 0;
    let finish = () => undefined as void;
    const guard = singleFlight();
    const task = () => new Promise<void>((resolve) => { calls += 1; finish = resolve; });
    expect(guard(task)).toBe(true);
    expect(guard(task)).toBe(false);
    expect(calls).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(guard(task)).toBe(true);
    expect(calls).toBe(2);
    // A failed attempt frees the guard too, and the failure is not thrown at the click.
    const failing = singleFlight();
    expect(failing(() => Promise.reject(new Error("offline")))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing(() => Promise.resolve())).toBe(true);
  });

  it("U3-12, A-15: names a time zone in words, not its IANA id", () => {
    expect(zoneName("America/New_York")).toBe("Eastern Time (New York)");
    expect(zoneName("UTC")).toBe("UTC");
    expect(quietHoursLabel({ quietStartMinute: 1260, quietEndMinute: 480, timeZone: "America/New_York" })).toBe("9:00 PM to 8:00 AM, Eastern Time (New York)");
    const html = renderAgents(status());
    expect(html).toContain('<option value="America/New_York" selected="">Eastern Time (New York)</option>');
    expect(html).not.toContain("America/New York");
  });

  it("A-15: groups the per-customer limit with its time window", () => {
    const html = renderAgents(status());
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Per customer<\/legend>.*Drafts at most.*Within this many hours.*<\/fieldset>/);
  });

  it("A-12: says support paused the agent, and never that other businesses share the service", () => {
    const next = status({ globalKilled: true, canDraft: false, blockedBy: "global_killed" });
    expect(agentState(next)).toEqual({ label: "Paused by support", tone: "warn" });
    const html = textOf(renderAgents(next));
    expect(html).toContain("Paused by support");
    expect(html).toContain("Why it can't draft right now: Support paused it. Nothing is drafted until support turns it back on.");
    expect(html).not.toMatch(/It can draft now|>On</);
    for (const words of [html, blockedSentence(next)!, STOP_REASONS.global_killed]) expect(words).not.toMatch(/every business|all businesses|this service/i);
  });

  it("A-11: says it cannot draft when the server has no writing service", () => {
    expect(agentState(status(), { runnable: false })).toEqual({ label: "Can't draft yet", tone: "warn" });
    expect(blockedSentence(status(), { runnable: false })).toBe("No writing service is connected yet, so it drafts nothing.");
    // Off and stopped still say so first.
    expect(agentState(status({ settings: { ...status().settings, enabled: false }, canDraft: false, blockedBy: "disabled" }), { runnable: false }).label).toBe("Off");
  });

  it("A-13: offers Stop and Run now only when they can do something, and says why not", () => {
    const off = renderAgents(status({ settings: { ...status().settings, enabled: false }, canDraft: false, blockedBy: "disabled" }));
    expect(button(off, "Stop the agent")).toMatch(/disabled=""/);
    expect(button(off, "Stop the agent")).toMatch(/aria-describedby="stop-reason"/);
    expect(textOf(off)).toContain("It is turned off, so there is nothing to stop.");
    expect(button(off, "Run now")).toMatch(/disabled=""/);
    expect(button(off, "Run now")).toMatch(/aria-describedby="run-reason"/);
    expect(textOf(off)).toContain("Run now works when the agent can draft. See why above.");

    const quiet = renderAgents(status({ canDraft: false, blockedBy: "quiet_hours" }));
    expect(button(quiet, "Stop the agent")).not.toMatch(/disabled=""/);
    expect(button(quiet, "Run now")).toMatch(/disabled=""/);

    const on = renderAgents(status());
    expect(button(on, "Stop the agent")).not.toMatch(/disabled=""/);
    expect(button(on, "Run now")).not.toMatch(/disabled=""/);
  });

  it("A-14: one word for a stopped agent, the same colour as a stopped run, and a long note kept short", () => {
    const next = status({ killed: { ...killed, note: "x".repeat(400) }, canDraft: false, blockedBy: "tenant_killed" });
    expect(agentState(next)).toEqual({ label: "Stopped", tone: "warn" });
    expect(blockedSentence(next)).toBe("It is stopped. Nothing is drafted until an owner resumes it.");
    expect(STOP_REASONS.tenant_killed).toBe("the team stopped the agent");
    const html = renderAgents(next);
    expect(html).toMatch(/<q [^>]*class="[^"]*line-clamp-3[^"]*"/);
    expect(html).toContain("Show the whole note");
    expect(renderAgents(status({ killed: { ...killed, note: "Back Monday" }, canDraft: false, blockedBy: "tenant_killed" }))).not.toContain("Show the whole note");
  });

  it("A-10: a Resume staff cannot use does not look like a live primary button", () => {
    const next = status({ killed, canDraft: false, blockedBy: "tenant_killed" });
    expect(button(renderAgents(next, "staff"), "Resume")).not.toMatch(/bg-primary/);
    expect(button(renderAgents(next, "owner"), "Resume")).toMatch(/bg-primary/);
  });
});

const SHOWROOM: ResourceSummary = { id: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61", name: "Front desk", timeZone: "America/New_York", slotLengthMinutes: 30 };
const REPAIR: ResourceSummary = { id: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c62", name: "Studio", timeZone: "America/New_York", slotLengthMinutes: 30 };

describe("connections screen", () => {
  const renderConnections = () => render(() => h(ConnectionsView), (client) => {
    client.setQueryData(keys.resources, [SHOWROOM, REPAIR]);
    client.setQueryData<CalendarConnection[]>(keys.calendarConnections, []);
    client.setQueryData(keys.calendarPending, null);
    client.setQueryData<Connection[]>(keys.connections, [
      { id: "instagram", name: "Instagram", status: "needs_reconnect", purpose: "Brings messages into your inbox", detail: "Access expired" },
    ]);
  });

  it("U3-7: promises only what works on this page", () => {
    const html = textOf(renderConnections());
    expect(html).not.toContain("Fix anything marked here");
    expect(html).toContain("Connect Google Calendar here. The other accounts can't be changed here yet.");
    expect(html).toContain("Reconnect");
    expect(html).toContain("You can't change this here yet.");
    expect(html).not.toContain("go live");
  });
});
