// G-17, G-18: the real model adapters against recorded vendor-shaped responses. No test reaches a vendor:
// the adapters take an injected fetch that replays a fixture. The fixtures are hand-built to the vendors'
// documented chat-completions shape; they are not live recordings (the vendor price and model ID are unverified).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { followUpDraftSchema, ValidationFailed, AGENT_KINDS } from "@zs/contracts";
import {
  AGENT_KIND_LANES,
  CEREBRAS_DEFAULT_MODEL,
  createCerebrasModel,
  createDeepSeekModel,
  createFakeTextModel,
  createFollowUpModel,
  DEEPSEEK_DEFAULT_MODEL,
  modelForLane,
  priceUsage,
  VENDOR_MODEL_PRICES,
  worstCase,
  type FetchLike,
  type TextModelRequest,
} from "../src/index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/model/${name}.json`, import.meta.url)), "utf8")) as { status: number; body: unknown };

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal | undefined }
function replay(name: string) {
  const sent: Sent[] = [];
  const recorded = fixture(name);
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal });
    return { ok: recorded.status >= 200 && recorded.status < 300, status: recorded.status, json: async () => recorded.body };
  };
  return { fetch, sent };
}

const request: TextModelRequest = {
  system: "You write one short follow-up email.",
  input: { customer: "Halden Rowe", note: "Do you have parking?" },
  schema: followUpDraftSchema,
  maxOutputTokens: 600,
};

describe("Cerebras adapter (personal-data lane)", () => {
  it("posts a schema-constrained request with the bearer key and reads output, usage and request ID", async () => {
    const { fetch, sent } = replay("cerebras-ok");
    const model = createCerebrasModel({ apiKey: "test-key", fetch });
    expect(model).toMatchObject({ lane: "personal_data", model: CEREBRAS_DEFAULT_MODEL });

    const result = await model.complete(request);
    expect(result).toEqual({
      output: { subject: "Parking at Halden Rowe", body: "Hi Halden, yes, there is free parking behind the building." },
      usage: { inputTokens: 412, outputTokens: 58 },
      model: CEREBRAS_DEFAULT_MODEL,
      providerRequestId: "chatcmpl-cb-4f1c9a7e",
    });
    expect(followUpDraftSchema.safeParse(result.output).success).toBe(true);
    // Priced from the table, rounded up: 412 * 0.35 + 58 * 0.75 = 187.7.
    expect(priceUsage(VENDOR_MODEL_PRICES, result.model, result.usage)).toBe(188);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(sent[0]!.headers.authorization).toBe("Bearer test-key");
    expect(sent[0]!.body).toMatchObject({
      model: CEREBRAS_DEFAULT_MODEL,
      max_completion_tokens: 600,
      stream: false,
      response_format: { type: "json_schema", json_schema: { strict: true } },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: JSON.stringify(request.input) },
      ],
    });
    expect(sent[0]!.body).not.toHaveProperty("max_tokens");
  });

  it("returns an answer that is not JSON as raw text for the caller to refuse", async () => {
    const { fetch } = replay("cerebras-truncated");
    const result = await createCerebrasModel({ apiKey: "k", fetch }).complete(request);
    expect(result.output).toBe('{"subject":"Parking at Hal');
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 600 });
    expect(followUpDraftSchema.safeParse(result.output).success).toBe(false);
  });

  it("fails on a non-2xx status without echoing the vendor's body, and on an unexpected shape", async () => {
    const failed = await createCerebrasModel({ apiKey: "k", fetch: replay("vendor-error").fetch }).complete(request).then(() => null, (error: Error) => error);
    expect(failed?.message).toBe("Cerebras request failed with status 429");
    expect(failed?.message).not.toContain("Halden");
    await expect(createCerebrasModel({ apiKey: "k", fetch: replay("wrong-shape").fetch }).complete(request)).rejects.toThrow("unexpected shape");
  });

  it("passes the abort signal to the transport and rejects when it aborts", async () => {
    let seen: AbortSignal | undefined;
    const hang: FetchLike = (_url, init) => { seen = init.signal; return new Promise(() => undefined); };
    const controller = new AbortController();
    const pending = createCerebrasModel({ apiKey: "k", fetch: hang }).complete(request, controller.signal);
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    expect(seen).toBe(controller.signal);
    // Already aborted: nothing is awaited.
    await expect(createCerebrasModel({ apiKey: "k", fetch: hang }).complete(request, controller.signal)).rejects.toThrow("deadline");
  });

  it("refuses to be built without a key or over plain http", () => {
    const { fetch } = replay("cerebras-ok");
    expect(() => createCerebrasModel({ apiKey: "", fetch })).toThrow("API key");
    expect(() => createCerebrasModel({ apiKey: "k", fetch, baseUrl: "http://api.cerebras.ai/v1" })).toThrow("https");
  });

  it("closes every object in the strict schema, and never takes another vendor's host", async () => {
    const { fetch, sent } = replay("cerebras-ok");
    await createCerebrasModel({ apiKey: "k", fetch }).complete(request);
    const format = sent[0]!.body.response_format as { json_schema: { strict: boolean; schema: { type: string; additionalProperties: boolean; required: string[]; properties: object } } };
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toMatchObject({ type: "object", additionalProperties: false, required: ["subject", "body"] });
    // G-18: customer data cannot be pointed at DeepSeek (or any other host) through the adapter's own config.
    for (const baseUrl of ["https://api.deepseek.com", "https://api.cerebras.ai.evil.example/v1", "https://evil.example/api.cerebras.ai", "not a url"])
      expect(() => createCerebrasModel({ apiKey: "k", fetch, baseUrl })).toThrow("must be on api.cerebras.ai");
  });

  it("does not leave an unhandled rejection when the signal was already aborted", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", record);
    try {
      const controller = new AbortController();
      controller.abort(new Error("deadline"));
      const failing: FetchLike = () => Promise.reject(new Error("aborted by transport"));
      await expect(createCerebrasModel({ apiKey: "k", fetch: failing }).complete(request, controller.signal)).rejects.toThrow("deadline");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("plugs under the follow-up port", async () => {
    const { fetch } = replay("cerebras-ok");
    const followUp = createFollowUpModel(createCerebrasModel({ apiKey: "k", fetch }));
    expect(followUp).toMatchObject({ lane: "personal_data", model: CEREBRAS_DEFAULT_MODEL });
    const prompt = { businessName: "Halden Rowe", customerName: "Kai", askedAt: "2026-10-20T10:00:00.000Z", note: "Parking?", booking: null };
    const result = await followUp.draft(prompt as never);
    expect(result.usage).toEqual({ inputTokens: 412, outputTokens: 58 });
  });
});

describe("DeepSeek adapter (no-personal-data lane)", () => {
  it("posts a JSON-mode request with the schema in the system text", async () => {
    const { fetch, sent } = replay("deepseek-ok");
    const model = createDeepSeekModel({ apiKey: "test-key", fetch });
    expect(model).toMatchObject({ lane: "no_personal_data", model: DEEPSEEK_DEFAULT_MODEL });

    const result = await model.complete(request);
    expect(result).toEqual({
      output: { subject: "Opening hours", body: "We are open nine to five on weekdays." },
      usage: { inputTokens: 233, outputTokens: 41 },
      model: DEEPSEEK_DEFAULT_MODEL,
      providerRequestId: "a8e3c1d2-7b40-4c55-9f0e-2d6b1a9c3e11",
    });
    expect(sent[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent[0]!.headers.authorization).toBe("Bearer test-key");
    expect(sent[0]!.body).toMatchObject({ max_tokens: 600, response_format: { type: "json_object" } });
    expect(sent[0]!.body).not.toHaveProperty("max_completion_tokens");
    const system = (sent[0]!.body.messages as { role: string; content: string }[])[0]!.content;
    expect(system.startsWith(request.system)).toBe(true);
    expect(system).toContain("JSON Schema");
    expect(system).toContain('"subject"');
  });

  it("fails without echoing the vendor's body", async () => {
    const failed = await createDeepSeekModel({ apiKey: "k", fetch: replay("vendor-error").fetch }).complete(request).then(() => null, (error: Error) => error);
    expect(failed?.message).toBe("DeepSeek request failed with status 429");
  });
});

describe("lanes (G-18)", () => {
  it("gives every kind the personal-data lane, and prices every default vendor model", () => {
    for (const kind of AGENT_KINDS) expect(AGENT_KIND_LANES[kind]).toBe("personal_data");
    for (const id of [CEREBRAS_DEFAULT_MODEL, DEEPSEEK_DEFAULT_MODEL, "fake-follow-up"]) expect(VENDOR_MODEL_PRICES[id]).toBeDefined();
  });

  it("builds a lane's model from an allowed provider and refuses any other, at compile time and at run time", () => {
    const { fetch } = replay("cerebras-ok");
    expect(modelForLane("personal_data", { provider: "fake" })).toMatchObject({ lane: "personal_data", model: "fake-follow-up" });
    expect(modelForLane("personal_data", { provider: "cerebras", apiKey: "k", fetch })).toMatchObject({ lane: "personal_data", model: CEREBRAS_DEFAULT_MODEL });
    expect(modelForLane("no_personal_data", { provider: "deepseek", apiKey: "k", fetch, model: "deepseek-reasoner" }).model).toBe("deepseek-reasoner");
    // @ts-expect-error DeepSeek is not a personal-data provider.
    expect(() => modelForLane("personal_data", { provider: "deepseek", apiKey: "k", fetch })).toThrow(ValidationFailed);
    // @ts-expect-error Cerebras is not a no-personal-data provider.
    expect(() => modelForLane("no_personal_data", { provider: "cerebras", apiKey: "k", fetch })).toThrow(ValidationFailed);
  });

  it("prices the worst case of a request from its bytes and its output limit", () => {
    const prices = { "fake-follow-up": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } };
    const small: TextModelRequest = { ...request, system: "abc", input: "é", maxOutputTokens: 10 };
    // 3 bytes + the 4 bytes of "\"é\"" JSON (quotes and a 2-byte letter) + 64 framing tokens.
    expect(worstCase(prices, "fake-follow-up", small)).toEqual({ inputTokens: 3 + 4 + 64, outputTokens: 10, costMicros: 71 + 20 });
    expect(() => worstCase({}, "fake-follow-up", small)).toThrow(ValidationFailed);
  });

  it("makes fakes that honour abort and report fixed usage", async () => {
    const fake = createFakeTextModel("personal_data", () => ({ ok: true }));
    expect(await fake.complete(request)).toMatchObject({ output: { ok: true }, usage: { inputTokens: 120, outputTokens: 60 } });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(fake.complete(request, controller.signal)).rejects.toThrow("stop");
  });
});
