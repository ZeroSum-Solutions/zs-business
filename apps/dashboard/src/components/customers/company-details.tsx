"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EnrichmentRequestRecord } from "@zs/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useContactEnrichment, useKeys } from "@/lib/queries";
import { useCan } from "@/lib/session";

// enrichment.md E-14, E-17. Found details never edit the customer: each one waits as an approval.
const ROWS = [
  ["Company", "companyName"], ["Website", "companyDomain"], ["Industry", "companyIndustry"],
  ["Employees", "companyEmployees"], ["Founded", "companyFounded"], ["Location", "companyLocation"],
  ["LinkedIn", "companyLinkedinUrl"], ["About", "companyDescription"],
] as const;

const RUNNING = new Set(["pending", "leased", "uncertain"]);
/** What a settled request tells the owner, in plain words. */
const OUTCOME: Readonly<Record<string, string>> = {
  succeeded: "Details found. Each one waits for an owner's approval before it is added.",
  no_match: "No company details found for this address.",
  rejected: "The lookup was not accepted. You were not charged.",
  failed: "The lookup did not work. You were not charged.",
  blocked: "Company details are off for this customer.",
  insufficient_funds: "Your balance was too low for a lookup. Add funds, then try again.",
  daily_cap: "You reached today's limit on lookups.",
  answer_lost: "The answer was lost. You were not charged. Try again.",
  region_blocked_after_call: "This customer turned out to be in the EU or UK, so nothing was kept. You were not charged.",
  dead: "The lookup could not finish. The few cents for it stay held until it is sorted out.",
};

export function CompanyDetails({ contactId }: { contactId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const canAsk = useCan("enrich");
  const read = useContactEnrichment(contactId);
  const intents = useIntentKey();
  const ask = useMutation({
    mutationFn: () => api.requestEnrichment(contactId, { idempotencyKey: intents.keyFor({ contactId, run: read.data?.requests[0]?.id ?? null }) }),
    onSettled: (_result, error) => intents.settle({ contactId, run: read.data?.requests[0]?.id ?? null }, error),
    // Returned, so the button stays busy until the refreshed list shows the new request.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.contactEnrichment(contactId) }),
  });

  const latest: EnrichmentRequestRecord | undefined = read.data?.requests[0];
  const running = latest !== undefined && RUNNING.has(latest.status);
  const profile = read.data?.profile ?? null;
  const filled = profile === null ? [] : ROWS.filter(([, key]) => profile[key] !== null && profile[key] !== undefined);

  return (
    <Card aria-labelledby="company-title">
      <CardHeader>
        <CardTitle id="company-title">Company details</CardTitle>
        {canAsk ? (
          <Button size="default" variant="secondary" disabled={running || ask.isPending} aria-busy={ask.isPending || running} onClick={() => ask.mutate()}>
            {running ? "Looking up" : "Look up company"}
          </Button>
        ) : null}
      </CardHeader>
      {read.isPending ? <LoadingRows rows={2} label="Loading company details" /> : read.isError ? (
        <ErrorNote error={read.error} retry={() => read.refetch()} />
      ) : (
        <div className="space-y-3">
          {ask.isError ? <ErrorNote error={ask.error} retry={() => ask.mutate()} /> : null}
          {latest ? (
            <p role="status" className="text-sm text-muted">
              {running ? "Looking for this company. This can take a minute." : OUTCOME[latest.status] ?? "The lookup ended."}
                          </p>
          ) : (
            <p className="text-sm text-muted">{canAsk ? "Look up the company behind this customer's email address. Each lookup costs a few cents." : "No company details yet. An owner can look them up."}</p>
          )}
          {profile?.doNotEnrichAt ? <Badge tone="danger">Lookups off for this customer</Badge> : null}
          {filled.length > 0 && profile !== null ? (
            <dl className="divide-y divide-border-soft">
              {filled.map(([label, key]) => (
                <div key={key} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <dt className="text-xs text-meta">{label}</dt>
                  <dd className="text-right text-sm break-words text-fg">{String(profile[key])}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      )}
    </Card>
  );
}
