// The API and the cron workers deploy as two Vercel projects, because a project's environment
// variables are visible to every function in it. These tests keep the API function from reading a
// worker-only secret, and the two build outputs from mixing (resend.md R-9, stripe.md S-8,
// google-calendar.md G-3, activepieces.md W-14, agents.md G-13). The env table is in README.md,
// "Hosted deploy".
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { bundleOptions } from "../scripts/bundle-options.mjs";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Variables only a cron function reads. None of them may be set on the API project, so none may
 * appear in the API bundle. Variables both read (DATABASE_CA_CERT, UNSUBSCRIBE_TOKEN_SECRET,
 * ACTIVEPIECES_KEY_SECRET, GOOGLE_CLIENT_*, GOOGLE_CHANNEL_SECRET, TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL, PUBLIC_BOOKING_KEY_SECRET, PUBLIC_BASE_URL) are not here.
 */
const WORKER_ONLY = [
  "CRON_SECRET",
  // delivery (src/delivery/config.ts, @zs/core resend.ts and twilio.ts)
  "DELIVERY_WORKER", "DELIVERY_WORKER_ID", "DELIVERY_DATABASE_URL", "DELIVERY_PRICE_EMAIL", "DELIVERY_PRICE_SMS_SEGMENT",
  "DELIVERY_CURRENCY", "DELIVERY_UNSUBSCRIBE_BASE_URL", "DELIVERY_RUN_BUDGET_MS", "DELIVERY_CLAIM_LIMIT",
  "DELIVERY_PROVIDER_TIMEOUT_MS", "DELIVERY_INTERVAL_MS", "SMS_PROVIDER",
  "RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_TO", "RESEND_BASE_URL",
  "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_BASE_URL", "TWILIO_OUTCOME_WAIT_MS",
  // billing
  "BILLING_WORKER", "BILLING_DATABASE_URL", "BILLING_CLAIM_LIMIT", "BILLING_RUN_BUDGET_MS", "BILLING_INTERVAL_MS",
  // calendar
  "CALENDAR_WORKER", "CALENDAR_DATABASE_URL", "CALENDAR_RUN_BUDGET_MS", "CALENDAR_INTERVAL_MS",
  "GOOGLE_TOKEN_PRIVATE_KEY", "GOOGLE_WEBHOOK_URL", "GOOGLE_EVENT_TITLE",
  // activepieces
  "ACTIVEPIECES_WEBHOOK_WORKER", "ACTIVEPIECES_DATABASE_URL", "ACTIVEPIECES_WORKER_ID", "ACTIVEPIECES_RUN_BUDGET_MS",
  "ACTIVEPIECES_CLAIM_LIMIT", "ACTIVEPIECES_REQUEST_TIMEOUT_MS", "ACTIVEPIECES_MAX_ATTEMPTS", "ACTIVEPIECES_INTERVAL_MS",
  // follow-up agent
  "FOLLOWUP_AGENT", "FOLLOWUP_DATABASE_URL", "FOLLOWUP_SERVICE_DATABASE_URL", "FOLLOWUP_MODEL", "AGENT_MODEL_PERSONAL_DATA",
  "AGENT_MODEL_NO_PERSONAL_DATA", "AGENT_TEMPLATED", "CEREBRAS_API_KEY", "CEREBRAS_MODEL", "DEEPSEEK_API_KEY", "DEEPSEEK_MODEL",
  // build variables of the worker project
  "DELIVERY_CRON_SCHEDULE", "BILLING_CRON_SCHEDULE", "CALENDAR_CRON_SCHEDULE", "ACTIVEPIECES_CRON_SCHEDULE", "FOLLOWUP_CRON_SCHEDULE",
];

/** Source files only a cron function may bundle: the runners, their starters and the cron routes. */
const WORKER_ONLY_SOURCES = [
  /\/src\/vercel-[a-z]+\.ts$/,
  /\/src\/(delivery|billing|calendar|activepieces|followup)\/(start|config|cron)\.ts$/,
];

async function bundleEntry(entry: string) {
  const result = await build({
    ...bundleOptions(join(API_DIR, "src", entry)),
    write: false,
    outfile: "bundle.mjs",
    metafile: true,
    // Comments are not code: drop them so a variable named in a doc comment is not a read.
    minifyWhitespace: true,
  });
  const inputs = Object.keys(Object.values(result.metafile.outputs)[0]!.inputs).map((path) => join(API_DIR, path));
  return { text: result.outputFiles[0]!.text, inputs };
}

describe("the API function (src/vercel.ts)", () => {
  it("never names a worker-only variable, so it cannot read one", async () => {
    const { text } = await bundleEntry("vercel.ts");
    const found = WORKER_ONLY.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    expect(found).toEqual([]);
    // Whatever else is added to the token key's name, the private half is never in the API.
    expect(text).not.toMatch(/_TOKEN_PRIVATE_KEY/);
  }, 60_000);

  it("bundles no cron route, runner or worker entry point", async () => {
    const { inputs } = await bundleEntry("vercel.ts");
    expect(inputs.filter((path) => WORKER_ONLY_SOURCES.some((pattern) => pattern.test(path)))).toEqual([]);
  }, 60_000);

  it.each(["vercel-delivery.ts", "vercel-billing.ts", "vercel-calendar.ts", "vercel-activepieces.ts", "vercel-followup.ts"])(
    "%s bundles no API app", async (entry) => {
      const { inputs } = await bundleEntry(entry);
      expect(inputs.filter((path) => /\/src\/(app|server|vercel)\.ts$/.test(path))).toEqual([]);
    }, 60_000);
});

describe("build-vercel.mjs", () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

  async function run(target: string) {
    const dir = await mkdtemp(join(tmpdir(), `zs-vercel-${target}-`));
    dirs.push(dir);
    const result = spawnSync(process.execPath, ["scripts/build-vercel.mjs", target, dir], {
      cwd: API_DIR,
      encoding: "utf8",
      // Every schedule set: the API build must ignore them, the worker build must use them.
      env: {
        ...process.env,
        DELIVERY_CRON_SCHEDULE: "*/5 * * * *", BILLING_CRON_SCHEDULE: "*/5 * * * *", CALENDAR_CRON_SCHEDULE: "*/5 * * * *",
        ACTIVEPIECES_CRON_SCHEDULE: "*/5 * * * *", FOLLOWUP_CRON_SCHEDULE: "0 * * * *",
      },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return {
      config: JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as { routes: { src: string; dest: string }[]; crons?: unknown },
      functions: (await readdir(join(dir, "functions"), { recursive: true })).filter((path) => path.endsWith(".func")).sort(),
    };
  }

  it("api: one function, no cron functions, no crons, every path to the API", async () => {
    const { config, functions } = await run("api");
    expect(functions).toEqual(["index.func"]);
    expect(config.crons).toBeUndefined();
    expect(config.routes).toEqual([{ src: "/(.*)", dest: "/index" }]);
  }, 60_000);

  it("worker: only the five cron functions and their schedules, no catch-all route", async () => {
    const { config, functions } = await run("worker");
    const names = ["activepieces", "billing", "calendar", "delivery", "followup"];
    expect(functions).toEqual(names.map((name) => join("cron", `${name}.func`)));
    expect(config.routes.map((route) => route.src).sort()).toEqual(names.map((name) => `/cron/${name}`));
    expect(config.routes.every((route) => route.src === route.dest)).toBe(true);
    expect(config.crons).toEqual([
      { path: "/cron/delivery", schedule: "*/5 * * * *" },
      { path: "/cron/billing", schedule: "*/5 * * * *" },
      { path: "/cron/calendar", schedule: "*/5 * * * *" },
      { path: "/cron/activepieces", schedule: "*/5 * * * *" },
      { path: "/cron/followup", schedule: "0 * * * *" },
    ]);
  }, 120_000);

  it("refuses an unknown target", () => {
    const result = spawnSync(process.execPath, ["scripts/build-vercel.mjs", "both"], { cwd: API_DIR, encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
