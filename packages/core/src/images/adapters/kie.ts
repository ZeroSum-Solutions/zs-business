// Placeholder: the Kie.ai adapter (image-port.md IM-17) replaces this file.
import { ValidationFailed } from "@zs/contracts";
import type { ImageWorkflowPort } from "../port.js";
import type { VendorAdapterOptions } from "./shared.js";

export type KieAdapterConfig = VendorAdapterOptions;
export const KIE_HOSTS: ReadonlySet<string> = new Set<string>();
export function createKieImageWorkflowPort(config: KieAdapterConfig): ImageWorkflowPort {
  if (!config.apiKey) throw new ValidationFailed("A Kie.ai API key is required");
  throw new ValidationFailed("The Kie.ai image adapter is not built yet");
}
