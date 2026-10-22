"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isDealChanged, type DealDetailsChange, type DealSummary, type LeadSource } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { LEAD_SOURCE_LABELS, LEAD_SOURCES } from "@/lib/lead-sources";
import { useKeys } from "@/lib/queries";
import { currencyDigits } from "@/lib/utils";

export const STALE_DETAILS_MESSAGE = "Someone changed this deal since you opened it. Reloaded: your changes are kept and theirs fill the rest. Check the details and save again.";
export const DETAILS_RELOAD_FAILED = "Someone changed this deal, but it could not be reloaded. Try again before saving.";

/** "1,250.50" in `currency` to minor units, or null when it is not an amount. Whole numbers and up to the currency's digits only. */
export function parseAmount(text: string, currency: string): number | null {
  // A leading currency sign is fine; a minus sign is not an amount.
  const cleaned = text.replace(/[\s,]/g, "").replace(/^[^\d.+-]+/, "");
  const digits = currencyDigits(currency);
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (match[2] ?? "").length > digits) return null;
  const minor = Number(match[1]) * 10 ** digits + Number((match[2] ?? "").padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatAmountInput(amountMinor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const scale = 10 ** digits;
  return amountMinor % scale === 0 ? String(amountMinor / scale) : (amountMinor / scale).toFixed(digits);
}

/** The amount hint for `currency`: an example with no decimals for a currency that has none. */
export function amountHint(currency: string): string {
  const digits = currencyDigits(currency);
  return digits === 0 ? "Enter a whole amount like 1250." : `Enter an amount like 1250 or 1250.${"50".padEnd(digits, "0")}.`;
}

const isCurrency = (code: string) => {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
};

export interface DetailsForm {
  amount: string;
  currency: string;
  leadSource: string;
}

export const initialForm = (deal: DealSummary): DetailsForm => ({
  amount: deal.value ? formatAmountInput(deal.value.amountMinor, deal.value.currency) : "",
  currency: deal.value?.currency ?? "USD",
  leadSource: deal.leadSource ?? "",
});

/**
 * After a stale save (H-1): each field the owner changed since `base` keeps their edit; every
 * other field takes the saved value someone else wrote. Value and currency move together.
 */
export function rebaseForm(base: DetailsForm, mine: DetailsForm, saved: DetailsForm): DetailsForm {
  const valueEdited = mine.amount !== base.amount || mine.currency !== base.currency;
  return {
    amount: valueEdited ? mine.amount : saved.amount,
    currency: valueEdited ? mine.currency : saved.currency,
    leadSource: mine.leadSource !== base.leadSource ? mine.leadSource : saved.leadSource,
  };
}

/**
 * Value, currency and lead source for one deal (inbox-home.md H-1). It saves against the
 * revision on screen; a stale one reloads the deal, as a stage move does, and asks again.
 */
export function DealDetailsDialog({ deal, open, onOpenChange, onSaved }: {
  deal: DealSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (deal: DealSummary) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const generation = useDialogGeneration(open);
  const [form, setForm] = useState(() => initialForm(deal));
  // What the form was opened (or last rebased) from: a save sends this revision, never a newer
  // one a reload brought in, so a change made elsewhere always comes back as stale_revision.
  const [base, setBase] = useState(() => ({ revision: deal.revision, form: initialForm(deal) }));
  const [rebasing, setRebasing] = useState(false);
  const [problem, setProblem] = useState<"amount" | "currency" | null>(null);
  const [stale, setStale] = useState<"reloaded" | "failed" | null>(null);

  const save = useMutation({
    mutationFn: ({ change }: { change: DealDetailsChange; generation: number }) =>
      api.setDealDetails(change, { idempotencyKey: intents.keyFor(change) }),
    onSettled: (_deal, error, attempt) => intents.settle(attempt.change, error),
    onSuccess: async (updated, attempt) => {
      onSaved?.(updated);
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      if (generation.isCurrent(attempt.generation)) {
        setStale(null);
        onOpenChange(false);
      }
      toast(`Saved the details of ${updated.title}.`);
    },
    onError: async (error, attempt) => {
      if (!isDealChanged(error)) return;
      let reloaded = true;
      try {
        await queryClient.invalidateQueries({ queryKey: keys.dealsAll }, { throwOnError: true });
      } catch {
        reloaded = false;
      }
      if (!generation.isCurrent(attempt.generation)) return;
      setStale(reloaded ? "reloaded" : "failed");
      if (reloaded) setRebasing(true);
    },
  });
  const { reset } = save;

  // Each opening starts from the deal as it is now.
  useEffect(() => {
    if (!open) return;
    reset();
    setForm(initialForm(deal));
    setBase({ revision: deal.revision, form: initialForm(deal) });
    setRebasing(false);
    setProblem(null);
    setStale(null);
    // Only on opening (`deal` is left out on purpose): a reload while open must not wipe what the owner typed.
  }, [open, reset]);

  // After a stale save, once the reloaded deal arrives: keep the owner's edits, take the rest
  // and the new revision from it. The owner saves again to accept the result.
  useEffect(() => {
    if (!open || !rebasing || deal.revision === base.revision) return;
    const saved = initialForm(deal);
    setForm((mine) => rebaseForm(base.form, mine, saved));
    setBase({ revision: deal.revision, form: saved });
    setRebasing(false);
  }, [open, rebasing, deal, base]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const currency = form.currency.trim().toUpperCase();
    let value: DealDetailsChange["value"] = null;
    if (form.amount.trim() !== "") {
      if (!isCurrency(currency)) return setProblem("currency");
      const amountMinor = parseAmount(form.amount, currency);
      if (amountMinor === null) return setProblem("amount");
      value = { amountMinor, currency };
    }
    setProblem(null);
    setStale(null);
    save.mutate({
      change: { dealId: deal.id, expectedRevision: base.revision, value, leadSource: (form.leadSource || null) as LeadSource | null },
      generation: generation.current(),
    });
  };

  const prefix = `deal-${deal.id}`;
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) save.reset(); }}>
      <DialogContent title="Deal details" description={deal.title}>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div>
              <Label htmlFor={`${prefix}-amount`}>Value</Label>
              <Input
                id={`${prefix}-amount`}
                inputMode="decimal"
                placeholder="1250"
                value={form.amount}
                aria-invalid={problem === "amount" || undefined}
                aria-describedby={problem ? `${prefix}-problem ${prefix}-help` : `${prefix}-help`}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor={`${prefix}-currency`}>Currency</Label>
              <Input
                id={`${prefix}-currency`}
                maxLength={3}
                autoCapitalize="characters"
                value={form.currency}
                aria-invalid={problem === "currency" || undefined}
                aria-describedby={problem === "currency" ? `${prefix}-problem` : undefined}
                onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })}
              />
            </div>
          </div>
          {/* Right under the fields it is about, before the general hint. */}
          {problem ? (
            <p id={`${prefix}-problem`} role="alert" className="-mt-2 text-sm text-danger">
              {problem === "amount" ? amountHint(form.currency.trim().toUpperCase()) : "Enter a three-letter currency code such as USD."}
            </p>
          ) : null}
          <p id={`${prefix}-help`} className={problem ? "text-xs text-meta" : "-mt-2 text-xs text-meta"}>Leave the value empty if it is not known yet.</p>
          <div>
            <Label htmlFor={`${prefix}-source`}>Lead source</Label>
            <Select id={`${prefix}-source`} className="w-full" value={form.leadSource} onChange={(event) => setForm({ ...form, leadSource: event.target.value })}>
              <option value="">Not set</option>
              {LEAD_SOURCES.map((source) => <option key={source} value={source}>{LEAD_SOURCE_LABELS[source]}</option>)}
            </Select>
          </div>
          {stale === "reloaded" ? <p role="alert" className="rounded-md bg-accent-tint p-3 text-sm text-fg">{STALE_DETAILS_MESSAGE}</p> : null}
          {stale === "failed" ? (
            <div id={`${prefix}-reload`}>
              <ErrorNote
                error={save.error}
                message={DETAILS_RELOAD_FAILED}
                retry={() => void queryClient.invalidateQueries({ queryKey: keys.dealsAll }, { throwOnError: true }).then(() => {
                  setStale("reloaded");
                  setRebasing(true);
                }, () => undefined)}
              />
            </div>
          ) : null}
          {save.isError && !isDealChanged(save.error) ? <ErrorNote error={save.error} /> : null}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || stale === "failed"} aria-busy={save.isPending} aria-describedby={stale === "failed" ? `${prefix}-reload` : undefined}>
              Save details
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
