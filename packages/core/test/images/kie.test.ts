// image-port.md IM-17..IM-19, second slice acceptance test 2: the Kie.ai adapter against handwritten
// fixtures (kie.fixtures.ts) and an injected fetch that routes by URL. Nothing here reaches Kie.
import { describe, expect, it } from "vitest";
import type { ImagePreset } from "@zs/contracts";
import {
  createKieImageWorkflowPort, findAllowedModel, IMAGE_MODEL_ALLOWLIST, ImageAdapterRefused, ImageOutcomeUnknown,
  isForbiddenModel, KIE_HOSTS, NON_COMMERCIAL_LICENSE, sha256Hex, type PresetInput,
} from "../../src/images/index.js";
import { backgroundSize, KIE_MODELS, upscaleFactor } from "../../src/images/adapters/kie.js";
import { checkMatte, checkProductPixels, composite, effectiveAlpha } from "../../src/images/compose.js";
import { decodePng, encodeRgbaPng, readImageInfo } from "../../src/images/png.js";
import {
  createOk, createRefused, cutoutPng, flatPng, KIE_TEST_KEY, record, RESULT_HOST, sourceImage, uploadOk, UPLOADED_URL,
} from "./kie.fixtures.js";

const COSTS = { background_remove: 3_000, studio_background_swap: 9_000, upscale_2k: 6_000 }; // TODO verify: test values only.
const W = 256; const H = 256;
const SOURCE = encodeRgbaPng(sourceImage(W, H));
const CUTOUT = cutoutPng(W, H);
const BACKGROUND = flatPng(512, 512, [200, 190, 180]);
const UP_SOURCE = encodeRgbaPng(sourceImage(512, 256));
const UPSCALED = flatPng(2048, 1024, [10, 20, 30]);

function input(preset: ImagePreset, bytes = preset === "upscale_2k" ? UP_SOURCE : SOURCE): PresetInput {
  const info = readImageInfo(bytes)!;
  return {
    tenantId: "11111111-2222-4333-8444-555555555555", variantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", preset,
    params: preset === "studio_background_swap" ? { aspectRatio: "source", backgroundDescription: "warm linen" } : { aspectRatio: "source" },
    source: { bytes, contentType: "image/png", sha256: sha256Hex(bytes), width: info.width, height: info.height },
    idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };
}

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }
type Route = (seen: Seen) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const png = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });

/** A fake Kie: tasks by model, each answering `states` in turn (the last repeats), then their file. */
function fakeKie(options: {
  states?: Partial<Record<string, ("waiting" | "generating" | "success" | "fail")[]>>;
  files?: Partial<Record<string, Uint8Array>>;
  resultUrl?: (model: string) => string;
  override?: Partial<Record<"upload" | "create" | "record" | "file", Route>>;
} = {}) {
  const seen: Seen[] = [];
  const tasks = new Map<string, { model: string; polls: number }>();
  const files: Record<string, Uint8Array> = {
    [KIE_MODELS.cutout]: CUTOUT, [KIE_MODELS.background]: BACKGROUND, [KIE_MODELS.upscale]: UPSCALED, ...options.files,
  };
  const resultUrl = options.resultUrl ?? ((model: string) => `${RESULT_HOST}/r/${model.replace(/\W/g, "-")}.png`);
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = { url: String(url), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") };
    expect(init?.redirect).toBe("manual");
    seen.push(entry);
    const u = new URL(entry.url);
    if (u.pathname === "/api/file-base64-upload") return (options.override?.upload ?? (() => json(uploadOk())))(entry);
    if (u.pathname === "/api/v1/jobs/createTask") {
      if (options.override?.create) return options.override.create(entry);
      const { model } = JSON.parse(entry.body) as { model: string };
      const taskId = `task${tasks.size + 1}_${model.split("/")[0]}`;
      tasks.set(taskId, { model, polls: 0 });
      return json(createOk(taskId));
    }
    if (u.pathname === "/api/v1/jobs/recordInfo") {
      if (options.override?.record) return options.override.record(entry);
      const taskId = u.searchParams.get("taskId")!;
      const task = tasks.get(taskId)!;
      const list = options.states?.[task.model] ?? ["generating", "success"];
      const state = list[Math.min(task.polls, list.length - 1)]!;
      task.polls += 1;
      return json(record(taskId, task.model, state, state === "success" ? [resultUrl(task.model)] : []));
    }
    if (options.override?.file) return options.override.file(entry);
    const model = Object.keys(files).find((m) => entry.url === resultUrl(m));
    return model ? png(files[model]!) : new Response("missing", { status: 404 });
  };
  return { seen, tasks, fetcher: fetcher as unknown as typeof fetch };
}

function adapter(fetcher: typeof fetch, extra: { timeoutMs?: number } = {}) {
  let now = Date.parse("2026-10-24T09:00:00.000Z");
  const sleeps: number[] = [];
  const port = createKieImageWorkflowPort({
    apiKey: KIE_TEST_KEY, fetch: fetcher, clock: { now: () => new Date(now) },
    sleep: async (ms) => { sleeps.push(ms); now += ms; }, vendorCostMicros: COSTS, pollIntervalMs: 2_000, ...extra,
  });
  return { port, sleeps };
}
const creates = (seen: Seen[]) => seen.filter((s) => s.url.endsWith("/api/v1/jobs/createTask"));

/** The worker's own IM-9 checks, run on the adapter's output. */
function passesWorkerChecks(source: Uint8Array, output: { bytes: Uint8Array; matte: { bytes: Uint8Array } | null; background: { bytes: Uint8Array } | null }) {
  const decoded = decodePng(source);
  const matte = checkMatte(output.matte!.bytes, decoded);
  expect(matte.ok).toBe(true);
  if (!matte.ok) return;
  const background = output.background ? decodePng(output.background.bytes) : null;
  const expected = composite(decoded, matte.alpha, background);
  expect(checkProductPixels(expected, effectiveAlpha(decoded, matte.alpha), decodePng(output.bytes))).toEqual({ ok: true });
}

describe("each preset end to end (IM-17)", () => {
  it("background_remove: upload, one cut-out task, poll, fetch once, our composite passes the worker's checks", async () => {
    const kie = fakeKie();
    const { port, sleeps } = adapter(kie.fetcher);
    const output = await port.runPreset(input("background_remove"));
    expect(kie.seen.map((s) => `${s.method} ${new URL(s.url).host}${new URL(s.url).pathname}`)).toEqual([
      "POST kieai.redpandaai.co/api/file-base64-upload",
      "POST api.kie.ai/api/v1/jobs/createTask",
      "GET api.kie.ai/api/v1/jobs/recordInfo",
      "GET api.kie.ai/api/v1/jobs/recordInfo",
      "GET tempfile.aiquickdraw.com/r/recraft-remove-background.png",
    ]);
    expect(sleeps).toEqual([2_000]);
    const upload = JSON.parse(kie.seen[0]!.body) as { base64Data: string };
    expect(upload.base64Data).toBe(`data:image/png;base64,${Buffer.from(SOURCE).toString("base64")}`);
    expect(JSON.parse(creates(kie.seen)[0]!.body)).toEqual({ model: "recraft/remove-background", input: { image: UPLOADED_URL } });
    expect(output).toMatchObject({
      contentType: "image/png", width: W, height: H, background: null,
      provenance: { adapter: "kie", modelId: "recraft/remove-background", promptText: null, providerJobId: "task1_recraft", vendorCostMicros: 3_000 },
    });
    expect(output.sha256).toBe(sha256Hex(output.bytes));
    expect(output.provenance.workflowHash).toMatch(/^[0-9a-f]{64}$/);
    passesWorkerChecks(SOURCE, output);
  });

  it("studio_background_swap: two tasks, the fixed prompt, both IDs in the job ID, background fitted to the source", async () => {
    const kie = fakeKie();
    const { port } = adapter(kie.fetcher);
    const output = await port.runPreset(input("studio_background_swap"));
    const bodies = creates(kie.seen).map((s) => JSON.parse(s.body) as { model: string; input: Record<string, unknown> });
    expect(bodies).toEqual([
      { model: "recraft/remove-background", input: { image: UPLOADED_URL } },
      { model: "bytedance/seedream-v4-text-to-image", input: { prompt: "Studio product photo background: warm linen", image_size: "square_hd", image_resolution: "1K", max_images: 1 } },
    ]);
    expect(output.provenance).toMatchObject({
      modelId: "recraft/remove-background+bytedance/seedream-v4-text-to-image",
      promptText: "Studio product photo background: warm linen", providerJobId: "task1_recraft,task2_bytedance", vendorCostMicros: 9_000,
    });
    expect(output.provenance.providerJobId!.length).toBeLessThanOrEqual(200);
    expect(decodePng(output.background!.bytes)).toMatchObject({ width: W, height: H });
    expect(kie.seen.filter((s) => s.url.startsWith(RESULT_HOST))).toHaveLength(2);
    passesWorkerChecks(SOURCE, output);
  });

  it("upscale_2k: the factor brings the long side to about 2048 and the vendor's PNG is the output", async () => {
    const kie = fakeKie();
    const { port } = adapter(kie.fetcher);
    const output = await port.runPreset(input("upscale_2k"));
    expect(JSON.parse(creates(kie.seen)[0]!.body)).toEqual({ model: "topaz/image-upscale", input: { image_url: UPLOADED_URL, upscale_factor: "4" } });
    expect(output).toMatchObject({ contentType: "image/png", width: 2048, height: 1024, matte: null, background: null, provenance: { modelId: "topaz/image-upscale", providerJobId: "task1_topaz" } });
    expect(output.bytes).toEqual(UPSCALED);
  });

  it("picks sizes from the source", () => {
    expect([upscaleFactor(512, 256), upscaleFactor(1100, 800), upscaleFactor(2048, 10), upscaleFactor(100, 100)]).toEqual([4, 2, 1, 8]);
    expect([backgroundSize(256, 256), backgroundSize(1600, 900), backgroundSize(600, 800)]).toEqual(["square_hd", "landscape_16_9", "portrait_4_3"]);
  });
});

describe("hosts and the key (IM-6, IM-17)", () => {
  it("sends the key in the Authorization header to Kie's API and upload hosts only, never in a URL or body", async () => {
    const kie = fakeKie();
    await adapter(kie.fetcher).port.runPreset(input("studio_background_swap"));
    for (const s of kie.seen) {
      expect(KIE_HOSTS.has(new URL(s.url).hostname)).toBe(true);
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.url).not.toContain(KIE_TEST_KEY);
      expect(s.body).not.toContain(KIE_TEST_KEY);
      const host = new URL(s.url).hostname;
      if (host === "api.kie.ai" || host === "kieai.redpandaai.co") expect(s.headers.authorization).toBe(`Bearer ${KIE_TEST_KEY}`);
      else expect(s.headers.authorization).toBeUndefined();
    }
  });

  it("refuses a redirect, and submits nothing after a redirected upload", async () => {
    const kie = fakeKie({ override: { upload: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }) } });
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(creates(kie.seen)).toHaveLength(0);
  });

  it("refuses a result URL on another host without fetching it", async () => {
    const kie = fakeKie({ resultUrl: () => "https://cdn.elsewhere.example/r.png" });
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(kie.seen.some((s) => s.url.includes("elsewhere"))).toBe(false);
  });

  it("refuses an uploaded file URL on another host before any task", async () => {
    const kie = fakeKie({ override: { upload: () => json(uploadOk("https://files.elsewhere.example/x.png")) } });
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(creates(kie.seen)).toHaveLength(0);
  });

  it("keeps the key out of every error message", async () => {
    const kie = fakeKie({ override: { create: () => json({ code: 401, msg: `bad key ${KIE_TEST_KEY}` }, 401) } });
    const error = await adapter(kie.fetcher).port.runPreset(input("upscale_2k")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageAdapterRefused);
    expect(String((error as Error).message)).not.toContain(KIE_TEST_KEY);
  });
});

describe("failures (IM-7, IM-17)", () => {
  it("a task that fails is ImageAdapterRefused", async () => {
    const kie = fakeKie({ states: { [KIE_MODELS.cutout]: ["generating", "fail"] } });
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
  });

  it("a 4xx on submit, as HTTP status or Kie's body code, is ImageAdapterRefused", async () => {
    for (const create of [() => json({ code: 402, msg: "credits" }, 402), () => json(createRefused)]) {
      const kie = fakeKie({ override: { create } });
      await expect(adapter(kie.fetcher).port.runPreset(input("upscale_2k"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    }
  });

  it("a 5xx or a lost connection on submit is ImageOutcomeUnknown, never resent", async () => {
    for (const create of [() => json({ code: 500, msg: "oops" }, 500), () => { throw new TypeError("socket hang up"); }]) {
      const kie = fakeKie({ override: { create } });
      const error = await adapter(kie.fetcher).port.runPreset(input("upscale_2k")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageOutcomeUnknown);
      expect(creates(kie.seen)).toHaveLength(1);
    }
  });

  it("a poll past the timeout is ImageOutcomeUnknown with the task ID and exactly one submit", async () => {
    const kie = fakeKie({ states: { [KIE_MODELS.cutout]: ["generating"] } });
    const { port, sleeps } = adapter(kie.fetcher, { timeoutMs: 10_000 });
    const error = await port.runPreset(input("background_remove")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageOutcomeUnknown);
    expect((error as ImageOutcomeUnknown).providerJobId).toBe("task1_recraft");
    expect(creates(kie.seen)).toHaveLength(1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("a 5xx while polling keeps polling, then times out as unknown", async () => {
    const broken = fakeKie({ override: { record: () => json({ code: 500 }, 503) } });
    const error = await adapter(broken.fetcher, { timeoutMs: 4_000 }).port.runPreset(input("upscale_2k")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageOutcomeUnknown);
    expect((error as ImageOutcomeUnknown).providerJobId).toBe("task1_topaz");
  });

  it("an unreadable result is ImageAdapterRefused", async () => {
    const kie = fakeKie({ files: { [KIE_MODELS.cutout]: new Uint8Array([1, 2, 3]) } });
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    const off = fakeKie({ override: { record: (s) => json({ code: 200, data: { taskId: new URL(s.url).searchParams.get("taskId"), state: "success", resultJson: "{not json" } }) } });
    await expect(adapter(off.fetcher).port.runPreset(input("upscale_2k"))).rejects.toBeInstanceOf(ImageAdapterRefused);
  });

  it("a cut-out at another size, or a JPEG upscale, is refused", async () => {
    const small = fakeKie({ files: { [KIE_MODELS.cutout]: cutoutPng(W / 2, H / 2) } });
    await expect(adapter(small.fetcher).port.runPreset(input("background_remove"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    const jpeg = fakeKie({ files: { [KIE_MODELS.upscale]: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) } });
    await expect(adapter(jpeg.fetcher).port.runPreset(input("upscale_2k"))).rejects.toBeInstanceOf(ImageAdapterRefused);
  });

  it("a source the cut-out model cannot take is refused before any call", async () => {
    const kie = fakeKie();
    const tiny = encodeRgbaPng(sourceImage(64, 64));
    await expect(adapter(kie.fetcher).port.runPreset(input("background_remove", tiny))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(kie.seen).toHaveLength(0);
  });
});

describe("lookup (IM-18)", () => {
  it("finishes a job that was pending when the poll ran out", async () => {
    const kie = fakeKie({ states: {
      [KIE_MODELS.cutout]: ["generating", "generating", "success"],
      [KIE_MODELS.background]: ["generating", "generating", "generating", "success"],
    } });
    const { port } = adapter(kie.fetcher, { timeoutMs: 2_000 });
    const job = input("studio_background_swap");
    const error = await port.runPreset(job).catch((e: unknown) => e) as ImageOutcomeUnknown;
    expect(error).toBeInstanceOf(ImageOutcomeUnknown);
    expect(error.providerJobId).toBe("task1_recraft,task2_bytedance");
    expect(await port.lookup(error.providerJobId!, job)).toEqual({ state: "pending" });
    const answer = await port.lookup(error.providerJobId!, job);
    expect(answer.state).toBe("done");
    if (answer.state !== "done") return;
    expect(answer.output.provenance.providerJobId).toBe("task1_recraft,task2_bytedance");
    expect(creates(kie.seen)).toHaveLength(2);
    passesWorkerChecks(SOURCE, answer.output);
  });

  it("answers failed for a failed task and for a job ID it cannot read, and makes no submit", async () => {
    const kie = fakeKie({ states: { [KIE_MODELS.upscale]: ["fail"] } });
    const { port } = adapter(kie.fetcher);
    await expect(port.runPreset(input("upscale_2k"))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(await port.lookup("task1_topaz", input("upscale_2k"))).toEqual({ state: "failed" });
    expect(await port.lookup("task1_recraft,", input("studio_background_swap"))).toEqual({ state: "failed" });
    expect(await port.lookup("bad id!", input("upscale_2k"))).toEqual({ state: "failed" });
    expect(creates(kie.seen)).toHaveLength(1);
  });
});

describe("construction and the allowlist (IM-8, IM-19, IM-21)", () => {
  it("a missing key fails at construction", () => {
    const { fetcher } = fakeKie();
    expect(() => createKieImageWorkflowPort({ apiKey: "", fetch: fetcher, clock: { now: () => new Date() }, sleep: async () => {}, vendorCostMicros: COSTS }))
      .toThrow(expect.objectContaining({ code: "ValidationFailed" }));
  });

  it("every Kie model ID is listed, unverified, with no forbidden weights or non-commercial licence", () => {
    const { port } = adapter(fakeKie().fetcher);
    for (const preset of ["background_remove", "studio_background_swap", "upscale_2k"] as const) {
      const modelId = port.modelId(preset);
      const entry = IMAGE_MODEL_ALLOWLIST.find((e) => e.adapter === "kie" && e.modelId === modelId);
      expect(entry, modelId).toBeDefined();
      expect(entry!.verified).toBe(false);
      expect(entry!.license).toMatch(/TODO verify/);
      expect(NON_COMMERCIAL_LICENSE.test(entry!.license)).toBe(false);
      for (const part of modelId.split("+")) expect(isForbiddenModel(part)).toBe(false);
      // IM-19: listed but unverified, so the worker refuses it before any reservation or call.
      expect(findAllowedModel("kie", modelId)).toBeNull();
    }
    for (const entry of IMAGE_MODEL_ALLOWLIST.filter((e) => e.adapter === "kie")) expect(isForbiddenModel(entry.modelId)).toBe(false);
  });
});
