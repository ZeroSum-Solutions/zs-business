// M3d ports (delivery.md D-6, D-7, D-8). Real providers (Resend, Twilio) implement
// DeliveryProvider in M5; the approval record (M3b) implements DeliveryApprovals.
import type { DeliveryChannel } from "@zs/contracts";
import type { Transaction } from "@zs/db";

export interface ProviderSendRequest {
  /** The same for every attempt of one delivery, so the provider drops repeats (D-8). */
  readonly idempotencyKey: string;
  readonly channel: DeliveryChannel;
  readonly to: string;
  readonly subject: string | null;
  readonly text: string;
  /** Email headers (List-Unsubscribe, List-Unsubscribe-Post); empty for SMS. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tenantId: string;
  readonly deliveryId: string;
}

/**
 * D-7. `failed` promises the provider did not accept the message (a refusal before acceptance,
 * such as a rate limit); `uncertain` is anything that might have been accepted. An adapter maps
 * "another request with this key is in flight" to `uncertain`, never to `failed`, and maps a
 * cached failure the provider replays for a key to `rejected`, so retries cannot loop on it.
 */
export type ProviderSendOutcome =
  | { readonly status: "accepted"; readonly providerMessageId: string }
  | { readonly status: "rejected"; readonly code: string }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "uncertain"; readonly code: string };

export type ProviderLookupOutcome =
  | { readonly status: "accepted"; readonly providerMessageId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unknown"; readonly code: string };

export interface ProviderLookupOptions {
  readonly signal: AbortSignal;
  readonly tenantId: string;
  readonly deliveryId: string;
}

export interface DeliveryProvider {
  readonly name: string;
  /**
   * How long the provider drops a repeat of one idempotency key. 0 means it drops none (D-8,
   * revision 4): the worker never sends again after an unknown outcome and settles it by lookup.
   */
  readonly dedupeWindowMs: number;
  /**
   * Only for a provider without dedupe: how long after the first attempt an unknown outcome
   * keeps waiting for evidence through `lookup` before it is a dead letter `outcome_unknown`.
   */
  readonly outcomeWaitMs?: number;
  send(request: ProviderSendRequest, options: { readonly signal: AbortSignal }): Promise<ProviderSendOutcome>;
  /** Optional: what the provider knows about a key. `not_found` must mean it never accepted it. */
  lookup?(idempotencyKey: string, options: ProviderLookupOptions): Promise<ProviderLookupOutcome>;
}

export type ApprovalStanding = "approved" | "revoked" | "missing";

/**
 * D-6: the narrow approval port. Runs inside the worker's service-role transaction, before
 * every attempt, and answers `approved` only while the approval of the action that committed
 * the send event still stands. `contentDigest` lets an implementation bind the exact text.
 */
export interface DeliveryApprovals {
  check(tx: Transaction, input: {
    readonly tenantId: string;
    readonly actionId: string;
    readonly messageId: string;
    readonly contentDigest: string;
  }): Promise<ApprovalStanding>;
}

/** M3b's re-check result (approvals.md A-10), typed by shape so this module needs no import of it. */
export type ApprovalRecordCheck =
  | { readonly kind: "direct" }
  | { readonly kind: "stored"; readonly standing: "pending" | "approved" | "rejected" | "revoked" | "expired" }
  | {
      readonly kind: "standing";
      readonly standing: "pending" | "approved" | "rejected" | "revoked" | "expired";
      readonly current: boolean;
      readonly contentMatches: boolean;
    };

/**
 * The port over M3b's `approvalForAction(tx, tenantId, actionId, now)`. A direct approval (the
 * member or server approved exactly the command it ran) cannot be withdrawn, and the event
 * came from that same action, so it stands. A stored approval stands only while `approved`;
 * revoked, expired and rejected stop delivery; no action, or one still pending, is missing.
 */
export function approvalsFromRecords(
  approvalForAction: (
    tx: Transaction, tenantId: string, actionId: string, now: Date, content?: { messageId: string; contentDigest: string },
  ) => Promise<ApprovalRecordCheck | null>,
  clock: { now(): Date },
): DeliveryApprovals {
  return {
    async check(tx, input) {
      const found = await approvalForAction(tx, input.tenantId, input.actionId, new Date(clock.now().getTime()),
        { messageId: input.messageId, contentDigest: input.contentDigest });
      if (!found) return "missing";
      if (found.kind === "direct") return "approved";
      if (found.kind === "standing") {
        // A-15: a superseded revision or a withdrawn grant is revoked; a changed rendering is not the approved text.
        if (found.standing === "pending") return "missing";
        if (found.standing !== "approved" || !found.current) return "revoked";
        return found.contentMatches ? "approved" : "missing";
      }
      if (found.standing === "approved") return "approved";
      return found.standing === "pending" ? "missing" : "revoked";
    },
  };
}
