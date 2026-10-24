// The Kie.ai adapter (image-port.md IM-17). Kie's market API is task based: upload the source by
// base64 to get a URL, create a task with a model and its input, poll the task record, then fetch
// the result file once from Kie's temporary file host. Every request goes through `vendorFetch`
// (IM-6). The key goes to the API and upload hosts in the Authorization header only, never to the
// result hosts, and never into a URL or an error message.
//
// TODO verify: docs.kie.ai could not be reached from the build machine (2026-10-24). Paths, field
// names, model IDs, input fields and hosts below follow Kie's public docs as generally described and
// third-party search summaries; each unconfirmed detail is marked `TODO verify`.
import { ValidationFailed, type ImagePreset } from "@zs/contracts";
import { decodePng, readImageInfo } from "../png.js";
import {
  ImageAdapterRefused, ImageOutcomeUnknown,
  type ImageWorkflowPort, type LookupResult, type PresetInput, type PresetOutput,
} from "../port.js";
import {
  buildMatteOutput, buildUpscaleOutput, DEFAULT_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS, vendorFetch, workflowHash,
  type Provenance, type VendorAdapterOptions,
} from "./shared.js";

export type KieAdapterConfig = VendorAdapterOptions;

/** TODO verify: the API host is confirmed by search summaries; the upload and file hosts are not. */
export const KIE_API_HOST = "api.kie.ai";
export const KIE_UPLOAD_HOST = "kieai.redpandaai.co"; // TODO verify: base64 upload host.
export const KIE_HOSTS: ReadonlySet<string> = new Set<string>([
  KIE_API_HOST,
  KIE_UPLOAD_HOST,
  "tempfile.redpandaai.co", // TODO verify: where uploaded files are served.
  "tempfile.aiquickdraw.com", // TODO verify: where task results are served.
]);

const CREATE_TASK = `https://${KIE_API_HOST}/api/v1/jobs/createTask`;
const RECORD_INFO = `https://${KIE_API_HOST}/api/v1/jobs/recordInfo`;
const UPLOAD_BASE64 = `https://${KIE_UPLOAD_HOST}/api/file-base64-upload`; // TODO verify path.

/** TODO verify each ID on Kie's market pages; all are listed unverified in allowlist.ts (IM-19). */
export const KIE_MODELS = Object.freeze({
  cutout: "recraft/remove-background",
  background: "bytedance/seedream-v4-text-to-image",
  upscale: "topaz/image-upscale",
});
/** The swap runs two models; the allowlist names the pair, so both are checked before any call. */
const SWAP_MODEL_ID = `${KIE_MODELS.cutout}+${KIE_MODELS.background}`;
const PRESET_MODELS: Readonly<Record<ImagePreset, string>> = {
  background_remove: KIE_MODELS.cutout,
  studio_background_swap: SWAP_MODEL_ID,
  upscale_2k: KIE_MODELS.upscale,
};

/** TODO verify: the cut-out model's documented input limits (256 to 4096 px a side). Checked before any upload. */
const CUTOUT_MIN_SIDE = 256;
const CUTOUT_MAX_SIDE = 4096;
/** TODO verify: the upscaler's allowed factors and their string form. */
const UPSCALE_FACTORS = [1, 2, 4, 8] as const;
const UPSCALE_TARGET = 2048;
/** TODO verify: the background model's `image_size` presets and their aspect ratios. */
const BACKGROUND_SIZES: readonly (readonly [string, number])[] = [
  ["square_hd", 1], ["portrait_4_3", 3 / 4], ["portrait_16_9", 9 / 16], ["landscape_4_3", 4 / 3], ["landscape_16_9", 16 / 9],
];

const TASK_ID = /^[A-Za-z0-9_-]{1,96}$/;
/** The swap's provider job ID: `<cut-out task>,<background task>` (at most 193 characters). */
const SEPARATOR = ",";

/** Smallest allowed factor that brings the long side to about 2048 px. */
export function upscaleFactor(width: number, height: number): number {
  const long = Math.max(width, height);
  return UPSCALE_FACTORS.find((factor) => long * factor >= UPSCALE_TARGET) ?? UPSCALE_FACTORS[UPSCALE_FACTORS.length - 1]!;
}

/** The background preset closest to the source's aspect ratio; `fitBackground` makes up the rest. */
export function backgroundSize(width: number, height: number): string {
  const ratio = width / height;
  let best = BACKGROUND_SIZES[0]!;
  for (const size of BACKGROUND_SIZES) if (Math.abs(Math.log(size[1] / ratio)) < Math.abs(Math.log(best[1] / ratio))) best = size;
  return best[0];
}

const prompt = (input: PresetInput): string | null => input.preset === "studio_background_swap"
  ? `Studio product photo background: ${String(input.params.backgroundDescription ?? "")}` : null;

/** The fixed request shape per preset, for the workflow hash (IM-5). */
const SHAPES: Readonly<Record<ImagePreset, unknown>> = {
  background_remove: { v: 1, tasks: [{ model: KIE_MODELS.cutout, input: ["image"] }] },
  studio_background_swap: {
    v: 1,
    tasks: [
      { model: KIE_MODELS.cutout, input: ["image"] },
      { model: KIE_MODELS.background, input: ["prompt", "image_size", "image_resolution:1K", "max_images:1"] },
    ],
  },
  upscale_2k: { v: 1, tasks: [{ model: KIE_MODELS.upscale, input: ["image_url", "upscale_factor"] }], target: UPSCALE_TARGET },
};

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
async function readJson(response: Response): Promise<JsonObject | null> {
  try { const body: unknown = await response.json(); return isObject(body) ? body : null; } catch { return null; }
}
/** Kie answers HTTP 200 with its own `code`; either one in 4xx is a definite refusal. TODO verify the code list. */
const bodyCode = (body: JsonObject | null): number | null => (body && typeof body.code === "number" ? body.code : null);

type TaskState = { readonly state: "pending" } | { readonly state: "failed" } | { readonly state: "success"; readonly url: string } | { readonly state: "unreadable" };

export function createKieImageWorkflowPort(config: KieAdapterConfig): ImageWorkflowPort {
  if (!config.apiKey) throw new ValidationFailed("A Kie.ai API key is required");
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authed = { authorization: `Bearer ${config.apiKey}`, accept: "application/json" };
  const send = (url: string, init: RequestInit) => vendorFetch(config.fetch, KIE_HOSTS, url, init);

  /** Before any task exists: every failure is definite, since nothing ran or was billed. */
  async function upload(input: PresetInput): Promise<string> {
    const base64Data = `data:${input.source.contentType};base64,${Buffer.from(input.source.bytes).toString("base64")}`;
    let response: Response;
    try {
      response = await send(UPLOAD_BASE64, {
        method: "POST", headers: { ...authed, "content-type": "application/json" },
        // TODO verify: field names. The file is named after the variant only; no tenant data leaves.
        body: JSON.stringify({ base64Data, uploadPath: "zs-images", fileName: `${input.variantId}.${input.source.contentType.split("/")[1]}` }),
      });
    } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      throw new ImageAdapterRefused("The Kie.ai upload could not be reached");
    }
    const body = await readJson(response);
    const data = isObject(body?.data) ? body.data : null;
    const url = typeof data?.downloadUrl === "string" ? data.downloadUrl : null; // TODO verify: `data.downloadUrl`.
    if (!response.ok || (bodyCode(body) ?? 200) !== 200 || !url) throw new ImageAdapterRefused(`The Kie.ai upload failed (http_${response.status})`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ImageAdapterRefused("The Kie.ai upload named an invalid URL"); }
    if (parsed.protocol !== "https:" || !KIE_HOSTS.has(parsed.hostname)) throw new ImageAdapterRefused("The Kie.ai upload named a host outside its list");
    return parsed.toString();
  }

  /**
   * One createTask call, never repeated. Kie documents no idempotency key for tasks (TODO verify),
   * so the worker's rule that an unknown outcome is never resent is what keeps it to one run.
   */
  async function submit(model: string, taskInput: JsonObject, known: string | null): Promise<string> {
    const unknown = (): never => { throw new ImageOutcomeUnknown(known, "The Kie.ai task's answer is unknown"); };
    let response: Response;
    try {
      response = await send(CREATE_TASK, { method: "POST", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify({ model, input: taskInput }) });
    } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      return unknown();
    }
    const body = await readJson(response);
    const code = bodyCode(body);
    if ((response.status >= 400 && response.status < 500) || (code !== null && code >= 400 && code < 500))
      throw new ImageAdapterRefused(`Kie.ai refused the task (http_${response.status}, code_${code ?? "none"})`);
    if (!response.ok || (code !== null && code !== 200)) return unknown();
    const data = isObject(body?.data) ? body.data : null;
    const taskId = typeof data?.taskId === "string" ? data.taskId : "";
    // A 200 without a readable task ID may still have created a task.
    if (!TASK_ID.test(taskId)) return unknown();
    return taskId;
  }

  /** One status read. Anything we cannot read is `pending`: the task exists and may still finish. */
  async function status(taskId: string): Promise<TaskState> {
    let response: Response;
    try {
      response = await send(`${RECORD_INFO}?taskId=${encodeURIComponent(taskId)}`, { method: "GET", headers: authed });
    } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      return { state: "pending" };
    }
    const body = await readJson(response);
    if (!response.ok || bodyCode(body) !== 200) return { state: "pending" };
    const data = isObject(body?.data) ? body.data : null;
    const state = typeof data?.state === "string" ? data.state : "";
    if (state === "fail") return { state: "failed" };
    if (state !== "success") return { state: "pending" }; // waiting, queuing, generating. TODO verify the list.
    // TODO verify: `resultJson` is a JSON string `{"resultUrls": [...]}`.
    let result: unknown;
    try { result = JSON.parse(String(data?.resultJson)); } catch { return { state: "unreadable" }; }
    const urls = isObject(result) && Array.isArray(result.resultUrls) ? result.resultUrls : [];
    return typeof urls[0] === "string" ? { state: "success", url: urls[0] } : { state: "unreadable" };
  }

  /** Fetched once, without the key. A host outside the list is refused by `vendorFetch`. */
  async function download(url: string): Promise<Uint8Array | null> {
    let response: Response;
    try { response = await send(url, { method: "GET" }); } catch (error) {
      if (error instanceof ImageAdapterRefused) throw error;
      return null;
    }
    if (!response.ok) return null;
    try { return new Uint8Array(await response.arrayBuffer()); } catch { return null; }
  }

  const provenance = (input: PresetInput, providerJobId: string): Provenance => ({
    adapter: "kie", modelId: PRESET_MODELS[input.preset], workflowHash: workflowHash("kie", input.preset, SHAPES[input.preset]),
    promptText: prompt(input), providerJobId, vendorCostMicros: config.vendorCostMicros[input.preset],
  });

  const taskIds = (providerJobId: string, preset: ImagePreset): string[] | null => {
    const ids = providerJobId.split(SEPARATOR);
    const want = preset === "studio_background_swap" ? 2 : 1;
    return ids.length === want && ids.every((id) => TASK_ID.test(id)) ? ids : null;
  };

  /** Reads every task once. Done only when all succeeded and every file arrived. */
  async function settle(input: PresetInput, providerJobId: string, ids: readonly string[]): Promise<LookupResult> {
    const states = [];
    for (const id of ids) states.push(await status(id));
    if (states.some((s) => s.state === "failed" || s.state === "unreadable")) return { state: "failed" };
    if (states.some((s) => s.state === "pending")) return { state: "pending" };
    const files: Uint8Array[] = [];
    for (const s of states) {
      const bytes = s.state === "success" ? await download(s.url) : null;
      if (!bytes) return { state: "pending" };
      files.push(bytes);
    }
    const made = provenance(input, providerJobId);
    const output: PresetOutput = input.preset === "upscale_2k"
      ? buildUpscaleOutput(files[0]!, made)
      : buildMatteOutput(input, files[0]!, files[1] ?? null, made);
    return { state: "done", output };
  }

  /** Checks made before anything is uploaded or submitted, so a bad source costs nothing. */
  function precheck(input: PresetInput): { width: number; height: number } {
    if (input.preset === "upscale_2k") {
      const info = readImageInfo(input.source.bytes);
      if (!info) throw new ImageAdapterRefused("Unreadable source image");
      return { width: info.width, height: info.height };
    }
    let decoded;
    try { decoded = decodePng(input.source.bytes); } catch { throw new ImageAdapterRefused("The source is not a readable PNG"); }
    const { width, height } = decoded;
    if (Math.min(width, height) < CUTOUT_MIN_SIDE || Math.max(width, height) > CUTOUT_MAX_SIDE)
      throw new ImageAdapterRefused("The source is outside the cut-out model's size range");
    return { width, height };
  }

  return {
    adapter: "kie",
    modelId: (preset) => PRESET_MODELS[preset],

    async runPreset(input) {
      const { width, height } = precheck(input);
      const ids: string[] = [];
      if (input.preset === "upscale_2k") {
        const imageUrl = await upload(input);
        // TODO verify: input field names and that the factor is a string.
        ids.push(await submit(KIE_MODELS.upscale, { image_url: imageUrl, upscale_factor: String(upscaleFactor(width, height)) }, null));
      } else {
        const imageUrl = await upload(input);
        ids.push(await submit(KIE_MODELS.cutout, { image: imageUrl }, null));
        if (input.preset === "studio_background_swap") {
          // TODO verify: input fields. If this answer is lost, the job ID names only the cut-out, and a
          // lookup of it answers `failed`: the tenant got nothing, and we absorb the vendor cost.
          ids.push(await submit(KIE_MODELS.background, {
            prompt: prompt(input), image_size: backgroundSize(width, height), image_resolution: "1K", max_images: 1,
          }, `${ids[0]!}${SEPARATOR}`));
        }
      }
      const providerJobId = ids.join(SEPARATOR);
      const deadline = config.clock.now().getTime() + timeoutMs;
      for (;;) {
        const answer = await settle(input, providerJobId, ids);
        if (answer.state === "done") return answer.output;
        if (answer.state === "failed") throw new ImageAdapterRefused("Kie.ai reported the task failed");
        if (config.clock.now().getTime() >= deadline) throw new ImageOutcomeUnknown(providerJobId, "The Kie.ai task did not finish in time");
        await config.sleep(pollIntervalMs);
      }
    },

    async lookup(providerJobId, input) {
      const ids = taskIds(providerJobId, input.preset);
      if (!ids) return { state: "failed" };
      try { return await settle(input, providerJobId, ids); } catch (error) {
        // A result that is unreadable or on another host will never become readable.
        if (error instanceof ImageAdapterRefused) return { state: "failed" };
        throw error;
      }
    },
  };
}
