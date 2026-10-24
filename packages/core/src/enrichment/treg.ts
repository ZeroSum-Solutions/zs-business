// enrichment.md E-1: the Treg adapter. One HTTPS `fetch` per call. It never logs, and it never keeps
// the body: only the allowlisted fields (minimize.ts), the call id, the provider and the cost header.
// Paths and the response envelope follow Treg's public docs as read on 2026-10-22 and are NOT yet
// confirmed against the live API (enrichment.md Known limits); they are configuration, not code.
import { ValidationFailed } from "@zs/contracts";
import { minimizeOutput } from "./minimize.js";
import {
  TREG_DEDUPE_WINDOW_MS,
  type EnrichmentCall,
  type EnrichmentCallOptions,
  type EnrichmentLookup,
  type EnrichmentOutcome,
  type EnrichmentPort,
} from "./port.js";
import { ENRICHMENT_TOOLS, isAllowedTool } from "./tools.js";

/** Whole cents as the exact dollar string Treg's `X-Treg-Route-Max-Cost` takes (5 -> "0.05"). */
export function priceHeader(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new ValidationFailed("Price must be a positive whole number of cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export const TREG_DEFAULT_BASE_URL = "https://api.treg.to";

export interface TregConfig {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly clock: { now(): Date };
  readonly timeoutMs?: number;
  readonly paths?: Partial<{ call: string; whoami: string; balance: string; calls: string }>;
}

const DEFAULT_PATHS = { call: "/v1/call", whoami: "/v1/whoami", balance: "/v1/balance", calls: "/v1/calls" };

const short = (text: unknown, fallback: string) =>
  typeof text === "string" && text.length > 0 ? text.replace(/[^a-z0-9_.:-]/gi, "_").slice(0, 60) : fallback;
const microHeader = (response: Response): number => {
  const raw = response.headers.get("x-treg-cost-micro");
  const n = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
};

/** The JSON object of a reply, `{}` for a valid non-object, and `null` when the body cannot be read. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch { return null; }
}

export function createTregEnrichment(config: TregConfig): EnrichmentPort {
  if (!config.token) throw new ValidationFailed("A Treg token is required");
  let base = config.baseUrl ?? TREG_DEFAULT_BASE_URL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  // The token is sent in a header: only over HTTPS (a loopback address is allowed for local tests).
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)))
    throw new ValidationFailed("The Treg base URL must use HTTPS");
  /** Provider text, bounded and with the token blanked out. */
  const safe = (text: unknown, fallback: string) => {
    const bounded = short(text, fallback);
    return config.token && bounded.includes(config.token) ? fallback : bounded;
  };
  const paths = { ...DEFAULT_PATHS, ...config.paths };
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function request(path: string, init: RequestInit, options?: EnrichmentCallOptions, extra: Record<string, string> = {}) {
    const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return doFetch(`${base}${path}`, { ...init, redirect: "error", headers: { "X-Treg-Token": config.token, accept: "application/json", ...extra }, signal });
  }

  return {
    name: "treg",
    dedupeWindowMs: TREG_DEDUPE_WINDOW_MS,

    async run(call: EnrichmentCall, options): Promise<EnrichmentOutcome> {
      const tool = ENRICHMENT_TOOLS[call.op];
      // E-2: nothing outside the allowlist reaches the network.
      if (!tool || !isAllowedTool(tool)) throw new ValidationFailed("That enrichment op is not allowed");
      // A bad price is a programming error: it throws here, before the network, and is not an unknown outcome.
      const cap = priceHeader(call.priceCents);
      let response: Response;
      try {
        response = await request(paths.call, { method: "POST", body: JSON.stringify({ tool, input: { domain: call.domain } }) }, options, {
          "content-type": "application/json",
          "Idempotency-Key": call.idempotencyKey,
          "X-Treg-Route-Max-Cost": cap,
          "X-Treg-Meta": `tenant=${call.tenantId}, feature=${call.op}`,
        });
      } catch (error) {
        return { status: "uncertain", code: error instanceof Error && error.name === "TimeoutError" ? "provider_timeout" : "provider_unreachable" };
      }
      const costMicro = microHeader(response);
      const callId = response.headers.get("x-treg-call-id");
      const status = response.status;
      if (status === 409) return { status: "uncertain", code: "in_flight" };
      if (status === 410) return { status: "key_expired", callId };
      const parsedBody = await readJson(response);
      // A 200 whose body never arrived may still have been charged: that is not a miss.
      if (parsedBody === null && response.ok) return { status: "uncertain", code: "unreadable_response" };
      const body = parsedBody ?? {};
      const refused = response.headers.get("x-treg-error") === "1";
      const errorBody = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : {};
      const code = safe(errorBody.code ?? body.error ?? response.headers.get("x-treg-error-code"), `http_${status}`);
      if (response.ok) {
        const fields = minimizeOutput(body.output, config.clock.now());
        const provider = short(response.headers.get("x-treg-provider") ?? body.provider, "treg");
        const id = callId ?? (typeof body.call_id === "string" ? short(body.call_id, "") : "");
        if (Object.keys(fields).length === 0) return { status: "miss", callId: id || null, provider, costMicro };
        if (!id) return { status: "uncertain", code: "no_call_id" };
        return { status: "hit", callId: id, provider, costMicro, fields };
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const retryAfterS = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) : undefined;
      const failed = (kind: "rate_limited" | "provider_error" | "refused" | "route_max_cost" | "insufficient_balance") =>
        ({ status: "failed", kind, code, callId, costMicro, ...(retryAfterS ? { retryAfterS } : {}) }) as const;
      if (refused || status === 401 || status === 402 || status === 403) {
        if (status === 402 || code === "insufficient_balance") return failed("insufficient_balance");
        if (code === "route_max_cost") return failed("route_max_cost");
        return failed("refused");
      }
      if (status === 429) return failed("rate_limited");
      if (status >= 500) return failed("provider_error");
      return { status: "rejected", code, callId, costMicro };
    },

    async lookup(input, options): Promise<EnrichmentLookup> {
      try {
        const path = input.callId
          ? `${paths.calls}/${encodeURIComponent(input.callId)}`
          : `${paths.calls}?idempotency_key=${encodeURIComponent(input.idempotencyKey)}`;
        const response = await request(path, { method: "GET" }, options);
        if (response.status === 404) return { status: "not_found" };
        if (!response.ok) return { status: "unknown", code: `http_${response.status}` };
        const body = (await readJson(response)) ?? {};
        const calls = Array.isArray(body.calls) ? body.calls : [body];
        const first = calls.find((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && (typeof (entry as Record<string, unknown>).id === "string" || typeof (entry as Record<string, unknown>).call_id === "string"));
        if (!first) return { status: "not_found" };
        return { status: "charged", callId: short(first.id ?? first.call_id, input.callId ?? "unknown") };
      } catch { return { status: "unknown", code: "lookup_failed" }; }
    },

    async balance(options) {
      const response = await request(paths.balance, { method: "GET" }, options);
      if (!response.ok) throw new Error(`balance_http_${response.status}`);
      const body = (await readJson(response)) ?? {};
      const micro = Number(body.balance_micro ?? body.balanceMicro);
      if (!Number.isSafeInteger(micro)) throw new Error("balance_unreadable");
      return { balanceMicro: micro };
    },

    async whoami(options) {
      const response = await request(paths.whoami, { method: "GET" }, options);
      if (!response.ok) throw new Error(`whoami_http_${response.status}`);
      const body = (await readJson(response)) ?? {};
      return { role: short(body.role, "unknown") };
    },
  };
}
