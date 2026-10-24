// enrichment.md E-20: scripted outcomes, no network. Each call is recorded with its key, the route
// cap header, the tag and the input, and `onCall` may snapshot the reservation state at that moment.
import { priceHeader } from "./treg.js";
import {
  TREG_DEDUPE_WINDOW_MS,
  type EnrichmentCall,
  type EnrichmentLookup,
  type EnrichmentOutcome,
  type EnrichmentPort,
} from "./port.js";

export interface FakeCallRecord<Seen = unknown> {
  readonly idempotencyKey: string;
  /** The `X-Treg-Route-Max-Cost` value the real adapter would send. */
  readonly capHeader: string;
  /** The `X-Treg-Meta` tag: the tenant UUID. */
  readonly tag: string;
  /** The full input the provider sees. */
  readonly input: Readonly<{ domain: string }>;
  readonly tool: string;
  /** Whatever `onCall` returned: the test reads the wallet there, so it sees the hold at call time. */
  readonly seen: Seen | undefined;
}

export interface FakeEnrichmentOptions<Seen = unknown> {
  /** One outcome per call, in order; the last repeats. Default: a miss. */
  readonly script?: readonly (EnrichmentOutcome | (() => EnrichmentOutcome | Promise<EnrichmentOutcome>))[];
  readonly lookups?: readonly EnrichmentLookup[];
  readonly role?: string;
  readonly balanceMicro?: number;
  readonly dedupeWindowMs?: number;
  readonly onCall?: (call: EnrichmentCall) => Promise<Seen> | Seen;
}

export interface FakeEnrichment<Seen = unknown> extends EnrichmentPort {
  readonly calls: FakeCallRecord<Seen>[];
  readonly lookupCalls: { callId: string | null; idempotencyKey: string }[];
  balanceMicro: number;
  role: string;
  script: (EnrichmentOutcome | (() => EnrichmentOutcome | Promise<EnrichmentOutcome>))[];
}

export function createFakeEnrichment<Seen = unknown>(options: FakeEnrichmentOptions<Seen> = {}): FakeEnrichment<Seen> {
  const fake: FakeEnrichment<Seen> = {
    name: "fake",
    dedupeWindowMs: options.dedupeWindowMs ?? TREG_DEDUPE_WINDOW_MS,
    calls: [],
    lookupCalls: [],
    balanceMicro: options.balanceMicro ?? 50_000_000,
    role: options.role ?? "agent",
    script: [...(options.script ?? [{ status: "miss", callId: null, provider: null, costMicro: 0 }])],
    async run(call) {
      const seen = options.onCall ? await options.onCall(call) : undefined;
      fake.calls.push({
        idempotencyKey: call.idempotencyKey, capHeader: priceHeader(call.priceCents), tag: call.tenantId,
        input: { domain: call.domain }, tool: "treg.companies.enrich", seen,
      });
      const next = fake.script.length > 1 ? fake.script.shift()! : fake.script[0]!;
      return typeof next === "function" ? next() : next;
    },
    async lookup(input) {
      fake.lookupCalls.push({ callId: input.callId, idempotencyKey: input.idempotencyKey });
      const queue = options.lookups ?? [{ status: "unknown", code: "lookup_unsupported" }];
      return queue[Math.min(fake.lookupCalls.length - 1, queue.length - 1)]!;
    },
    async balance() { return { balanceMicro: fake.balanceMicro }; },
    async whoami() { return { role: fake.role }; },
  };
  return fake;
}
