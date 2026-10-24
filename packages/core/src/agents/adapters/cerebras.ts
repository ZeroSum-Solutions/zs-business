// G-18: the personal-data lane's real model, on Cerebras (docs/integrations.md: prepaid, US).
// The default model ID and its price (`VENDOR_MODEL_PRICES`) are unverified against the vendor.
import { z } from "zod";
import { createChatCompletionsModel, type FetchLike } from "./chat-completions.js";
import type { TextModel } from "../model.js";

export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
export const CEREBRAS_DEFAULT_MODEL = "gpt-oss-120b";

export interface CerebrasConfig {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly model?: string;
  readonly baseUrl?: string;
}

/** Cerebras takes a JSON Schema for the answer; a schema it cannot express falls back to JSON mode. */
export function createCerebrasModel(config: CerebrasConfig): TextModel<"personal_data"> {
  return createChatCompletionsModel({
    lane: "personal_data",
    vendor: "Cerebras",
    baseUrl: config.baseUrl ?? CEREBRAS_BASE_URL,
    apiKey: config.apiKey,
    model: config.model ?? CEREBRAS_DEFAULT_MODEL,
    fetch: config.fetch,
    maxTokensParameter: "max_completion_tokens",
    jsonMode: (request) => {
      try {
        const schema = z.toJSONSchema(request.schema, { io: "input", unrepresentable: "any" });
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
