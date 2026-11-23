// G-18: the personal-data lane's real model, on Cerebras (docs/integrations.md: prepaid, US).
// The default model ID and its price (`VENDOR_MODEL_PRICES`) were checked against
// cerebras.ai/pricing and GET /v1/models on 2026-11-22 (ZSB-45).
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

/**
 * gpt-oss models reason before they answer, and the reasoning counts against
 * `max_completion_tokens`. At the default effort a follow-up's reasoning reached 558 of the
 * 600-token cap (G-9) in live probes on 2026-11-22, and one preview run on 2026-11-11 was cut off
 * at 600 and refused as invalid. Low effort kept every probe near 200 tokens.
 */
function cerebrasExtraBody(model: string): Readonly<Record<string, string>> | undefined {
  return model.startsWith("gpt-oss-") ? { reasoning_effort: "low" } : undefined;
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
  const model = config.model ?? CEREBRAS_DEFAULT_MODEL;
  const extraBody = cerebrasExtraBody(model);
  return createChatCompletionsModel({
    lane: "personal_data",
    vendor: "Cerebras",
    baseUrl,
    apiKey: config.apiKey,
    model,
    fetch: config.fetch,
    ...(extraBody ? { extraBody } : {}),
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
