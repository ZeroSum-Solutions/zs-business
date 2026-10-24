"use client";

import { ArrowLeft, ArrowRight, Check } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import type { EnrichmentField, EnrichmentProposal } from "@zs/contracts";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { EnrichmentApi, EnrichmentDecision } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey, type IntentKeys } from "@/lib/intent-key";
import { browserZone, useEnrichmentProposals, useKeys } from "@/lib/queries";
import { useCan } from "@/lib/session";
import { formatDay } from "@/lib/time";
import { relativeTime } from "@/lib/utils";

// enrichment.md E-14: every found company detail waits here as an approval. Approving writes it to
// the customer's company details; rejecting drops it. Found values are untrusted text: they render
// as React text only, and a LinkedIn address is shown as text, never as a live link.

/** The same plain labels as the customer page's Company details card. */
export const FIELD_LABEL: Readonly<Record<EnrichmentField, string>> = {
  name: "Company", domain: "Website", industry: "Industry", description: "About", employees: "Employees",
  founded: "Founded", location: "Location", linkedin_url: "LinkedIn",
};

export interface DecideOutcome {
  done: string[];
  failed: Map<string, unknown>;
}

/**
 * Decide proposals one at a time, each with its own idempotency key, and keep going past a
 * failure. A lost answer keeps that proposal's key, so a retry replays instead of deciding twice.
 */
export async function decideProposals(
  api: Pick<EnrichmentApi, "decideEnrichmentProposal">,
  approvalIds: readonly string[],
  decision: EnrichmentDecision,
  intents: IntentKeys,
): Promise<DecideOutcome> {
  const outcome: DecideOutcome = { done: [], failed: new Map() };
  for (const approvalId of approvalIds) {
    const intent = { approvalId, decision };
    try {
      await api.decideEnrichmentProposal(approvalId, decision, { idempotencyKey: intents.keyFor(intent) });
      intents.settle(intent);
      outcome.done.push(approvalId);
    } catch (error) {
      intents.settle(intent, error);
      outcome.failed.set(approvalId, error);
    }
  }
  return outcome;
}

interface Group {
  contactId: string;
  contactName: string;
  items: EnrichmentProposal[];
}

/** One group per customer, in the order each customer first appears (the list is oldest first). */
function groupByContact(proposals: readonly EnrichmentProposal[]): Group[] {
  const groups = new Map<string, Group>();
  for (const proposal of proposals) {
    const group = groups.get(proposal.contactId) ?? { contactId: proposal.contactId, contactName: proposal.contactName, items: [] };
    group.items.push(proposal);
    groups.set(proposal.contactId, group);
  }
  return [...groups.values()];
}

const WEEK_MS = 7 * 86_400_000;

function source(proposal: EnrichmentProposal): string {
  const by = proposal.provider === "treg" ? "Treg" : proposal.provider;
  const when = Date.now() - Date.parse(proposal.fetchedAt) < WEEK_MS
    ? relativeTime(proposal.fetchedAt).toLowerCase()
    : formatDay(proposal.fetchedAt, browserZone());
  return `Found by ${by}, ${when}`;
}

const nameOf = (proposal: EnrichmentProposal) => proposal.contactName.trim() || "this customer";
const what = (proposal: EnrichmentProposal) => `${FIELD_LABEL[proposal.field]} for ${nameOf(proposal)}`;

/** A 44px tap target around a 20px box. The real checkbox fills the target, so focus and taps land on it. */
function Tick({ checked, onChange, disabled, label, children }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 text-sm font-medium text-fg-2 has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <span className="relative grid size-11 shrink-0 place-items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-md disabled:cursor-not-allowed"
        />
        <span aria-hidden className="pointer-events-none grid size-5 place-items-center rounded-sm bg-surface text-transparent shadow-[inset_0_0_0_1.5px_var(--border-strong)] peer-checked:bg-accent peer-checked:text-accent-on peer-checked:shadow-none">
          <Check size={14} weight="bold" />
        </span>
      </span>
      {children}
    </label>
  );
}

export function EnrichmentProposals() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const canDecide = useCan("enrich");
  const list = useEnrichmentProposals();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  // One decision run at a time, however fast the taps come.
  const running = useRef(false);

  const proposals = list.data ?? [];
  const ids = new Set(proposals.map((proposal) => proposal.approvalId));
  // A proposal decided elsewhere drops out of the selection with the refreshed list.
  const selected = proposals.filter((proposal) => chosen.has(proposal.approvalId));
  const deciding = busy.size > 0;

  async function decide(targets: EnrichmentProposal[], decision: EnrichmentDecision) {
    if (running.current || targets.length === 0) return;
    running.current = true;
    const targetIds = targets.map((proposal) => proposal.approvalId);
    setBusy(new Set(targetIds));
    setErrors((previous) => new Map([...previous].filter(([id]) => !targetIds.includes(id))));
    try {
      const outcome = await decideProposals(api, targetIds, decision, intents);
      setErrors((previous) => new Map([...previous, ...outcome.failed]));
      setChosen((previous) => new Set([...previous].filter((id) => !outcome.done.includes(id))));
      const done = targets.filter((proposal) => outcome.done.includes(proposal.approvalId));
      if (done.length > 0) {
        const verb = decision === "approve" ? "Approved" : "Rejected";
        const first = done[0]!;
        const message = targets.length === 1
          ? decision === "approve" ? `Added ${FIELD_LABEL[first.field]} to ${nameOf(first)}'s company details.` : `Rejected ${what(first)}.`
          : `${verb} ${done.length} of ${targets.length} details.`;
        toast(message, outcome.failed.size > 0 ? "info" : "success");
      }
      const contacts = new Set(done.map((proposal) => proposal.contactId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.enrichmentProposals }),
        ...[...contacts].map((contactId) => queryClient.invalidateQueries({ queryKey: keys.contactEnrichment(contactId) })),
      ]);
    } finally {
      running.current = false;
      setBusy(new Set());
    }
  }

  const allChosen = proposals.length > 0 && selected.length === proposals.length;

  return (
    <>
      <Link href="/customers" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm font-medium text-muted hover:text-fg">
        <ArrowLeft size={16} aria-hidden /> Customers
      </Link>
      <PageHeader
        title="Company details to review"
        description={canDecide
          ? "Details found by a company lookup. Nothing changes on a customer until you approve it."
          : "Details found by a company lookup. An owner approves or rejects each detail before it is added to a customer."}
      />
      {list.isPending ? <LoadingRows rows={3} label="Loading company details to review" /> : list.isError ? (
        <ErrorNote error={list.error} retry={() => list.refetch()} />
      ) : proposals.length === 0 ? (
        <EmptyState title="Nothing to review. New company details appear here after a lookup." />
      ) : (
        <div className="space-y-4">
          {canDecide ? (
            <div className="tray flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-1.5 lg:px-3">
              <Tick
                checked={allChosen}
                disabled={deciding}
                onChange={(checked) => setChosen(checked ? new Set(ids) : new Set())}
              >
                Select all
              </Tick>
              <p id="enrichment-batch-hint" className="min-w-0 flex-1 text-sm text-muted" aria-live="polite">
                {selected.length === 0 ? "Select details to decide them together." : `${selected.length} selected`}
              </p>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <Button
                  className="flex-1 sm:flex-none"
                  disabled={deciding || selected.length === 0}
                  aria-describedby="enrichment-batch-hint"
                  onClick={() => void decide(selected, "approve")}
                >
                  Approve selected
                </Button>
                <Button
                  className="flex-1 sm:flex-none"
                  variant="secondary"
                  disabled={deciding || selected.length === 0}
                  aria-describedby="enrichment-batch-hint"
                  onClick={() => void decide(selected, "reject")}
                >
                  Reject selected
                </Button>
              </div>
            </div>
          ) : null}
          {groupByContact(proposals).map((group) => {
            const titleId = `enrichment-${group.contactId}`;
            return (
              <Card key={group.contactId} aria-labelledby={titleId} data-testid="enrichment-group">
                <CardHeader className="mb-2">
                  <CardTitle id={titleId} className="min-w-0 break-words">
                    <Link href={`/customers/${group.contactId}`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                      {group.contactName.trim() || "Unnamed customer"}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-border-soft">
                  {group.items.map((proposal) => {
                    const rowBusy = busy.has(proposal.approvalId);
                    const error = errors.get(proposal.approvalId);
                    return (
                      <li key={proposal.approvalId} data-testid="enrichment-proposal" className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start gap-2">
                          {canDecide ? (
                            <div className="-ml-3 -mt-2.5">
                              <Tick
                                label={`Select ${what(proposal)}`}
                                checked={chosen.has(proposal.approvalId)}
                                disabled={deciding}
                                onChange={(checked) => setChosen((previous) => {
                                  const next = new Set(previous);
                                  if (checked) next.add(proposal.approvalId);
                                  else next.delete(proposal.approvalId);
                                  return next;
                                })}
                              />
                            </div>
                          ) : null}
                          <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-4">
                            <div className="min-w-0">
                              <p className="text-xs text-meta">{FIELD_LABEL[proposal.field]}</p>
                              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
                                <span className={proposal.currentValue === null ? "text-muted italic" : "break-words text-muted line-through decoration-border-strong"}>
                                  {proposal.currentValue ?? "Empty"}
                                </span>
                                <ArrowRight size={14} aria-hidden className="shrink-0 self-center text-meta" />
                                <span className="sr-only">changes to</span>
                                <span className="min-w-0 font-bold break-words text-fg">{proposal.proposedValue}</span>
                              </p>
                              <p className="mt-0.5 text-xs text-meta">{source(proposal)}</p>
                            </div>
                            {canDecide ? (
                              <div className="mt-2 flex gap-2 sm:mt-0 sm:shrink-0">
                                <Button
                                  variant="secondary"
                                  className="flex-1 sm:flex-none"
                                  disabled={deciding}
                                  aria-busy={rowBusy}
                                  aria-label={`Approve ${what(proposal)}`}
                                  onClick={() => void decide([proposal], "approve")}
                                >
                                  Approve
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="flex-1 sm:flex-none"
                                  disabled={deciding}
                                  aria-busy={rowBusy}
                                  aria-label={`Reject ${what(proposal)}`}
                                  onClick={() => void decide([proposal], "reject")}
                                >
                                  Reject
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        {error !== undefined ? <div className="mt-2"><ErrorNote error={error} /></div> : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
