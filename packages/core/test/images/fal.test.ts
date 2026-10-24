// image-port.md IM-17..IM-19, second slice acceptance test 2: the FAL adapter against handwritten
// fixtures (fal.fixtures.ts) and an injected fetch. Nothing here reaches the network or FAL.
import { ValidationFailed, type ImagePreset } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import {
  createFalImageWorkflowPort, FAL_HOSTS, findAllowedModel, IMAGE_MODEL_ALLOWLIST, ImageAdapterRefused, ImageOutcomeUnknown,
  isForbiddenModel, NON_COMMERCIAL_LICENSE, sha256Hex, type PresetInput, type PresetOutput,
} from "../../src/index.js";
import { checkMatte, checkProductPixels, composite, effectiveAlpha } from "../../src/images/compose.js";
import { decodePng, encodeRgbaPng, readImageInfo, type RgbaImage } from "../../src/images/png.js";
import {
  cutout, errorResult, FAL_KEY, flat, imageResult, imagesResult, json, MEDIA, photo, png, QUEUE, router, statusBody, submitBody, type Seen,
} from "./fal.fixtures.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const VARIANT = "66666666-7777-4888-9999-000000000001";
const COSTS: Record<ImagePreset, number> = { background_remove: 3_000, studio_background_swap: 9_000, upscale_2k: 5_000 };
const MATTE_ID = "4b0e5f8a-1c2d-4e3f-9a8b-7c6d5e4f3a21";
const BG_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const UP_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

type Status = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
type Route = (seen: Seen) => Response | Promise<Response>;

/** One queue job's routes. `statuses` is answered in order, the last one repeating. */
function job(model: string, id: string, file: { name: string; bytes: Uint8Array; width: number; height: number; many?: boolean }) {
  const app = model.split("/").slice(0, 2).join("/");
  const url = `${MEDIA}/${file.name}`;
  const state: { statuses: Status[]; result: () => Response; submit: () => Response } = {
    statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"],
    result: () => json(file.many ? imagesResult(url, file.width, file.height) : imageResult(url, file.width, file.height)),
    submit: () => json(submitBody(app, id)),
  };
  const routes: Record<string, Route> = {
    [`POST ${QUEUE}/${model}`]: () => state.submit(),
    [`GET ${QUEUE}/${app}/requests/${id}/status`]: () => {
      const status = state.statuses.length > 1 ? state.statuses.shift()! : state.statuses[0]!;
      return json(statusBody(status, id, app), status === "COMPLETED" ? 200 : 202);
    },
    [`GET ${QUEUE}/${app}/requests/${id}`]: () => state.result(),
    [`GET ${url}`]: () => png(file.bytes),
  };
  return { routes, state, url };
}

function harness(routes: Record<string, Route>, extra: { requestTimeoutMs?: number } = {}) {
  let now = Date.parse("2026-10-24T10:00:00.000Z");
  const sleeps: number[] = [];
  const { seen, fetcher } = router(routes);
  const port = createFalImageWorkflowPort({
    apiKey: FAL_KEY, fetch: fetcher, clock: { now: () => new Date(now) },
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    vendorCostMicros: COSTS, pollIntervalMs: 1_000, timeoutMs: 5_000, ...extra,
  });
  return { port, seen, sleeps, posts: () => seen.filter((entry) => entry.method === "POST") };
}

function inputFor(preset: ImagePreset, image: RgbaImage, params: Record<string, unknown> = {}): PresetInput {
  const bytes = encodeRgbaPng(image);
  return {
    tenantId: TENANT, variantId: VARIANT, preset, params, idempotencyKey: VARIANT,
    source: { bytes, contentType: "image/png", sha256: sha256Hex(bytes), width: image.width, height: image.height },
  };
}

/** The worker's own IM-9 checks pass on the adapter's output. */
function expectWorkerAccepts(input: PresetInput, output: PresetOutput) {
  expect(sha256Hex(output.bytes)).toBe(output.sha256);
  expect(sha256Hex(output.matte!.bytes)).toBe(output.matte!.sha256);
  const source = decodePng(input.source.bytes);
  const matte = checkMatte(output.matte!.bytes, source);
  expect(matte.ok).toBe(true);
  if (!matte.ok) return;
  const background = output.background ? decodePng(output.background.bytes) : null;
  if (background) expect([background.width, background.height]).toEqual([source.width, source.height]);
  const expected = composite(source, matte.alpha, background);
  expect(checkProductPixels(expected, effectiveAlpha(source, matte.alpha), decodePng(output.bytes))).toEqual({ ok: true });
}

/** IM-17: the key travels only in the queue host's Authorization header. */
function expectKeyInHeaderOnly(seen: readonly Seen[]) {
  expect(seen.length).toBeGreaterThan(0);
  for (const entry of seen) {
    expect(entry.url).not.toContain(FAL_KEY);
    expect(JSON.stringify(entry.body ?? null)).not.toContain(FAL_KEY);
    const host = new URL(entry.url).hostname;
    expect(FAL_HOSTS.has(host)).toBe(true);
    if (host === "queue.fal.run") expect(entry.headers.authorization).toBe(`Key ${FAL_KEY}`);
    else expect(entry.headers.authorization).toBeUndefined();
  }
}

const source = photo(32, 32);
const matteJob = () => job("fal-ai/birefnet/v2", MATTE_ID, { name: "cutout-1.png", bytes: cutout(source), width: 32, height: 32 });

describe("FAL presets end to end (IM-17, acceptance 2)", () => {
  it("background_remove: one BiRefNet job, polled, cut-out fetched, our composite out", async () => {
    const matte = matteJob();
    const { port, seen, sleeps, posts } = harness(matte.routes);
    const input = inputFor("background_remove", source);
    const output = await port.runPreset(input);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe("https://queue.fal.run/fal-ai/birefnet/v2");
    expect(posts()[0]!.body).toEqual({ image_url: `data:image/png;base64,${Buffer.from(input.source.bytes).toString("base64")}`, output_format: "png" });
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(output).toMatchObject({ contentType: "image/png", width: 32, height: 32, background: null });
    expect(output.provenance).toEqual({
      adapter: "fal", modelId: "fal-ai/birefnet/v2", workflowHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      promptText: null, providerJobId: `fal:rm:${MATTE_ID}`, vendorCostMicros: 3_000,
    });
    expect(port.modelId("background_remove")).toBe(output.provenance.modelId);
    expectWorkerAccepts(input, output);
    expectKeyInHeaderOnly(seen);
    expect(seen.filter((entry) => entry.url === matte.url)).toHaveLength(1);
  });

  it("studio_background_swap: a cut-out and a FLUX schnell background from the fixed prompt, both ids recorded", async () => {
    const matte = matteJob();
    // The vendor answers a larger background; it is fitted to the source's size.
    const bg = job("fal-ai/flux/schnell", BG_ID, { name: "bg-1.png", bytes: flat(64, 48, [200, 190, 180]), width: 64, height: 48, many: true });
    const { port, seen, posts } = harness({ ...matte.routes, ...bg.routes });
    const input = inputFor("studio_background_swap", source, { backgroundDescription: "warm grey linen" });
    const output = await port.runPreset(input);

    expect(posts().map((entry) => entry.url)).toEqual(["https://queue.fal.run/fal-ai/birefnet/v2", "https://queue.fal.run/fal-ai/flux/schnell"]);
    expect(posts()[1]!.body).toEqual({
      prompt: "Studio product photo background: warm grey linen", image_size: { width: 32, height: 32 },
      num_images: 1, output_format: "png", enable_safety_checker: true,
    });
    expect(output.provenance).toMatchObject({
      adapter: "fal", modelId: "fal-ai/birefnet/v2+fal-ai/flux/schnell", promptText: "Studio product photo background: warm grey linen",
      providerJobId: `fal:sw:${MATTE_ID}.${BG_ID}`, vendorCostMicros: 9_000,
    });
    expect(output.provenance.providerJobId!.length).toBeLessThanOrEqual(200);
    expect(output.background).not.toBeNull();
    expectWorkerAccepts(input, output);
    expectKeyInHeaderOnly(seen);
  });

  it("upscale_2k: ESRGAN to a 2048 px long side; the vendor's PNG is the output", async () => {
    const wide = photo(512, 256);
    const upscaled = flat(2048, 1024, [10, 20, 30]);
    const up = job("fal-ai/esrgan", UP_ID, { name: "up-1.png", bytes: upscaled, width: 2048, height: 1024 });
    const { port, seen, posts } = harness(up.routes);
    const output = await port.runPreset(inputFor("upscale_2k", wide));

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ scale: 4, model: "RealESRGAN_x4plus", output_format: "png" });
    expect(output).toMatchObject({ contentType: "image/png", width: 2048, height: 1024, matte: null, background: null });
    expect(output.bytes).toEqual(upscaled);
    expect(output.provenance).toMatchObject({ modelId: "fal-ai/esrgan", providerJobId: `fal:up:${UP_ID}`, vendorCostMicros: 5_000 });
    expectKeyInHeaderOnly(seen);
  });

  it("upscale_2k caps the scale for a tiny source", async () => {
    const up = job("fal-ai/esrgan", UP_ID, { name: "up-2.png", bytes: flat(800, 400, [1, 2, 3]), width: 800, height: 400 });
    up.state.statuses = ["COMPLETED"];
    const { port, posts } = harness(up.routes);
    await port.runPreset(inputFor("upscale_2k", photo(100, 50)));
    expect(posts()[0]!.body).toMatchObject({ scale: 8 });
  });
});

describe("hosts, redirects and refusals (IM-6, IM-17)", () => {
  it("refuses a redirect on submit and on a status poll", async () => {
    const matte = matteJob();
    matte.state.submit = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    await expect(harness(matte.routes).port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);

    const again = matteJob();
    const routes = { ...again.routes, [`GET ${QUEUE}/fal-ai/birefnet/requests/${MATTE_ID}/status`]: () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }) };
    await expect(harness(routes).port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);
  });

  it("refuses a result file on another host, or over plain HTTP, without fetching it", async () => {
    for (const url of ["https://elsewhere.example/files/cutout.png", "http://v3.fal.media/files/cutout.png", "data:image/png;base64,AAAA"]) {
      const matte = matteJob();
      matte.state.result = () => json(imageResult(url, 32, 32));
      const { port, seen } = harness(matte.routes);
      await expect(port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);
      expect(seen.some((entry) => entry.url.startsWith(url.slice(0, 20)))).toBe(false);
    }
  });

  it("refuses a status URL on another host, so the key never leaves the queue host", async () => {
    const matte = matteJob();
    matte.state.submit = () => json({ ...submitBody("fal-ai/birefnet", MATTE_ID), status_url: `https://collector.example/requests/${MATTE_ID}/status` });
    const { port, seen } = harness(matte.routes);
    await expect(port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expectKeyInHeaderOnly(seen);
  });

  it("a 4xx on submit, a failed result and an error-typed result are ImageAdapterRefused, with no key in the message", async () => {
    const cases: Array<(matte: ReturnType<typeof matteJob>) => void> = [
      (matte) => { matte.state.submit = () => json({ detail: "our own refusal" }, 422); },
      (matte) => { matte.state.result = () => json(errorResult, 422); },
      (matte) => { matte.state.result = () => json({ detail: "runner gone" }, 500, { "x-fal-error-type": "runner_disconnected" }); },
    ];
    for (const arrange of cases) {
      const matte = matteJob();
      arrange(matte);
      const { port, posts } = harness(matte.routes);
      const error = await port.runPreset(inputFor("background_remove", source)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageAdapterRefused);
      expect(String((error as Error).message)).not.toContain(FAL_KEY);
      expect(posts()).toHaveLength(1);
    }
  });

  it("refuses a cut-out that changed size", async () => {
    const matte = job("fal-ai/birefnet/v2", MATTE_ID, { name: "cutout-2.png", bytes: cutout(source, { width: 16, height: 16 }), width: 16, height: 16 });
    await expect(harness(matte.routes).port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);
  });
});

describe("unknown outcomes and lookup (IM-7, IM-17, IM-18)", () => {
  it("a poll past the timeout is ImageOutcomeUnknown with the job id, after exactly one submit", async () => {
    const matte = matteJob();
    matte.state.statuses = ["IN_QUEUE"];
    const { port, posts, sleeps } = harness(matte.routes);
    const error = await port.runPreset(inputFor("background_remove", source)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageOutcomeUnknown);
    expect((error as ImageOutcomeUnknown).providerJobId).toBe(`fal:rm:${MATTE_ID}`);
    expect(posts()).toHaveLength(1);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
  });

  it("a 5xx or lost connection after submit is ImageOutcomeUnknown; a lost submit has no id", async () => {
    const matte = matteJob();
    const routes = { ...matte.routes, [`GET ${QUEUE}/fal-ai/birefnet/requests/${MATTE_ID}/status`]: () => json({ detail: "busy" }, 503) };
    const first = harness(routes);
    await expect(first.port.runPreset(inputFor("background_remove", source))).rejects.toMatchObject({ name: "ImageOutcomeUnknown", providerJobId: `fal:rm:${MATTE_ID}` });
    expect(first.posts()).toHaveLength(1);

    const lost = matteJob();
    lost.state.submit = () => { throw new TypeError("socket hang up"); };
    const second = harness(lost.routes);
    await expect(second.port.runPreset(inputFor("background_remove", source))).rejects.toMatchObject({ name: "ImageOutcomeUnknown", providerJobId: null });
    expect(second.posts()).toHaveLength(1);
  });

  it("lookup finishes a swap that was pending, from the job's input, without a second submit", async () => {
    const matte = matteJob();
    const bg = job("fal-ai/flux/schnell", BG_ID, { name: "bg-2.png", bytes: flat(32, 32, [90, 80, 70]), width: 32, height: 32, many: true });
    bg.state.statuses = ["IN_PROGRESS"];
    const { port, seen, posts } = harness({ ...matte.routes, ...bg.routes });
    const input = inputFor("studio_background_swap", source, { backgroundDescription: "slate" });
    const error = await port.runPreset(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageOutcomeUnknown);
    const providerJobId = (error as ImageOutcomeUnknown).providerJobId!;
    expect(providerJobId).toBe(`fal:sw:${MATTE_ID}.${BG_ID}`);

    expect(await port.lookup(providerJobId, input)).toEqual({ state: "pending" });
    bg.state.statuses = ["COMPLETED"];
    const answer = await port.lookup(providerJobId, input);
    expect(answer.state).toBe("done");
    if (answer.state !== "done") return;
    expect(answer.output.provenance).toMatchObject({ adapter: "fal", providerJobId, promptText: "Studio product photo background: slate" });
    expectWorkerAccepts(input, answer.output);
    expect(posts()).toHaveLength(2);
    expectKeyInHeaderOnly(seen);
  });

  it("lookup answers failed for a failed job, and pending for a foreign or partial id or another preset", async () => {
    const matte = matteJob();
    matte.state.statuses = ["COMPLETED"];
    matte.state.result = () => json(errorResult, 422);
    const { port, posts } = harness(matte.routes);
    const input = inputFor("background_remove", source);
    expect(await port.lookup(`fal:rm:${MATTE_ID}`, input)).toEqual({ state: "failed" });
    // IM-7: an unknown outcome keeps its hold. An ID this adapter cannot finish is no answer.
    expect(await port.lookup(`fal:sw:${MATTE_ID}`, inputFor("studio_background_swap", source, { backgroundDescription: "x" }))).toEqual({ state: "pending" });
    expect(await port.lookup(`fal:up:${MATTE_ID}`, input)).toEqual({ state: "pending" });
    expect(await port.lookup("task1_recraft", input)).toEqual({ state: "pending" });
    expect(await port.lookup("fal:rm:../../x", input)).toEqual({ state: "pending" });
    expect(posts()).toHaveLength(0);
  });

  it("a swap whose background submit answers 5xx is unknown with the cut-out ID only, and lookup keeps it pending", async () => {
    const matte = matteJob();
    const bg = job("fal-ai/flux/schnell", BG_ID, { name: "bg-9.png", bytes: flat(32, 32, [1, 2, 3]), width: 32, height: 32, many: true });
    bg.state.submit = () => json({ detail: "busy" }, 503);
    const { port, posts } = harness({ ...matte.routes, ...bg.routes });
    const input = inputFor("studio_background_swap", source, { backgroundDescription: "slate" });
    const error = await port.runPreset(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "ImageOutcomeUnknown", providerJobId: `fal:sw:${MATTE_ID}` });
    expect(await port.lookup(`fal:sw:${MATTE_ID}`, input)).toEqual({ state: "pending" });
    expect(posts()).toHaveLength(2);
  });

  it("a stalled status poll is aborted after the request timeout and read as unknown", async () => {
    const matte = matteJob();
    const routes: Record<string, Route> = {
      ...matte.routes,
      [`GET ${QUEUE}/fal-ai/birefnet/requests/${MATTE_ID}/status`]: (seen) => new Promise<Response>((_, reject) => {
        seen.signal?.addEventListener("abort", () => reject(seen.signal!.reason));
      }),
    };
    const { port, posts } = harness(routes, { requestTimeoutMs: 20 });
    await expect(port.runPreset(inputFor("background_remove", source))).rejects.toMatchObject({ name: "ImageOutcomeUnknown", providerJobId: `fal:rm:${MATTE_ID}` });
    expect(posts()).toHaveLength(1);
  });

  it("a result file over the size limit is refused without reading all of it", async () => {
    let pulls = 0;
    const matte = matteJob();
    matte.routes[`GET ${matte.url}`] = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024 * 1024)); },
    }), { status: 200, headers: { "content-type": "image/png" } });
    await expect(harness(matte.routes).port.runPreset(inputFor("background_remove", source))).rejects.toBeInstanceOf(ImageAdapterRefused);
    expect(pulls).toBeLessThanOrEqual(13);
  });

  it("lookup of a finished upscale returns the vendor's file", async () => {
    const upscaled = flat(2048, 1024, [4, 5, 6]);
    const up = job("fal-ai/esrgan", UP_ID, { name: "up-3.png", bytes: upscaled, width: 2048, height: 1024 });
    up.state.statuses = ["COMPLETED"];
    const answer = await harness(up.routes).port.lookup(`fal:up:${UP_ID}`, inputFor("upscale_2k", photo(512, 256)));
    expect(answer.state).toBe("done");
    if (answer.state === "done") expect(readImageInfo(answer.output.bytes)).toEqual({ contentType: "image/png", width: 2048, height: 1024 });
  });
});

describe("config and models (IM-8, IM-19, IM-21)", () => {
  it("a missing key fails at construction", () => {
    const { fetcher } = router({});
    expect(() => createFalImageWorkflowPort({
      apiKey: "", fetch: fetcher, clock: { now: () => new Date() }, sleep: async () => {}, vendorCostMicros: COSTS,
    })).toThrow(ValidationFailed);
  });

  it("missing, partial or negative vendor costs fail at construction (IM-20)", () => {
    const { fetcher } = router({});
    for (const costs of [{}, { background_remove: 1, studio_background_swap: 2 }, { ...COSTS, upscale_2k: -1 }]) {
      expect(() => createFalImageWorkflowPort({
        apiKey: FAL_KEY, fetch: fetcher, clock: { now: () => new Date() }, sleep: async () => {}, vendorCostMicros: costs as typeof COSTS,
      })).toThrow(ValidationFailed);
    }
  });

  it("every model the adapter names is on the allowlist, unverified, commercial-safe; no stray FAL entries", () => {
    const { port } = harness({});
    const named = (["background_remove", "studio_background_swap", "upscale_2k"] as const).map((preset) => port.modelId(preset));
    for (const modelId of named) {
      const entry = IMAGE_MODEL_ALLOWLIST.find((candidate) => candidate.adapter === "fal" && candidate.modelId === modelId);
      expect(entry, modelId).toBeDefined();
      expect(entry!.verified).toBe(false);
      expect(entry!.license).toMatch(/TODO verify/);
      expect(NON_COMMERCIAL_LICENSE.test(entry!.license)).toBe(false);
      expect(isForbiddenModel(modelId)).toBe(false);
      expect(modelId).not.toMatch(/dev|rmbg/i);
      // IM-19: unverified, so the worker refuses it before any reservation or call.
      expect(findAllowedModel("fal", modelId)).toBeNull();
    }
    expect(IMAGE_MODEL_ALLOWLIST.filter((entry) => entry.adapter === "fal").map((entry) => entry.modelId).sort()).toEqual([...named].sort());
  });

  it("the host list is FAL's queue and media hosts, HTTPS names only", () => {
    expect(FAL_HOSTS.has("queue.fal.run")).toBe(true);
    for (const host of FAL_HOSTS) expect(host).toMatch(/(^|\.)fal\.(run|media)$/);
  });
});
