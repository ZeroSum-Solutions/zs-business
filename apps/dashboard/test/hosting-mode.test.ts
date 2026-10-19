import { afterEach, describe, expect, it, vi } from "vitest";
import { hostingModeGuard, hostingModeProblem } from "../src/lib/server/hosting-mode";
import { proxy } from "../src/proxy";

const LIVE = { ZS_API_URL: "https://api.example.test", ZS_API_TOKEN: "t" };

describe("hosting mode guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes when build and server agree", () => {
    expect(hostingModeProblem("live", LIVE)).toBeNull();
    expect(hostingModeProblem("demo", {})).toBeNull();
    expect(hostingModeProblem("demo", { ZS_API_URL: "  " })).toBeNull();
    expect(hostingModeGuard("demo", {}, () => undefined)).toBeNull();
  });

  it("refuses a demo build started with live settings, with a 500 and one log line", async () => {
    const log = vi.fn();
    const response = hostingModeGuard("demo", LIVE, log)!;
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toMatch(/built for demo mode .* server has ZS_API_URL set/);
    hostingModeGuard("demo", LIVE, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/Hosting mode mismatch/);
  });

  it("refuses a live build started without ZS_API_URL", async () => {
    const response = hostingModeGuard("live", {}, () => undefined)!;
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/built for live mode .* server has no ZS_API_URL/);
    // An unset baked value is a demo build.
    expect(hostingModeProblem(undefined, LIVE)).toMatch(/built for demo mode/);
  });

  it("never puts the API URL or token in the reply", async () => {
    const text = await hostingModeGuard("demo", LIVE, () => undefined)!.text();
    expect(text).not.toContain(LIVE.ZS_API_URL);
    expect(text).not.toContain("api.example.test");
  });

  it("the proxy refuses in both directions and passes otherwise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "demo");
    vi.stubEnv("ZS_API_URL", LIVE.ZS_API_URL);
    expect(proxy().status).toBe(500);
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "live");
    vi.stubEnv("ZS_API_URL", "");
    expect(proxy().status).toBe(500);
    vi.stubEnv("ZS_API_URL", LIVE.ZS_API_URL);
    const next = proxy();
    expect(next.status).toBe(200);
    expect(next.headers.get("x-middleware-next")).toBe("1");
  });
});
