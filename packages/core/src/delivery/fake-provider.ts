// M3d fake provider. Nothing leaves the process: it records what a real provider would have
// delivered, drops repeats of an idempotency key inside its dedupe window like a real one, and
// plays scripted behaviour so tests can force every outcome the worker handles.
import type { DeliveryChannel } from "@zs/contracts";
import type { DeliveryProvider, ProviderLookupOutcome, ProviderSendOutcome, ProviderSendRequest } from "./provider.js";

/**
 * What one call does when the key is not a repeat:
 * - accept: deliver and answer accepted;
 * - reject / fail: deliver nothing, answer rejected / failed;
 * - edge-fail: answer failed before looking at the key, even for one already accepted (a rate limit);
 * - lose-reply: deliver, then answer uncertain (the reply was lost);
 * - timeout: deliver nothing, answer uncertain;
 * - throw: deliver nothing and throw;
 * - hold: wait for `release` and then act as `then`; `reached` resolves once the call arrives.
 */
export type FakeBehaviour =
  | "accept" | "reject" | "fail" | "edge-fail" | "lose-reply" | "timeout" | "throw"
  | { readonly hold: Promise<void>; readonly then: Exclude<FakeBehaviour, { hold: Promise<void> }>; readonly reached?: () => void };

export interface FakeDelivery {
  readonly providerMessageId: string;
  readonly acceptedAt: number;
  readonly request: ProviderSendRequest;
}

export interface FakeProvider extends DeliveryProvider {
  /** Behaviours for the next calls, in order; once used up, calls accept. */
  queue(...behaviours: FakeBehaviour[]): void;
  /** Messages a recipient would have received, one per accepted key. */
  readonly delivered: readonly FakeDelivery[];
  /** Every send call, repeats included. */
  readonly calls: readonly ProviderSendRequest[];
  readonly lookups: readonly string[];
}

export function createFakeProvider(options: {
  readonly clock: { now(): Date };
  readonly name?: string;
  readonly dedupeWindowMs?: number;
  /** False leaves out lookup, like a provider without a status API. */
  readonly lookup?: boolean;
  readonly channels?: readonly DeliveryChannel[];
}): FakeProvider {
  const dedupeWindowMs = options.dedupeWindowMs ?? 24 * 60 * 60 * 1000;
  const accepted = new Map<string, FakeDelivery>();
  const delivered: FakeDelivery[] = [];
  const calls: ProviderSendRequest[] = [];
  const lookups: string[] = [];
  const script: FakeBehaviour[] = [];
  let sequence = 0;
  const now = () => options.clock.now().getTime();

  const deliver = (request: ProviderSendRequest): FakeDelivery => {
    sequence += 1;
    const record = { providerMessageId: `fake-${sequence}`, acceptedAt: now(), request };
    accepted.set(request.idempotencyKey, record);
    delivered.push(record);
    return record;
  };
  const repeat = (key: string): FakeDelivery | undefined => {
    const record = accepted.get(key);
    return record && now() - record.acceptedAt < dedupeWindowMs ? record : undefined;
  };

  async function act(behaviour: FakeBehaviour, request: ProviderSendRequest): Promise<ProviderSendOutcome> {
    if (typeof behaviour === "object") {
      behaviour.reached?.();
      await behaviour.hold;
      // A repeat may have been accepted while this call waited.
      const earlier = repeat(request.idempotencyKey);
      if (earlier) return { status: "accepted", providerMessageId: earlier.providerMessageId };
      return act(behaviour.then, request);
    }
    switch (behaviour) {
      case "accept": return { status: "accepted", providerMessageId: deliver(request).providerMessageId };
      case "reject": return { status: "rejected", code: "fake_rejected" };
      case "fail":
      case "edge-fail": return { status: "failed", code: "fake_rate_limited" };
      case "lose-reply": deliver(request); return { status: "uncertain", code: "fake_reply_lost" };
      case "timeout": return { status: "uncertain", code: "fake_timeout" };
      case "throw": throw new Error("fake provider connection reset");
    }
  }

  const provider: FakeProvider = {
    name: options.name ?? "fake",
    dedupeWindowMs,
    queue: (...behaviours) => { script.push(...behaviours); },
    delivered,
    calls,
    lookups,
    async send(request) {
      calls.push(request);
      if (options.channels && !options.channels.includes(request.channel)) return { status: "rejected", code: "fake_channel" };
      // A refusal at the edge (a rate limit) comes before the provider looks at the key.
      if (script[0] === "edge-fail") return act(script.shift()!, request);
      const earlier = repeat(request.idempotencyKey);
      if (earlier) return { status: "accepted", providerMessageId: earlier.providerMessageId };
      return act(script.shift() ?? "accept", request);
    },
  };
  if (options.lookup !== false) {
    provider.lookup = async (key): Promise<ProviderLookupOutcome> => {
      lookups.push(key);
      const record = accepted.get(key);
      return record ? { status: "accepted", providerMessageId: record.providerMessageId } : { status: "not_found" };
    };
  }
  return provider;
}
