// G-18: the no-personal-data lane's real model, on DeepSeek Flash (docs/integrations.md: cheapest
// approved lane, never for personal data). The default model ID and its price are unverified.
import { z } from "zod";
import { createChatCompletionsModel, type FetchLike } from "./chat-completions.js";
import type { TextModel } from "../model.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly model?: string;
  readonly baseUrl?: string;
}

/** DeepSeek has JSON mode but no schema parameter, so the schema goes into the system text. */
export function createDeepSeekModel(config: DeepSeekConfig): TextModel<"no_personal_data"> {
  return createChatCompletionsModel({
    lane: "no_personal_data",
    vendor: "DeepSeek",
    baseUrl: config.baseUrl ?? DEEPSEEK_BASE_URL,
    apiKey: config.apiKey,
    model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
    fetch: config.fetch,
    maxTokensParameter: "max_tokens",
    jsonMode: (request) => {
      let schema = "";
      try {
        schema = ` Reply with one JSON object that matches this JSON Schema: ${JSON.stringify(z.toJSONSchema(request.schema, { io: "input", unrepresentable: "any" }))}`;
      } catch {
        schema = " Reply with one JSON object.";
      }
      return { system: `${request.system}${schema}`, responseFormat: { type: "json_object" } };
    },
  });
}
