// Model lanes (agents.md G-18, docs/integrations.md). Original code. Every agent kind has one lane,
// fixed here; `modelForLane` builds the model for a lane from a provider choice and refuses a
// provider the lane may not use: the personal-data lane is Cerebras (or a fake), never DeepSeek.
import { ValidationFailed, type AgentKind, type AgentLane } from "@zs/contracts";
import { CEREBRAS_DEFAULT_MODEL, createCerebrasModel } from "./adapters/cerebras.js";
import { DEEPSEEK_DEFAULT_MODEL, createDeepSeekModel } from "./adapters/deepseek.js";
import type { FetchLike } from "./adapters/chat-completions.js";
import type { ModelPrices } from "./cost.js";
import { FAKE_MODEL_PRICES, priceFor } from "./cost.js";
import { createFakeTextModel, type TextModel } from "./model.js";

/**
 * G-18: the lane each kind's model calls go to. Every kind built so far reads a customer's
 * personal data (an inquiry, an appointment, a review, a document, a call), so all five use the
 * personal-data lane. A kind that only handles business text would be listed here as `no_personal_data`.
 */
export const AGENT_KIND_LANES: Readonly<Record<AgentKind, AgentLane>> = Object.freeze({
  inquiry_followup: "personal_data",
  appointment_reminder: "personal_data",
  review_request: "personal_data",
  document_intake: "personal_data",
  voice_receptionist: "personal_data",
});

/**
 * G-15: the vendors' list prices in USD millionths per million tokens, keyed by model ID. Not read
 * from the environment. UNVERIFIED against the vendors' price pages: confirm before a real tenant
 * runs a real lane, and update with the model ID.
 */
export const VENDOR_MODEL_PRICES: ModelPrices = Object.freeze({
  ...FAKE_MODEL_PRICES,
  [CEREBRAS_DEFAULT_MODEL]: Object.freeze({ inputMicrosPerMillionTokens: 350_000, outputMicrosPerMillionTokens: 750_000 }),
  [DEEPSEEK_DEFAULT_MODEL]: Object.freeze({ inputMicrosPerMillionTokens: 280_000, outputMicrosPerMillionTokens: 420_000 }),
});

export type PersonalDataSource =
  | { readonly provider: "fake" }
  | { readonly provider: "cerebras"; readonly apiKey: string; readonly fetch: FetchLike; readonly model?: string };
export type NoPersonalDataSource =
  | { readonly provider: "fake" }
  | { readonly provider: "deepseek"; readonly apiKey: string; readonly fetch: FetchLike; readonly model?: string };

/** G-18: the model for a lane. A provider the lane does not allow is a `ValidationFailed`, also at run time. */
export function modelForLane(lane: "personal_data", source: PersonalDataSource): TextModel<"personal_data">;
export function modelForLane(lane: "no_personal_data", source: NoPersonalDataSource): TextModel<"no_personal_data">;
export function modelForLane(lane: AgentLane, source: { readonly provider: string }): TextModel {
  const real = source as { provider: string; apiKey: string; fetch: FetchLike; model?: string };
  if (lane === "personal_data") {
    if (source.provider === "fake") return createFakeTextModel("personal_data");
    if (source.provider === "cerebras") return createCerebrasModel({ apiKey: real.apiKey, fetch: real.fetch, ...(real.model ? { model: real.model } : {}) });
    throw new ValidationFailed(`The personal-data lane cannot use ${source.provider}`);
  }
  if (source.provider === "fake") return createFakeTextModel("no_personal_data");
  if (source.provider === "deepseek") return createDeepSeekModel({ apiKey: real.apiKey, fetch: real.fetch, ...(real.model ? { model: real.model } : {}) });
  throw new ValidationFailed(`The no-personal-data lane cannot use ${source.provider}`);
}

/**
 * G-18: refuse a model that is not on the kind's lane, or that has no price (G-15). Called when an
 * agent is created, so a bad configuration fails at start, not on the first customer's data.
 */
export function assertKindModel(kind: AgentKind, model: { readonly lane: AgentLane; readonly model: string }, prices: ModelPrices): void {
  const lane = AGENT_KIND_LANES[kind];
  if (model.lane !== lane) throw new ValidationFailed(`The ${kind} agent needs a ${lane} model, not a ${model.lane} one`);
  priceFor(prices, model.model);
}
