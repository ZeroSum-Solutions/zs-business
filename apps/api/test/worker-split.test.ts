// The API and the cron workers deploy as two Vercel projects, because a project's environment
// variables are visible to every function in it. These tests keep the API function from reading a
// worker-only secret, and the two build outputs from mixing (resend.md R-9, stripe.md S-8,
// google-calendar.md G-3, activepieces.md W-14, agents.md G-13). The env table is in README.md,
// "Hosted deploy"; the list of worker-only names is scripts/worker-env.mjs.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { bundleOptions } from "../scripts/bundle-options.mjs";
import { CRON_SCHEDULE_VARIABLES, WORKER_ONLY_ENV } from "../scripts/worker-env.mjs";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const slash = (path: string) => path.replaceAll("\\", "/");

/** Source files only a cron function or a Mac worker may bundle: runners, starters, cron routes, worker configs, scripts. */
const WORKER_ONLY_SOURCES = [
  /\/apps\/api\/src\/vercel-[a-z]+\.ts$/,
  /\/apps\/api\/src\/(delivery|billing|calendar|activepieces|followup|enrichment|images|connections)\/(start|config|cron|runner|internal)\.ts$/,
  /\/apps\/api\/src\/scripts\//,
];

/** Reading every variable at once would defeat the name check: the API reads declared names only. */
const ENV_DUMPS = [/Object\s*\.\s*(keys|entries|values)\s*\(\s*process\s*\.\s*env\b/, /\.\.\.\s*process\s*\.\s*env\b/];

/** Comments are not code: drop them (and legal comments) so a variable named in a doc comment is not a read. */
async function withoutComments(code: string) {
  return (await transform(code, { loader: "js", format: "esm", minifyWhitespace: true, legalComments: "none" })).code;
}

async function bundleEntry(entry: string) {
  const result = await build({
    ...bundleOptions(join(API_DIR, "src", entry)),
    absWorkingDir: API_DIR,
    write: false,
    outfile: "bundle.mjs",
    metafile: true,
    minifyWhitespace: true,
  });
  const inputs = Object.keys(Object.values(result.metafile.outputs)[0]!.inputs).map((path) => slash(join(API_DIR, path)));
  return { text: result.outputFiles[0]!.text, inputs };
}

function namedIn(text: string) {
  return WORKER_ONLY_ENV.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

describe("the worker-only list", () => {
  it("has no duplicates and includes every schedule variable", () => {
    expect(new Set(WORKER_ONLY_ENV).size).toBe(WORKER_ONLY_ENV.length);
    for (const name of CRON_SCHEDULE_VARIABLES) expect(WORKER_ONLY_ENV).toContain(name);
  });

  it("is in the README env table, marked as not for the API project", async () => {
    const readme = await readFile(join(API_DIR, "README.md"), "utf8");
    // A name is documented as a code span; a group row can list several in one cell.
    expect(WORKER_ONLY_ENV.filter((name) => !readme.includes(`\`${name}\``))).toEqual([]);
  });
});

describe("the API function (src/vercel.ts)", () => {
  it("never names a worker-only variable, so it cannot read one", async () => {
    const { text } = await bundleEntry("vercel.ts");
    expect(namedIn(text)).toEqual([]);
    // Whatever else is added to the token key's name, the private half is never in the API.
    expect(text).not.toMatch(/_TOKEN_PRIVATE_KEY/);
  }, 60_000);

  it("does not read the whole environment (Object.keys, Object.entries, a spread)", async () => {
    const { text } = await bundleEntry("vercel.ts");
    expect(ENV_DUMPS.filter((pattern) => pattern.test(text)).map(String)).toEqual([]);
  }, 60_000);

  it("bundles no cron route, runner, worker config or script", async () => {
    const { inputs } = await bundleEntry("vercel.ts");
    expect(inputs.filter((path) => WORKER_ONLY_SOURCES.some((pattern) => pattern.test(path)))).toEqual([]);
  }, 60_000);

  it.each(["vercel-delivery.ts", "vercel-billing.ts", "vercel-calendar.ts", "vercel-activepieces.ts", "vercel-followup.ts", "vercel-connections.ts"])(
    "%s bundles no API app", async (entry) => {
      const { inputs } = await bundleEntry(entry);
      expect(inputs.filter((path) => /\/src\/(app|server|vercel)\.ts$/.test(path))).toEqual([]);
    }, 60_000);
});

describe("build-vercel.mjs", () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

  const noSchedules = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CRON_SCHEDULE_VARIABLES.includes(name)));
  const allSchedules = {
    DELIVERY_CRON_SCHEDULE: "*/5 * * * *", BILLING_CRON_SCHEDULE: "*/5 * * * *", CALENDAR_CRON_SCHEDULE: "*/5 * * * *",
    ACTIVEPIECES_CRON_SCHEDULE: "*/5 * * * *", FOLLOWUP_CRON_SCHEDULE: "0 * * * *", CONNECTIONS_CRON_SCHEDULE: "*/10 * * * *",
  };

  /** A fresh, empty directory path: the script writes into an empty or missing directory only. */
  async function freshDir() {
    const dir = await mkdtemp(join(tmpdir(), "zs-vercel-"));
    dirs.push(dir);
    return dir;
  }

  async function runScript(target: string, dir: string, schedules: Record<string, string>) {
    return spawnSync(process.execPath, ["scripts/build-vercel.mjs", target, dir], {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...noSchedules, ...schedules },
    });
  }

  async function run(target: string, schedules: Record<string, string>) {
    const dir = await freshDir();
    const result = await runScript(target, dir, schedules);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Wrote ${dir} (${target})`);
    return {
      dir,
      config: JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as { routes: { src: string; dest: string }[]; crons?: unknown },
      functions: (await readdir(join(dir, "functions"), { recursive: true })).map(slash).filter((path) => path.endsWith(".func")).sort(),
    };
  }

  it("api: one function, no cron functions, no crons, every path to the API, and its static files", async () => {
    const { dir, config, functions } = await run("api", {});
    expect(functions).toEqual(["index.func"]);
    expect(config.crons).toBeUndefined();
    expect(config.routes).toEqual([{ src: "/(.*)", dest: "/index" }]);
    expect((await stat(join(dir, "functions", "index.func", "static"))).isDirectory()).toBe(true);
  }, 60_000);

  it("api: the emitted function file names no worker-only variable and does not dump the environment", async () => {
    const { dir } = await run("api", {});
    const emitted = await withoutComments(await readFile(join(dir, "functions", "index.func", "index.mjs"), "utf8"));
    expect(namedIn(emitted)).toEqual([]);
    expect(ENV_DUMPS.filter((pattern) => pattern.test(emitted)).map(String)).toEqual([]);
  }, 60_000);

  it.each(CRON_SCHEDULE_VARIABLES)("api: fails when %s is set, so a deploy cannot drop a live cron", async (name) => {
    const dir = await freshDir();
    const result = await runScript("api", dir, { [name]: "*/5 * * * *" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("no crons");
    expect(await readdir(dir)).toEqual([]);
  });

  it("worker: only the cron functions and the signed connections routes, their schedules, exact anchored routes, no static files", async () => {
    const { dir, config, functions } = await run("worker", allSchedules);
    const names = ["activepieces", "billing", "calendar", "connections", "delivery", "followup"].map((name) => `cron/${name}`);
    const internal = [
      ...["cancel", "complete", "disconnect", "link", "run"].map((name) => `internal/connections/${name}`),
      ...["open", "create_hub", "redeem_claim", "sign_in", "claim_start", "claim_status", "claim_cancel", "claim_confirm", "orders"].map((name) => `internal/shopify/${name}`),
      "webhooks/shopify",
    ];
    expect(functions).toEqual([...names, ...internal].map((name) => `${name}.func`).sort());
    expect(config.routes.map((route) => route.src).sort()).toEqual([...names, ...internal].map((name) => `^/${name}$`).sort());
    expect(config.routes.map((route) => route.dest).sort()).toEqual([...names, ...internal].map((name) => `/${name}`).sort());
    // The anchored pattern reaches the exact path only.
    for (const route of config.routes) {
      expect(new RegExp(route.src).test(route.dest)).toBe(true);
      for (const other of [`${route.dest}/x`, `${route.dest}x`, `/api${route.dest}`, "/", "/v1/clients"]) expect(new RegExp(route.src).test(other)).toBe(false);
    }
    expect(config.crons).toEqual([
      { path: "/cron/delivery", schedule: "*/5 * * * *" },
      { path: "/cron/billing", schedule: "*/5 * * * *" },
      { path: "/cron/calendar", schedule: "*/5 * * * *" },
      { path: "/cron/activepieces", schedule: "*/5 * * * *" },
      { path: "/cron/followup", schedule: "0 * * * *" },
      { path: "/cron/connections", schedule: "*/10 * * * *" },
    ]);
    await expect(stat(join(dir, "functions", "index.func"))).rejects.toThrow();
    await expect(stat(join(dir, "functions", "cron", "delivery.func", "static"))).rejects.toThrow();
  }, 120_000);

  it("worker: with no schedule variables there is no crons key", async () => {
    const { config, functions } = await run("worker", {});
    expect(functions).toHaveLength(21);
    expect(config.crons).toBeUndefined();
  }, 120_000);

  it("worker: an invalid schedule exits non-zero and names the variable", async () => {
    const dir = await freshDir();
    const result = await runScript("worker", dir, { ACTIVEPIECES_CRON_SCHEDULE: "every five minutes" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTIVEPIECES_CRON_SCHEDULE");
  });

  it("refuses an unknown target", () => {
    const result = spawnSync(process.execPath, ["scripts/build-vercel.mjs", "both"], { cwd: API_DIR, encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("refuses a non-empty output directory and leaves its files alone", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "keep.txt"), "mine");
    await writeFile(join(dir, "sub", "deep.txt"), "mine too");
    for (const target of ["api", "worker"]) {
      const result = await runScript(target, dir, {});
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not empty");
    }
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(dir, "sub", "deep.txt"), "utf8")).toBe("mine too");
  });

  it("refuses an output path that is a file, and accepts a path that does not exist yet", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "file"), "x");
    const asFile = await runScript("worker", join(dir, "file"), {});
    expect(asFile.status).not.toBe(0);
    expect(asFile.stderr).toContain("not a directory");
    expect(await readFile(join(dir, "file"), "utf8")).toBe("x");
    const missing = await runScript("worker", join(dir, "new", "out"), {});
    expect(missing.status, missing.stderr).toBe(0);
    expect((await stat(join(dir, "new", "out", "config.json"))).isFile()).toBe(true);
  }, 120_000);
});
