// IM-6, IM-17: the deploy's adapter, chosen by config. A vendor adapter without its key fails at
// start-up (closed), and Higgsfield and ComfyUI are not built, so naming them fails too.
import { ValidationFailed, type ImagePreset } from "@zs/contracts";
import { createFalImageWorkflowPort } from "./adapters/fal.js";
import { createKieImageWorkflowPort } from "./adapters/kie.js";
import type { ImageConfig } from "./config.js";
import { createFakeImageWorkflowPort, type ImageWorkflowPort } from "./port.js";

export interface ImagePortDependencies {
  readonly fetch: typeof fetch;
  readonly clock: { now(): Date };
  readonly sleep: (ms: number) => Promise<void>;
  /** The configured adapter's key, from the vault. Empty or absent fails closed. */
  readonly apiKey?: string;
  /** TODO verify: the vendor's cost per preset, in micros of USD, from config. */
  readonly vendorCostMicros?: Readonly<Record<ImagePreset, number>>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export function createImageWorkflowPort(config: ImageConfig, deps: ImagePortDependencies): ImageWorkflowPort {
  if (config.adapter === "fake") return createFakeImageWorkflowPort();
  if (config.adapter !== "kie" && config.adapter !== "fal") throw new ValidationFailed(`The ${config.adapter} image adapter is not built`);
  if (!deps.apiKey) throw new ValidationFailed(`The ${config.adapter} image adapter needs an API key`);
  if (!deps.vendorCostMicros) throw new ValidationFailed(`The ${config.adapter} image adapter needs its vendor costs in config`);
  const options = {
    apiKey: deps.apiKey, fetch: deps.fetch, clock: deps.clock, sleep: deps.sleep, vendorCostMicros: deps.vendorCostMicros,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  };
  return config.adapter === "kie" ? createKieImageWorkflowPort(options) : createFalImageWorkflowPort(options);
}
