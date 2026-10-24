// G-18: the personal-data lane's real model, on Cerebras (docs/integrations.md: prepaid, US).
// The default model ID and its price (`VENDOR_MODEL_PRICES`) are unverified against the vendor.
import { z } from "zod";
import { createChatCompletionsModel, type FetchLike } from "./chat-completions.js";
import type { TextModel } from "../model.js";

export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_HOST = "api.cerebras.ai";
export const CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b";

export interface CerebrasConfig {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly model?: string;
  readonly baseUrl?: string;
}

/** Strict mode wants every object closed (`additionalProperties: false`) and every property required. */
function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = closeObjects(value);
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * Cerebras takes a JSON Schema for the answer; a schema it cannot express falls back to JSON mode.
 * G-18: the personal-data lane can only be pointed at Cerebras. A base URL that names another host
 * (DeepSeek, say) is refused here, so no configuration sends customer data elsewhere.
 */
export function createCerebrasModel(config: CerebrasConfig): TextModel<"personal_data"> {
  const baseUrl = config.baseUrl ?? CEREBRAS_BASE_URL;
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* refused below */ }
  if (host !== CEREBRAS_HOST) throw new Error(`Cerebras: the base URL must be on ${CEREBRAS_HOST}`);
  return createChatCompletionsModel({
    lane: "personal_data",
    vendor: "Cerebras",
    baseUrl,
    apiKey: config.apiKey,
    model: config.model ?? CEREBRAS_DEFAULT_MODEL,
    fetch: config.fetch,
    maxTokensParameter: "max_completion_tokens",
    jsonMode: (request) => {
      try {
        const schema = closeObjects(z.toJSONSchema(request.schema, { io: "input", unrepresentable: "any" }));
        return {
          system: request.system,
          responseFormat: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
        };
      } catch {
        return { system: request.system, responseFormat: { type: "json_object" } };
      }
    },
  });
}
