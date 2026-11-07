"use client";

import { Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { CURRENCIES, currencyLabel, isActiveCurrencyCode } from "@zs/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/sample";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { DealDetailsChange, DealValue, NewDeal, ZsApi } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { useBusinessProfile, useKeys, usePipelines, useSetup } from "@/lib/queries";
import { dealTarget } from "@/lib/setup";
import { amountHint, FALLBACK_CURRENCY, parseAmount } from "./deal-details-dialog";

export const NO_PIPELINE_REASON = "There is no pipeline for deals yet. An owner adds one in Setup.";
export const PIPELINES_NOT_LOADED = "Your pipelines didn't load, so a deal can't be added. Reload the page to try again.";
export const VALUE_NOT_SAVED = "The deal was added, but its value was not saved. Add the value in the deal's details.";

/**
 * industry-templates.md IT-10: a new deal goes into the first stage that is neither won nor lost.
 * The create takes no value (crm.deal.create), so a value is saved next with the deal's details.
 * Answers the deal, and the error of the value step when only that step failed.
 */
export async function createDealWithValue(
  api: Pick<ZsApi, "createDeal" | "setDealDetails">,
  input: NewDeal,
  value: DealValue | null,
  keyFor: (payload: unknown) => string,
): Promise<{ title: string; valueError: unknown }> {
  const deal = await api.createDeal(input, { idempotencyKey: keyFor(input) });
  if (!value) return { title: deal.title, valueError: null };
  const change: DealDetailsChange = { dealId: deal.id, expectedRevision: deal.revision, value, leadSource: null };
  try {
    await api.setDealDetails(change, { idempotencyKey: keyFor(change) });
    return { title: deal.title, valueError: null };
  } catch (error) {
    return { title: deal.title, valueError: error };
  }
}

/** "New deal" on a customer's page, disabled with the reason shown while there is no pipeline to put it in. */
export function NewDealButton({ contactId }: { contactId: string }) {
  const pipelines = usePipelines();
  const setup = useSetup();
  const [open, setOpen] = useState(false);
  // Without a setup read (an older API) the business's first pipeline still takes the deal.
  const target = pipelines.data ? dealTarget(pipelines.data, setup.data?.applied?.pipelineId) : null;
  // Disabled only with a visible reason; while the pipelines load it is busy instead.
  const reason = pipelines.isError ? PIPELINES_NOT_LOADED : pipelines.isSuccess && target === null ? NO_PIPELINE_REASON : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={target === null}
        aria-busy={pipelines.isPending || undefined}
        aria-describedby={reason ? "new-deal-reason" : undefined}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden />New deal
      </Button>
      {reason ? <DisabledReason id="new-deal-reason">{reason}</DisabledReason> : null}
      {target ? <NewDealDialog contactId={contactId} target={target} open={open} onOpenChange={setOpen} /> : null}
    </div>
  );
}

function NewDealDialog({ contactId, target, open, onOpenChange }: {
  contactId: string;
  target: { pipelineId: string; stageId: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const generation = useDialogGeneration(open);
  const profile = useBusinessProfile();
  const profileCurrency = profile.data && isActiveCurrencyCode(profile.data.currency) ? profile.data.currency : FALLBACK_CURRENCY;
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string | null>(null);
  const [problem, setProblem] = useState<"title" | "amount" | null>(null);
  const shownCurrency = currency ?? profileCurrency;

  const create = useMutation({
    mutationFn: ({ input, value }: { input: NewDeal; value: DealValue | null; generation: number }) =>
      createDealWithValue(api, input, value, (payload) => intents.keyFor(payload)),
    onSettled: (_result, error, attempt) => intents.settle(attempt.input, error),
    onSuccess: async (result, attempt) => {
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      if (generation.isCurrent(attempt.generation)) onOpenChange(false);
      if (result.valueError) toast(VALUE_NOT_SAVED, "danger");
      else toast(`Added the deal ${result.title}.`);
    },
  });
  const { reset } = create;

  useEffect(() => {
    if (!open) return;
    reset();
    setTitle("");
    setAmount("");
    setCurrency(null);
    setProblem(null);
  }, [open, reset]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setProblem("title");
    let value: DealValue | null = null;
    if (amount.trim() !== "") {
      const amountMinor = parseAmount(amount, shownCurrency);
      if (amountMinor === null) return setProblem("amount");
      value = { amountMinor, currency: shownCurrency };
    }
    setProblem(null);
    create.mutate({ input: { contactId, pipelineId: target.pipelineId, stageId: target.stageId, title: name }, value, generation: generation.current() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) create.reset(); }}>
      <DialogContent title="New deal" description="It starts in the first stage of your pipeline.">
        <form onSubmit={submit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="new-deal-title">Title</Label>
            <Input
              id="new-deal-title"
              maxLength={200}
              value={title}
              aria-invalid={problem === "title" || undefined}
              aria-describedby={problem === "title" ? "new-deal-problem" : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] gap-3">
            <div>
              <Label htmlFor="new-deal-amount">Value (optional)</Label>
              <Input
                id="new-deal-amount"
                inputMode="decimal"
                placeholder="1250"
                value={amount}
                aria-invalid={problem === "amount" || undefined}
                aria-describedby={problem === "amount" ? "new-deal-problem new-deal-help" : "new-deal-help"}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="new-deal-currency">Currency</Label>
              <Select id="new-deal-currency" className="w-full" value={shownCurrency} onChange={(event) => setCurrency(event.target.value)}>
                {CURRENCIES.filter((item) => isActiveCurrencyCode(item.code)).map((item) => <option key={item.code} value={item.code}>{currencyLabel(item.code)}</option>)}
              </Select>
            </div>
          </div>
          {problem ? (
            <p id="new-deal-problem" role="alert" className="-mt-2 text-sm text-danger">
              {problem === "title" ? "Give the deal a title." : amountHint(shownCurrency)}
            </p>
          ) : null}
          <p id="new-deal-help" className={problem ? "text-xs text-meta" : "-mt-2 text-xs text-meta"}>Leave the value empty if it is not known yet.</p>
          {create.isError ? <ErrorNote error={create.error} /> : null}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>Add deal</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
