// Website tasks (browser-tasks.md BT-3, BT-9, BT-12) in the demo adapter and on the Agents screen:
// owners set up, run and resume; staff read and stop; a run is read-only and shows its steps and files.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_STOP_REASONS, browserRunDetailSchema, browserRunSchema, browserStatusSchema, type BrowserStatus } from "@zs/contracts";
import { BrowserTasksCard } from "../src/components/agents/browser-tasks";
import { ToastProvider } from "../src/components/ui/toast";
import type { ApiError } from "../src/lib/api/errors";
import { createApi } from "../src/lib/api";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_OWNER, DEMO_STAFF, DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { ApiProvider } from "../src/lib/api/react";
import { BROWSER_BLOCKED_WORDS, BROWSER_STOP_WORDS, monthLabel, recentMonths, stopSentence } from "../src/lib/browser-tasks";
import { scopeKeys } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = new Date("2026-10-18T13:00:00.000Z");
function adapter() {
  let ids = 0;
  return createDemoAdapter({
    clock: { now: () => NOW },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
}
let keyCount = 0;
const key = () => ({ idempotencyKey: `browser-key-${++keyCount}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

describe("demo adapter: website tasks", () => {
  it("reads a status in contract shape with one set-up website, ready to run", async () => {
    const status = browserStatusSchema.parse(await adapter().getBrowserStatus());
    expect(status).toMatchObject({ blockedBy: null, killed: null, runsToday: 0, settings: { enabled: true } });
    expect(status.targets).toHaveLength(1);
    expect(status.targets[0]).toMatchObject({ enabled: true, hasCredentials: true });
    expect(JSON.stringify(status)).not.toMatch(/password|secret/i);
  });

  it("runs the task for an owner: five steps, two files, counted against today's cap", async () => {
    const api = adapter();
    const target = (await api.getBrowserStatus()).targets[0]!;
    const run = browserRunSchema.parse(await api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, key()));
    expect(run).toMatchObject({ status: "completed", stopReason: null, steps: 5, artifactCount: 2, month: "2026-09" });
    const detail = browserRunDetailSchema.parse(await api.getBrowserRun(run.id));
    expect(detail.events.map((event) => event.action)).toEqual(["sign_in", "open", "set_date_filter", "download", "stop"]);
    expect(detail.artifacts.map((file) => file.name)).toEqual(["2026-09-001.pdf", "2026-09-002.pdf"]);
    expect((await api.listBrowserRuns()).map((item) => item.id)).toEqual([run.id]);
    expect(await api.getBrowserStatus()).toMatchObject({ runsToday: 1, costTodayMicros: 50 });
  });

  it("replays a repeated key and refuses a malformed or unknown run", async () => {
    const api = adapter();
    const target = (await api.getBrowserStatus()).targets[0]!;
    const same = key();
    const first = await api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, same);
    const again = await api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, same);
    expect(again.id).toBe(first.id);
    expect(await api.listBrowserRuns()).toHaveLength(1);
    expect((await failure(api.getBrowserRun("not-an-id")))?.kind).toBe("not_found");
    expect((await failure(api.getBrowserRun("00000000-0000-4000-8000-0000000000ff")))?.kind).toBe("not_found");
  });

  it("lets staff stop but not resume, change settings or run; an owner resumes", async () => {
    const api = adapter();
    const target = (await api.getBrowserStatus()).targets[0]!;
    api.actAs("staff");
    const stopped = await api.killBrowser({ note: "wrong supplier" }, key());
    expect(stopped).toMatchObject({ blockedBy: "tenant_killed", killed: { by: DEMO_STAFF.userId, note: "wrong supplier" } });
    expect((await failure(api.resumeBrowser(key())))?.kind).toBe("forbidden");
    expect((await failure(api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, key())))?.kind).toBe("forbidden");
    expect((await failure(api.updateBrowserSettings({ expectedRevision: 1, enabled: false, maxRunsPerDay: 1, maxCostMicrosPerDay: 0 }, key())))?.kind).toBe("forbidden");
    api.actAs("owner");
    // A stopped switch keeps its first note, and blocks a run with a reason the screen can word.
    expect((await api.killBrowser({ note: "second" }, key())).killed?.note).toBe("wrong supplier");
    expect((await failure(api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, key())))?.reason).toBe("tenant_killed");
    expect((await api.resumeBrowser(key())).killed).toBeNull();
    expect(DEMO_OWNER.userId).not.toBe(DEMO_STAFF.userId);
  });

  it("stops at the daily cap, for every business when the operator's switch is on, and on a stale save", async () => {
    const api = adapter();
    const target = (await api.getBrowserStatus()).targets[0]!;
    const settings = await api.updateBrowserSettings({ expectedRevision: 1, enabled: true, maxRunsPerDay: 1, maxCostMicrosPerDay: 5_000_000 }, key());
    expect(settings.revision).toBe(2);
    expect((await failure(api.updateBrowserSettings({ expectedRevision: 1, enabled: true, maxRunsPerDay: 2, maxCostMicrosPerDay: 1 }, key())))?.reason).toBe("stale_revision");
    await api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, key());
    expect((await failure(api.requestBrowserRun({ targetId: target.id, month: "2026-08" }, key())))?.reason).toBe("daily_cap");
    api.setGlobalBrowserKill(true);
    expect((await api.getBrowserStatus()).blockedBy).toBe("global_killed");
  });

  it("refuses a target that is switched off", async () => {
    const api = adapter();
    const target = (await api.getBrowserStatus()).targets[0]!;
    const saved = await api.saveBrowserTarget({
      targetId: target.id, expectedRevision: target.revision, name: target.name, taskKind: target.taskKind, allowedOrigins: target.allowedOrigins,
      allowedPaths: target.allowedPaths, assetPaths: [], signInPath: "/login", enabled: false,
    }, key());
    expect(saved).toMatchObject({ enabled: false, revision: target.revision + 1 });
    expect((await failure(api.requestBrowserRun({ targetId: target.id, month: "2026-09" }, key())))?.reason).toBe("target_disabled");
  });
});

describe("website task words", () => {
  it("has plain words for every stop reason and every blocked reason", () => {
    for (const reason of BROWSER_STOP_REASONS) expect(BROWSER_STOP_WORDS[reason]).toMatch(/\w/);
    expect(Object.keys(BROWSER_BLOCKED_WORDS).sort()).toEqual(["cost_cap", "daily_cap", "disabled", "global_killed", "tenant_killed"]);
    expect(stopSentence({ status: "stopped", stopReason: "write_refused" })).toBe(
      "Stopped because the page asked it to change something, and website tasks only read.",
    );
    expect(stopSentence({ status: "completed", stopReason: null })).toBeNull();
  });

  it("names months and lists the last twelve, newest first, across a year end", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    const months = recentMonths(new Date("2026-02-10T00:00:00.000Z"), 4);
    expect(months).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});

describe("agents screen: website tasks card", () => {
  const keys = scopeKeys(DEMO_TENANT_ID);
  const render = async (patch: Partial<BrowserStatus> = {}, role: "owner" | "staff" = "owner") => {
    const runtime = createApi({ mode: "demo" });
    runtime.demo!.actAs(role);
    const base = await runtime.api.getBrowserStatus();
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(keys.browser, { ...base, ...patch });
    client.setQueryData(keys.browserRuns, []);
    return renderToString(h(ApiProvider, { runtime, children: null },
      h(QueryClientProvider, { client }, h(SessionProvider, null, h(ToastProvider, null, h(BrowserTasksCard)))))).replaceAll("<!-- -->", "");
  };
  const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");

  it("says it reads only, shows Ready, and offers the owner a run and a stop", async () => {
    const text = textOf(await render());
    expect(text).toContain("It only reads");
    expect(text).toContain("Ready");
    expect(text).toContain("It can run now.");
    expect(text).toContain("Stop website tasks");
    expect(text).toContain("Save invoices now");
    expect(text).toContain("Cascade Dental Supply");
    expect(text).toContain("No runs yet");
  });

  it("says why it is stopped and offers Resume", async () => {
    const html = await render({ blockedBy: "tenant_killed", killed: { at: NOW.toISOString(), by: DEMO_OWNER.userId, note: "check the supplier" } });
    const text = textOf(html);
    expect(text).toContain("Stopped");
    expect(text).toContain("Website tasks are stopped. An owner can resume them.");
    expect(text).toContain("check the supplier");
    expect(text).toContain("Resume website tasks");
    expect(text).not.toContain("Stop website tasks");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save invoices now/);
  });

  it("gives staff the stop but not the run form", async () => {
    const text = textOf(await render({}, "staff"));
    expect(text).toContain("Stop website tasks");
    expect(text).not.toContain("Save invoices now");
  });
});
