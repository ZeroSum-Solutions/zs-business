"use client";

import { ArrowLeft, ArrowRight, Check, Minus } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import type { EnrichmentField, EnrichmentProposal } from "@zs/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type EnrichmentApi, type EnrichmentDecision } from "@/lib/api";
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
  contactName: string | null;
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

const nameOf = (proposal: EnrichmentProposal) => proposal.contactName?.trim() || "this customer";
const what = (proposal: EnrichmentProposal) => `${FIELD_LABEL[proposal.field]} for ${nameOf(proposal)}`;
const reasonOf = (error: unknown) => (isApiError(error) ? error.message : "Something went wrong. Try again.");

export interface DecisionToast {
  message: string;
  tone: "success" | "info" | "danger";
}

/**
 * What the toast says after a decision. A failure is named here as well as on its row: the refresh
 * that follows drops a proposal decided elsewhere or expired, and its row with it.
 */
export function decisionToast(targets: readonly EnrichmentProposal[], outcome: DecideOutcome, decision: EnrichmentDecision): DecisionToast | null {
  const done = targets.filter((proposal) => outcome.done.includes(proposal.approvalId));
  const firstFailure = targets.find((proposal) => outcome.failed.has(proposal.approvalId));
  if (targets.length === 1) {
    const [only] = targets as [EnrichmentProposal];
    if (firstFailure) return { message: `${what(only)}: ${reasonOf(outcome.failed.get(only.approvalId))}`, tone: "danger" };
    if (done.length === 0) return null;
    return {
      message: decision === "approve" ? `Added ${FIELD_LABEL[only.field]} to ${nameOf(only)}'s company details.` : `Rejected ${what(only)}.`,
      tone: "success",
    };
  }
  const verb = decision === "approve" ? "Approved" : "Rejected";
  if (!firstFailure) return done.length > 0 ? { message: `${verb} ${done.length} details.`, tone: "success" } : null;
  const reason = reasonOf(outcome.failed.get(firstFailure.approvalId));
  if (done.length === 0) return { message: `None of the ${targets.length} details were decided: ${reason}`, tone: "danger" };
  return { message: `${verb} ${done.length} of ${targets.length} details. ${outcome.failed.size} were not decided: ${reason}`, tone: "info" };
}

/** A 44px tap target around a 20px box. The real checkbox fills the target, so focus and taps land on it. */
function Tick({ checked, mixed = false, onChange, disabled, label, children }: {
  checked: boolean;
  /** Some but not all rows chosen: the box shows a dash and reads as "mixed". */
  mixed?: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 text-sm font-medium text-fg-2 has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <span className="relative grid size-11 shrink-0 place-items-center">
        <input
          ref={input}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-md disabled:cursor-not-allowed"
        />
        <span aria-hidden className="pointer-events-none grid size-5 place-items-center rounded-[6px] bg-surface text-transparent shadow-[inset_0_0_0_1.5px_var(--border-strong)] peer-checked:bg-accent peer-checked:text-accent-on peer-checked:shadow-none peer-indeterminate:bg-accent peer-indeterminate:text-accent-on peer-indeterminate:shadow-none">
          {mixed ? <Minus size={14} weight="bold" /> : <Check size={14} weight="bold" />}
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
  const [busy, setBusy] = useState<{ ids: ReadonlySet<string>; decision: EnrichmentDecision } | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  // One decision run at a time, however fast the taps come.
  const running = useRef(false);

  const proposals = list.data ?? [];
  // Only a pending proposal can be chosen: an approved one that was not added can only be retried.
  const choosable = proposals.filter((proposal) => proposal.status === "pending");
  const ids = new Set(choosable.map((proposal) => proposal.approvalId));
  // A proposal decided elsewhere drops out of the selection with the refreshed list.
  const selected = choosable.filter((proposal) => chosen.has(proposal.approvalId));
  const deciding = busy !== null;

  async function decide(targets: EnrichmentProposal[], decision: EnrichmentDecision) {
    if (running.current || targets.length === 0) return;
    running.current = true;
    const targetIds = targets.map((proposal) => proposal.approvalId);
    setBusy({ ids: new Set(targetIds), decision });
    setErrors((previous) => new Map([...previous].filter(([id]) => !targetIds.includes(id))));
    try {
      const outcome = await decideProposals(api, targetIds, decision, intents);
      setErrors((previous) => new Map([...previous, ...outcome.failed]));
      setChosen((previous) => new Set([...previous].filter((id) => !outcome.done.includes(id))));
      const said = decisionToast(targets, outcome, decision);
      if (said) toast(said.message, said.tone);
      // Every customer tried, not only the ones that answered: a lost answer may still have applied.
      const contacts = new Set(targets.map((proposal) => proposal.contactId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.enrichmentProposals }),
        ...[...contacts].map((contactId) => queryClient.invalidateQueries({ queryKey: keys.contactEnrichment(contactId) })),
      ]);
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  const allChosen = choosable.length > 0 && selected.length === choosable.length;

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
                mixed={selected.length > 0 && !allChosen}
                disabled={deciding || choosable.length === 0}
                onChange={(checked) => setChosen(checked ? new Set(ids) : new Set())}
              >
                Select all
              </Tick>
              <p id="enrichment-batch-hint" className="min-w-0 flex-1 text-sm text-muted" aria-live="polite">
                {selected.length === 0 ? "Select details to decide them together." : `${selected.length} selected`}
              </p>
              {selected.length > 0 ? <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <Button
                  className="flex-1 sm:flex-none"
                  disabled={deciding}
                  aria-describedby="enrichment-batch-hint"
                  onClick={() => void decide(selected, "approve")}
                >
                  Approve selected
                </Button>
                <Button
                  className="flex-1 sm:flex-none"
                  variant="secondary"
                  disabled={deciding}
                  aria-describedby="enrichment-batch-hint"
                  onClick={() => void decide(selected, "reject")}
                >
                  Reject selected
                </Button>
              </div> : null}
            </div>
          ) : null}
          {groupByContact(proposals).map((group) => {
            const titleId = `enrichment-${group.contactId}`;
            return (
              <Card key={group.contactId} aria-labelledby={titleId} data-testid="enrichment-group">
                <CardHeader className="mb-2">
                  <CardTitle id={titleId} className="min-w-0 break-words">
                    <Link href={`/customers/${group.contactId}`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                      {group.contactName?.trim() || "Unnamed customer"}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-border-soft">
                  {group.items.map((proposal) => {
                    const rowBusy = busy?.ids.has(proposal.approvalId) ?? false;
                    const pressed = rowBusy ? busy?.decision : undefined;
                    const unapplied = proposal.status === "approved";
                    const error = errors.get(proposal.approvalId);
                    return (
                      <li key={proposal.approvalId} data-testid="enrichment-proposal" className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start gap-2">
                          {canDecide && unapplied ? <div aria-hidden className="w-8 shrink-0" /> : null}
                          {canDecide && !unapplied ? (
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
                              <p className="text-xs font-medium text-fg-2">{FIELD_LABEL[proposal.field]}</p>
                              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm">
                                <span className={proposal.currentValue === null ? "text-muted italic" : "break-words text-muted line-through decoration-meta"}>
                                  {proposal.currentValue ?? "Empty"}
                                </span>
                                {/* The arrow wraps with the new value, never alone at a line end. */}
                                <span className="inline-flex min-w-0 items-baseline gap-2">
                                  <ArrowRight size={14} aria-hidden className="shrink-0 self-center text-meta" />
                                  <span className="sr-only">changes to</span>
                                  <span className="min-w-0 font-bold break-words text-fg">{proposal.proposedValue}</span>
                                </span>
                              </p>
                              <p className="mt-0.5 text-xs text-meta">{source(proposal)}</p>
                              {unapplied ? (
                                <p className="mt-1 text-sm text-fg-2">Approved, but not added yet. Try again to add it.</p>
                              ) : null}
                            </div>
                            {canDecide && unapplied ? (
                              <div className="mt-2 flex gap-2 sm:mt-0 sm:shrink-0">
                                <Button
                                  variant="secondary"
                                  disabled={deciding}
                                  aria-busy={rowBusy}
                                  aria-label={`Add ${what(proposal)} again`}
                                  onClick={() => void decide([proposal], "approve")}
                                >
                                  {pressed === "approve" ? "Adding…" : "Try again"}
                                </Button>
                              </div>
                            ) : null}
                            {canDecide && !unapplied ? (
                              <div className="mt-2 flex gap-2 sm:mt-0 sm:shrink-0">
                                <Button
                                  variant="secondary"
                                  disabled={deciding}
                                  aria-busy={rowBusy}
                                  aria-label={`Approve ${what(proposal)}`}
                                  onClick={() => void decide([proposal], "approve")}
                                >
                                  {pressed === "approve" ? "Approving…" : "Approve"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  disabled={deciding}
                                  aria-busy={rowBusy}
                                  aria-label={`Reject ${what(proposal)}`}
                                  onClick={() => void decide([proposal], "reject")}
                                >
                                  {pressed === "reject" ? "Rejecting…" : "Reject"}
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
