// image-port.md IM-17: the FAL adapter, over FAL's queue API. Every call goes through `vendorFetch`
// (HTTPS, fixed hosts, no redirects). The key goes only in the `Authorization` header and only to the
// queue host; result files are fetched from FAL's media hosts without it. Our code builds the output
// from the vendor's cut-out and background (IM-9, `buildMatteOutput`).
//
// Confirmed from FAL's public queue docs (search summaries, 2026-10-24; docs host not reachable from
// here): submit answers `request_id`, `status_url`, `response_url`, `cancel_url`; status is
// IN_QUEUE / IN_PROGRESS (HTTP 202) then COMPLETED (200); a failed request also reads COMPLETED and
// its error comes from the result fetch, with `error_type` in the body and an `X-Fal-Error-Type`
// header. Everything marked `TODO verify` is from memory of FAL's docs, not checked.
import { MEDIA_LIMITS, ValidationFailed, type ImagePreset } from "@zs/contracts";
import { ImageAdapterRefused, ImageOutcomeUnknown, type ImageWorkflowPort, type LookupResult, type PresetInput, type PresetOutput } from "../port.js";
import {
  BodyTooLarge, buildMatteOutput, buildUpscaleOutput, DEFAULT_POLL_INTERVAL_MS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS,
  readBounded, readJsonObject, requireVendorCosts, vendorFetch, workflowHash, type VendorAdapterOptions,
} from "./shared.js";

export type FalAdapterConfig = VendorAdapterOptions;

const QUEUE_HOST = "queue.fal.run";
/** The only host that gets the key. */
const QUEUE_HOSTS: ReadonlySet<string> = new Set([QUEUE_HOST]);
/** TODO verify: the media CDN hosts FAL names result files on. They never get the key. */
const MEDIA_HOSTS: ReadonlySet<string> = new Set(["fal.media", "v2.fal.media", "v3.fal.media", "v3b.fal.media"]);
export const FAL_HOSTS: ReadonlySet<string> = new Set([...QUEUE_HOSTS, ...MEDIA_HOSTS]);

// IM-8, IM-19: weights whose licence allows commercial use; listed unverified in allowlist.ts.
// TODO verify each model ID and its input fields against FAL's model pages.
const BIREFNET = "fal-ai/birefnet/v2"; // BiRefNet, MIT weights; answers a PNG with alpha.
const FLUX_SCHNELL = "fal-ai/flux/schnell"; // FLUX.1 schnell, Apache-2.0 weights. Never FLUX dev.
const ESRGAN = "fal-ai/esrgan"; // Real-ESRGAN, BSD-3-Clause weights.
/** A swap runs two models; the worker's allowlist check (IM-8) sees both in one name. */
const MODELS: Readonly<Record<ImagePreset, string>> = {
  background_remove: BIREFNET,
  studio_background_swap: `${BIREFNET}+${FLUX_SCHNELL}`,
  upscale_2k: ESRGAN,
};
const UPSCALE_LONG_SIDE = 2048;
/** TODO verify: the `scale` range fal-ai/esrgan accepts. */
const UPSCALE_MAX_SCALE = 8;

/** The fixed request shapes, with `$` for the parts each job fills in (hashed into the workflow hash). */
const SHAPES = {
  matte: { model: BIREFNET, input: { image_url: "$source", output_format: "png" } },
  background: {
    model: FLUX_SCHNELL,
    input: { prompt: "$prompt", image_size: { width: "$width", height: "$height" }, num_images: 1, output_format: "png", enable_safety_checker: true },
  },
  upscale: { model: ESRGAN, input: { image_url: "$source", scale: "$scale", model: "RealESRGAN_x4plus", output_format: "png" } },
} as const;
const PRESET_SHAPES: Readonly<Record<ImagePreset, readonly (keyof typeof SHAPES)[]>> = {
  background_remove: ["matte"],
  studio_background_swap: ["matte", "background"],
  upscale_2k: ["upscale"],
};
const PRESET_CODES: Readonly<Record<ImagePreset, string>> = { background_remove: "rm", studio_background_swap: "sw", upscale_2k: "up" };

interface Step { readonly role: keyof typeof SHAPES; readonly model: string; readonly body: Record<string, unknown> }
interface Job { readonly step: Step; readonly requestId: string; readonly statusUrl: string; readonly responseUrl: string; done: boolean }

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** `fal:<preset>:<id>[.<id>]`, at most 7 + 2 x 80 + 1 characters (under the 200 the column holds). */
const jobIdFor = (preset: ImagePreset, ids: readonly string[]) => `fal:${PRESET_CODES[preset]}:${ids.join(".")}`;
function parseJobId(providerJobId: string): { code: string; ids: string[] } | null {
  const match = /^fal:([a-z]{2}):([A-Za-z0-9_.-]+)$/.exec(providerJobId);
  if (!match) return null;
  const ids = match[2]!.split(".");
  return ids.every((id) => REQUEST_ID.test(id)) ? { code: match[1]!, ids } : null;
}

/** TODO verify: the queue's request paths use the app (owner/name) without the model's subpath. */
const appOf = (model: string) => model.split("/").slice(0, 2).join("/");
const statusUrlFor = (model: string, id: string) => `https://${QUEUE_HOST}/${appOf(model)}/requests/${id}/status`;
const responseUrlFor = (model: string, id: string) => `https://${QUEUE_HOST}/${appOf(model)}/requests/${id}`;

const dataUri = (bytes: Uint8Array, contentType: string) => `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
const promptFor = (input: PresetInput) => `Studio product photo background: ${String(input.params.backgroundDescription ?? "")}`;

function stepsFor(input: PresetInput): Step[] {
  const image = dataUri(input.source.bytes, input.source.contentType);
  return PRESET_SHAPES[input.preset].map((role): Step => {
    if (role === "matte") return { role, model: BIREFNET, body: { ...SHAPES.matte.input, image_url: image } };
    if (role === "background") return {
      role, model: FLUX_SCHNELL,
      // TODO verify: FLUX schnell's size limits; a size it refuses is a 4xx (definite), and a size it
      // rounds is fitted to the source's by buildMatteOutput.
      body: { ...SHAPES.background.input, prompt: promptFor(input), image_size: { width: input.source.width, height: input.source.height } },
    };
    const long = Math.max(input.source.width, input.source.height);
    const scale = Math.min(UPSCALE_MAX_SCALE, Math.max(1, Math.round((UPSCALE_LONG_SIDE / long) * 1000) / 1000));
    return { role, model: ESRGAN, body: { ...SHAPES.upscale.input, image_url: image, scale } };
  });
}

const readJson = readJsonObject;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createFalImageWorkflowPort(config: FalAdapterConfig): ImageWorkflowPort {
  if (!config.apiKey) throw new ValidationFailed("A FAL API key is required");
  requireVendorCosts("FAL", config.vendorCostMicros);
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** A queue call with the key. A refusal by `vendorFetch` (host, redirect) passes through; a lost connection is `null`. */
  async function queue(url: string, init: RequestInit = {}): Promise<Response | null> {
    const headers: Record<string, string> = { Authorization: `Key ${config.apiKey}`, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try { return await vendorFetch(config.fetch, QUEUE_HOSTS, url, { ...init, headers }, requestTimeoutMs); } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      return null;
    }
  }

  /** IM-17: one submit per job. FAL has no idempotency key we know of (TODO verify); the worker never resends. */
  async function submit(step: Step, providerJobId: string | null): Promise<Job> {
    const response = await queue(`https://${QUEUE_HOST}/${step.model}`, { method: "POST", body: JSON.stringify(step.body) });
    if (!response || response.status >= 500) throw new ImageOutcomeUnknown(providerJobId, "The FAL submit's answer is unknown");
    if (response.status < 200 || response.status >= 300) throw new ImageAdapterRefused(`FAL refused the job (HTTP ${response.status})`);
    const body = await readJson(response);
    const requestId = body?.request_id;
    // Accepted but unreadable: the job may be queued and we cannot name it.
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new ImageOutcomeUnknown(providerJobId, "FAL named no request ID");
    // FAL's docs prefer the URLs it returns; vendorFetch holds them to the queue host. Built ones are the fallback.
    return {
      step, requestId, done: false,
      statusUrl: typeof body?.status_url === "string" ? body.status_url : statusUrlFor(step.model, requestId),
      responseUrl: typeof body?.response_url === "string" ? body.response_url : responseUrlFor(step.model, requestId),
    };
  }

  /** One status check: true once COMPLETED. */
  async function completed(job: Job, providerJobId: string): Promise<boolean> {
    const response = await queue(job.statusUrl);
    if (!response || response.status < 200 || response.status >= 300) throw new ImageOutcomeUnknown(providerJobId, "The FAL status is unknown");
    const body = await readJson(response);
    const status = body?.status;
    if (status === "COMPLETED") return true;
    // TODO verify: FAL documents only the three states; any failure word is taken as a definite failure.
    if (status === "ERROR" || status === "FAILED" || status === "CANCELLED") throw new ImageAdapterRefused("FAL reports the job failed");
    return false;
  }

  /** The result JSON of a completed job. A failed job answers its error here (FAL's docs). */
  async function result(job: Job, providerJobId: string): Promise<Record<string, unknown>> {
    const response = await queue(job.responseUrl);
    if (!response) throw new ImageOutcomeUnknown(providerJobId, "The FAL result is unknown");
    const errorType = response.headers.get("x-fal-error-type");
    const body = await readJson(response);
    if (errorType || body?.error_type !== undefined || (response.status >= 400 && response.status < 500))
      throw new ImageAdapterRefused(`FAL reports the job failed (HTTP ${response.status})`);
    if (response.status < 200 || response.status >= 300) throw new ImageOutcomeUnknown(providerJobId, "The FAL result is unknown");
    if (!body) throw new ImageAdapterRefused("The FAL result is unreadable");
    return body;
  }

  /** A result file, from FAL's media hosts, without the key. */
  async function download(url: unknown, providerJobId: string): Promise<Uint8Array> {
    if (typeof url !== "string") throw new ImageAdapterRefused("The FAL result names no file");
    let response: Response;
    try { response = await vendorFetch(config.fetch, MEDIA_HOSTS, url, { method: "GET" }, requestTimeoutMs); } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      throw new ImageOutcomeUnknown(providerJobId, "The FAL file download was lost");
    }
    if (response.status >= 500) throw new ImageOutcomeUnknown(providerJobId, "The FAL file download failed");
    if (response.status < 200 || response.status >= 300) throw new ImageAdapterRefused(`The FAL file is unavailable (HTTP ${response.status})`);
    let bytes: Uint8Array;
    try { bytes = await readBounded(response, MEDIA_LIMITS.fileBytes); } catch (error) {
      if (error instanceof BodyTooLarge) throw new ImageAdapterRefused("The FAL file has a bad size");
      throw new ImageOutcomeUnknown(providerJobId, "The FAL file download was lost");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMITS.fileBytes) throw new ImageAdapterRefused("The FAL file has a bad size");
    return bytes;
  }

  /**
   * TODO verify the result shapes: BiRefNet and ESRGAN answer `{image: {url, ...}}`, FLUX schnell
   * `{images: [{url, ...}], ...}`.
   */
  async function fileOf(job: Job, providerJobId: string): Promise<Uint8Array> {
    const body = await result(job, providerJobId);
    const file = job.step.role === "background" ? (Array.isArray(body.images) ? body.images[0] : undefined) : body.image;
    return download(isObject(file) ? file.url : undefined, providerJobId);
  }

  async function finish(input: PresetInput, jobs: readonly Job[], providerJobId: string): Promise<PresetOutput> {
    const provenance = {
      adapter: "fal" as const,
      modelId: MODELS[input.preset],
      workflowHash: workflowHash("fal", input.preset, PRESET_SHAPES[input.preset].map((role) => SHAPES[role])),
      promptText: input.preset === "studio_background_swap" ? promptFor(input) : null,
      providerJobId,
      vendorCostMicros: config.vendorCostMicros[input.preset],
    };
    const files = new Map<string, Uint8Array>();
    for (const job of jobs) files.set(job.step.role, await fileOf(job, providerJobId));
    if (input.preset === "upscale_2k") return buildUpscaleOutput(files.get("upscale")!, provenance);
    return buildMatteOutput(input, files.get("matte")!, files.get("background") ?? null, provenance);
  }

  return {
    adapter: "fal",
    modelId: (preset) => MODELS[preset],

    async runPreset(input) {
      const steps = stepsFor(input);
      const jobs: Job[] = [];
      // A swap's second submit that is refused leaves the first job billed and unused: we absorb that
      // cost. One whose answer is lost is unknown with the first ID only, and its hold is kept (IM-7).
      for (const step of steps) jobs.push(await submit(step, jobs.length ? jobIdFor(input.preset, jobs.map((job) => job.requestId)) : null));
      const providerJobId = jobIdFor(input.preset, jobs.map((job) => job.requestId));
      const deadline = config.clock.now().getTime() + timeoutMs;
      for (;;) {
        for (const job of jobs) if (!job.done) job.done = await completed(job, providerJobId);
        if (jobs.every((job) => job.done)) break;
        if (config.clock.now().getTime() >= deadline) throw new ImageOutcomeUnknown(providerJobId, "The FAL job did not finish in time");
        await config.sleep(pollIntervalMs);
      }
      return finish(input, jobs, providerJobId);
    },

    /** IM-18: one status check per job; a finished job's output is rebuilt from the input. */
    async lookup(providerJobId, input): Promise<LookupResult> {
      const parsed = parseJobId(providerJobId);
      const roles = PRESET_SHAPES[input.preset];
      // A swap whose second submit was lost names one job, and an ID this adapter did not write (the
      // adapter changed since) names none: neither has an answer here, so it stays pending and the
      // variant ends `outcome_unknown` with its hold kept for an operator (IM-7).
      if (!parsed || parsed.code !== PRESET_CODES[input.preset] || parsed.ids.length !== roles.length) return { state: "pending" };
      const jobs: Job[] = roles.map((role, index) => {
        const model = SHAPES[role].model;
        const requestId = parsed.ids[index]!;
        return { step: { role, model, body: {} }, requestId, statusUrl: statusUrlFor(model, requestId), responseUrl: responseUrlFor(model, requestId), done: false };
      });
      try {
        for (const job of jobs) if (!(await completed(job, providerJobId))) return { state: "pending" };
        return { state: "done", output: await finish(input, jobs, providerJobId) };
      } catch (error) {
        if (error instanceof ImageAdapterRefused) return { state: "failed" };
        if (error instanceof ImageOutcomeUnknown) return { state: "pending" };
        throw error;
      }
    },
  };
}
