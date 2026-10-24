// Placeholder: the FAL adapter (image-port.md IM-17) replaces this file.
import { ValidationFailed } from "@zs/contracts";
import type { ImageWorkflowPort } from "../port.js";
import type { VendorAdapterOptions } from "./shared.js";

export type FalAdapterConfig = VendorAdapterOptions;
export const FAL_HOSTS: ReadonlySet<string> = new Set<string>();
export function createFalImageWorkflowPort(config: FalAdapterConfig): ImageWorkflowPort {
  if (!config.apiKey) throw new ValidationFailed("A FAL API key is required");
  throw new ValidationFailed("The FAL image adapter is not built yet");
}
