// Shared HTTP adapter for vendors with an OpenAI-style chat-completions endpoint (agents.md G-18).
// Original code. It holds no key and no ambient fetch: the caller injects both, so a test can
// replay a recorded response and no test reaches a vendor. A failure never carries the response
// body, which may echo the prompt (customer data).
import type { AgentLane } from "@zs/contracts";
import { z } from "zod";
import { abortable, type TextModel, type TextModelRequest, type TextModelResult } from "../model.js";

export type FetchLike = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ChatCompletionsConfig<L extends AgentLane> {
  readonly lane: L;
  /** For error messages: never a secret. */
  readonly vendor: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: FetchLike;
  /** The name of the output-limit parameter this vendor takes. */
  readonly maxTokensParameter: "max_completion_tokens" | "max_tokens";
  /** The vendor's JSON-mode request fields, and any change to the system text they need. */
  readonly jsonMode: (request: TextModelRequest) => { readonly responseFormat: unknown; readonly system: string };
}

/** The part of a chat-completions answer the adapters read; everything else is ignored. */
const completionSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().min(0), completion_tokens: z.number().int().min(0) }),
});

/** The answer as JSON when it parses, else the raw text for the caller's validation to refuse. */
function parseContent(content: string | null): unknown {
  if (content === null) return null;
  try { return JSON.parse(content); } catch { return content; }
}

export function createChatCompletionsModel<L extends AgentLane>(config: ChatCompletionsConfig<L>): TextModel<L> {
  if (!config.apiKey) throw new Error(`${config.vendor}: an API key is required`);
  if (!config.baseUrl.startsWith("https://")) throw new Error(`${config.vendor}: the base URL must be https`);
  return {
    lane: config.lane,
    model: config.model,
    async complete(request, signal): Promise<TextModelResult> {
      const mode = config.jsonMode(request);
      const body = JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: mode.system },
          { role: "user", content: JSON.stringify(request.input) },
        ],
        [config.maxTokensParameter]: request.maxOutputTokens,
        temperature: 0.2,
        stream: false,
        response_format: mode.responseFormat,
      });
      const response = await abortable(config.fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body,
        ...(signal ? { signal } : {}),
      }), signal);
      if (!response.ok) throw new Error(`${config.vendor} request failed with status ${response.status}`);
      const parsed = completionSchema.safeParse(await abortable(response.json(), signal));
      if (!parsed.success) throw new Error(`${config.vendor} answered in an unexpected shape`);
      const { id, choices, usage } = parsed.data;
      return {
        output: parseContent(choices[0]!.message.content),
        usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
        model: config.model,
        ...(id ? { providerRequestId: id } : {}),
      };
    },
  };
}
