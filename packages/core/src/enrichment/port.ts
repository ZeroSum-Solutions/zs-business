// enrichment.md E-1: every Treg call goes through this port, from one call site (the worker).
import type { EnrichmentField, EnrichmentOp } from "@zs/contracts";

export interface EnrichmentCall {
  readonly op: EnrichmentOp;
  /** The one Treg input (E-4). Name, email and phone never reach the port. */
  readonly domain: string;
  /** `enrichment:<requestId>`; every retry of one request repeats it (E-12). */
  readonly idempotencyKey: string;
  /** The price in whole cents; the adapter sends it exactly as the route cap (E-8). */
  readonly priceCents: number;
  /** The Treg tag: the tenant UUID, never a name or an email (E-18). */
  readonly tenantId: string;
}

/** E-13: only the allowlisted fields, already bounded; values are untrusted text. */
export type EnrichmentFields = Readonly<Partial<Record<EnrichmentField, string>>>;

export type EnrichmentFailure = "rate_limited" | "provider_error" | "refused" | "route_max_cost" | "insufficient_balance";

/** E-11, E-12: what one call came to. `costMicro` is Treg's cost header, on every status. */
export type EnrichmentOutcome =
  | { readonly status: "hit"; readonly callId: string; readonly provider: string; readonly costMicro: number; readonly fields: EnrichmentFields }
  | { readonly status: "miss"; readonly callId: string | null; readonly provider: string | null; readonly costMicro: number }
  | { readonly status: "rejected"; readonly code: string; readonly callId: string | null; readonly costMicro: number }
  | {
    readonly status: "failed"; readonly kind: EnrichmentFailure; readonly code: string; readonly retryAfterS?: number;
    readonly callId: string | null; readonly costMicro: number;
  }
  /** A timeout, a dropped connection or a 409 (still in flight): the call may have been made. */
  | { readonly status: "uncertain"; readonly code: string }
  /** The key is no longer held (410): only `lookup` can say what happened. */
  | { readonly status: "key_expired"; readonly callId: string | null };

export type EnrichmentLookup =
  | { readonly status: "charged"; readonly callId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unknown"; readonly code: string };

export interface EnrichmentCallOptions { readonly signal?: AbortSignal }

export interface EnrichmentPort {
  /** A stable name for the provider; stored with the attempt. */
  readonly name: string;
  run(call: EnrichmentCall, options?: EnrichmentCallOptions): Promise<EnrichmentOutcome>;
  lookup(input: { readonly callId: string | null; readonly idempotencyKey: string }, options?: EnrichmentCallOptions): Promise<EnrichmentLookup>;
  /** E-16: the team balance in micro-USD. */
  balance(options?: EnrichmentCallOptions): Promise<{ readonly balanceMicro: number }>;
  /** E-5: what role the token holds; an `owner` token is refused. */
  whoami(options?: EnrichmentCallOptions): Promise<{ readonly role: string }>;
  /** How long Treg replays one key (24 hours). */
  readonly dedupeWindowMs: number;
}

export const TREG_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
