// Runs the real `src/scripts/followup-worker.ts` entry point as a child process (agents.md G-13):
// it does nothing while switched off, refuses a privileged runtime login, and otherwise runs the
// production wiring (runtime and service pools, the fake model) until SIGTERM.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

let database: TestDatabase;
let fixture: TwoTenantFixture;

function startWorker(env: Record<string, string>) {
  const child = spawn(TSX, ["src/scripts/followup-worker.ts"], {
    cwd: API_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, output: () => output, exited };
}

const runtimeUrl = () => {
  const url = new URL(database.url);
  url.username = "zs_runtime";
  return url.href;
};

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
}, 60_000);
afterAll(async () => {
  await database?.close();
});

describe("follow-up worker entry point", () => {
  it("exits at once while FOLLOWUP_AGENT is off", async () => {
    const worker = startWorker({ FOLLOWUP_AGENT: "off" });
    expect(await worker.exited).toBe(0);
    expect(worker.output()).toContain("FOLLOWUP_AGENT is off; nothing to run");
  });

  it("refuses a privileged login for the agent's actions", async () => {
    const worker = startWorker({
      FOLLOWUP_AGENT: "on", FOLLOWUP_MODEL: "fake",
      FOLLOWUP_DATABASE_URL: database.url, FOLLOWUP_SERVICE_DATABASE_URL: database.url,
    });
    expect(await worker.exited).not.toBe(0);
    expect(worker.output()).toContain("Refusing to start");
  });

  it("runs each enabled tenant's slot as the agent, and stops cleanly on SIGTERM", async () => {
    // Tenant A turns the agent on with no quiet hours, so a run happens whatever the time.
    await fixture.service((tx) => tx.query(
      `INSERT INTO agent_settings (tenant_id,enabled,quiet_start_minute,quiet_end_minute,updated_at) VALUES ($1,true,0,0,now())`,
      [fixture.a.tenantId]));
    const worker = startWorker({
      FOLLOWUP_AGENT: "on", FOLLOWUP_MODEL: "fake",
      FOLLOWUP_DATABASE_URL: runtimeUrl(), FOLLOWUP_SERVICE_DATABASE_URL: database.url,
      FOLLOWUP_INTERVAL_MS: "1000",
    });
    try {
      for (let i = 0; i < 200 && !worker.output().includes("Follow-up run"); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(worker.output()).toContain("Follow-up run");
    } finally {
      worker.child.kill("SIGTERM");
    }
    expect(await worker.exited, worker.output()).toBe(0);
    const runs = await fixture.service((tx) => tx.query<{ tenant_id: string; requested_by: string | null; status: string }>(
      "SELECT tenant_id, requested_by, status FROM agent_runs"));
    // One run for the current slot, for A only; B never turned the agent on.
    expect(runs.rows).toEqual([{ tenant_id: fixture.a.tenantId, requested_by: null, status: "completed" }]);
  }, 30_000);
});
