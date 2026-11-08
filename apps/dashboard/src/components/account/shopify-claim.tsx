"use client";

import { CheckCircle, Clock, LinkSimple, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSampleOnly } from "@/components/ui/sample";
import { useToast } from "@/components/ui/toast";
import {
  CLAIM_LINKED_MESSAGE,
  CLAIM_STARTED_MESSAGE,
  CONFIRM_MESSAGES,
  ClaimsUnavailable,
  cancelClaim,
  confirmClaim,
  getClaim,
  groupCode,
  startClaim,
} from "@/lib/shopify-claims";
import { useKeys } from "@/lib/queries";

/** How often the open claim is read while the owner waits for the store to enter the code. */
export const CLAIM_POLL_MS = 5_000;

/**
 * Linking a store installed from the Shopify App Store to this hub (connections.md C-22), for owners. The code shows
 * once, right after it is made; a reload shows the claim's state but not the code. Nothing links until the owner
 * confirms the store the merchant entered it from. Live app only, and absent when the server has no native tier.
 */
export function ShopifyClaim() {
  const live = useSampleOnly();
  const api = useClaimState(live);
  const [shown, setShown] = useState<{ claimId: string; code: string } | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { keys } = useKeys();

  const start = useMutation({
    mutationFn: startClaim,
    onSuccess: (result) => {
      if (result.kind === "started") {
        setShown({ claimId: result.claimId, code: result.code });
        setMessage(null);
      } else {
        setMessage({ tone: "info", text: CONFIRM_MESSAGES.tenant_has_store! });
      }
    },
    onError: () => setMessage({ tone: "error", text: "We could not start the link. Try again in a minute." }),
    onSettled: () => api.refetch(),
  });
  const confirm = useMutation({
    mutationFn: (id: string) => confirmClaim(id),
    onSuccess: async (result) => {
      if (result.kind === "confirmed") {
        setShown(null);
        setMessage(null);
        toast(CLAIM_LINKED_MESSAGE, "info");
        await queryClient.invalidateQueries({ queryKey: keys.managedConnections });
      } else {
        setMessage({ tone: "error", text: CONFIRM_MESSAGES[result.reason] ?? CONFIRM_MESSAGES.not_found! });
      }
    },
    onError: () => setMessage({ tone: "error", text: "We could not confirm the link. Try again in a minute." }),
    onSettled: () => api.refetch(),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelClaim(id),
    onSuccess: () => { setShown(null); setMessage(null); },
    onError: () => setMessage({ tone: "error", text: "We could not cancel the link. Try again in a minute." }),
    onSettled: () => api.refetch(),
  });

  if (!live || api.unavailable || api.isPending) return null;
  const claim = api.data ?? null;
  const busy = start.isPending || confirm.isPending || cancel.isPending;

  return (
    <section aria-labelledby="shopify-claim-title" data-testid="shopify-claim" className="mb-4 rounded-md bg-inset p-4">
      <h3 id="shopify-claim-title" className="flex items-center gap-2 text-sm font-bold text-fg">
        <LinkSimple size={18} aria-hidden className="text-muted" />Installed from the Shopify App Store?
      </h3>
      {claim === null ? (
        <>
          <p className="mt-1 text-sm text-fg-2">Link that store to this hub. You make a code here and enter it in the app, inside your Shopify admin.</p>
          <div className="mt-3">
            <Button onClick={() => start.mutate()} disabled={busy} aria-busy={start.isPending}>
              <LinkSimple aria-hidden />{start.isPending ? "Making a code…" : "Link a Shopify store"}
            </Button>
          </div>
        </>
      ) : claim.status === "open" ? (
        <>
          {shown !== null && shown.claimId === claim.id ? (
            <>
              <p className="mt-1 text-sm text-fg-2" data-testid="shopify-claim-help">{CLAIM_STARTED_MESSAGE}</p>
              <p className="mt-3 text-2xl font-extrabold tracking-[0.12em] text-fg" data-testid="shopify-claim-code" aria-label={`Code ${shown.code.split("").join(" ")}`}>
                {groupCode(shown.code)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-fg-2">A code is waiting for the store. We showed it once. To get a new one, cancel this link and start again.</p>
          )}
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-fg-2" data-testid="shopify-claim-waiting">
            <Clock size={16} aria-hidden className="shrink-0 text-muted" />Waiting for the store to enter the code.
          </p>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => cancel.mutate(claim.id)} disabled={busy}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm font-bold text-fg break-words" data-testid="shopify-claim-store">
            {claim.shop ? `${claim.shop.name} (${claim.shop.domain})` : "A store"} entered your code.
          </p>
          <p className="mt-1 text-sm text-fg-2">Check that this is your store. If you do not know it, choose Cancel.</p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => cancel.mutate(claim.id)} disabled={busy}>Cancel</Button>
            <Button onClick={() => confirm.mutate(claim.id)} disabled={busy} aria-busy={confirm.isPending}>
              <CheckCircle aria-hidden />{confirm.isPending ? "Linking…" : "Confirm link"}
            </Button>
          </div>
        </>
      )}
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className="mt-3 flex items-start gap-2 text-sm text-fg-2" data-testid="shopify-claim-message">
          <WarningCircle size={16} aria-hidden className="mt-px shrink-0 text-warn" />{message.text}
        </p>
      ) : null}
    </section>
  );
}

/** True once the server answered the claim route, which exists only with the native Shopify tier (C-18). */
export function useNativeShopify(enabled: boolean): { native: boolean; pending: boolean } {
  const live = useSampleOnly();
  const claim = useClaimState(live && enabled);
  // The claim route is only ever read on the live app; a cached answer (success) is what says the native tier is on.
  return { native: claim.isSuccess, pending: live && enabled && claim.isPending };
}

function useClaimState(live: boolean) {
  const { keys, enabled } = useKeys();
  const query = useQuery({
    enabled: enabled && live,
    queryKey: keys.shopifyClaim,
    queryFn: ({ signal }) => getClaim(signal),
    staleTime: 0,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ClaimsUnavailable) && count < 2,
    // Read again while a claim is open so the card moves on when the store enters the code.
    refetchInterval: (state) => (state.state.data?.status === "open" ? CLAIM_POLL_MS : false),
  });
  return Object.assign(query, { unavailable: query.error instanceof ClaimsUnavailable });
}
