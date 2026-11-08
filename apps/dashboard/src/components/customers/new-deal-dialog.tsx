"use client";

import { Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { CURRENCIES, currencyLabel, isActiveCurrencyCode } from "@zs/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { DealDetailsChange, DealValue, NewDeal, ZsApi } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { useBusinessProfile, useKeys, usePipelines, useSetup } from "@/lib/queries";
import { dealTarget } from "@/lib/setup";
import { amountHint, businessCurrency, FALLBACK_CURRENCY, parseAmount } from "./deal-details-dialog";

export const NO_PIPELINE_REASON = "There is no pipeline for deals yet. An owner adds one in Setup.";
export const NO_OPEN_STAGE_REASON = "The pipeline has no open stage for a new deal. Add a stage that is not Won or Lost in the pipeline.";
export const PIPELINES_NOT_LOADED = "Your pipelines didn't load, so a deal can't be added. Reload the page to try again.";
export const SETUP_NOT_LOADED = "Your setup didn't load, so a deal can't be added yet. Reload the page to try again.";
export const VALUE_NOT_SAVED = "The deal was added, but its value was not saved. Save the value again, or add it later in the deal's details.";
export const CHOOSE_CURRENCY = "Choose a currency for the value.";

/**
 * IT-10: a value needs the business's currency or one the owner picked, never a guessed USD. An empty
 * amount is no value; a typed amount with no known currency is the `currency` problem.
 */
export function dealValueFor(
  amount: string,
  currencyKnown: boolean,
  currency: string,
): { value: DealValue | null } | { problem: "currency" | "amount" } {
  if (amount.trim() === "") return { value: null };
  if (!currencyKnown) return { problem: "currency" };
  const amountMinor = parseAmount(amount, currency);
  if (amountMinor === null) return { problem: "amount" };
  return { value: { amountMinor, currency } };
}

/** The deal a failed value step left behind, so a retry saves the value and never adds a second deal. */
export interface CreatedDeal { id: string; revision: number; title: string }

/**
 * industry-templates.md IT-10: a new deal goes into the first stage that is neither won nor lost.
 * The create takes no value (crm.deal.create), so a value is saved next with the deal's details.
 * Answers the deal, and the error of the value step when only that step failed. With `created`
 * (the deal of an earlier attempt whose value step failed) only the value step runs again.
 */
export async function createDealWithValue(
  api: Pick<ZsApi, "createDeal" | "setDealDetails">,
  input: NewDeal,
  value: DealValue | null,
  keyFor: (payload: unknown) => string,
  created: CreatedDeal | null = null,
  settle: (payload: unknown, error?: unknown) => void = () => undefined,
): Promise<{ deal: CreatedDeal; valueError: unknown }> {
  const deal: CreatedDeal = created ?? await api.createDeal(input, { idempotencyKey: keyFor(input) })
    .then((made) => ({ id: made.id, revision: made.revision, title: made.title }));
  if (!value) return { deal, valueError: null };
  const change: DealDetailsChange = { dealId: deal.id, expectedRevision: deal.revision, value, leadSource: null };
  try {
    await api.setDealDetails(change, { idempotencyKey: keyFor(change) });
    settle(change);
    return { deal, valueError: null };
  } catch (error) {
    settle(change, error);
    return { deal, valueError: error };
  }
}

/** "New deal" on a customer's page, disabled with the reason shown while there is no pipeline to put it in. */
export function NewDealButton({ contactId }: { contactId: string }) {
  const pipelines = usePipelines();
  const setup = useSetup();
  const [open, setOpen] = useState(false);
  // The pipeline depends on the setup read: wait for it, and never guess on a failure. The first
  // pipeline stands in only when setup definitively says no template was applied.
  const ready = pipelines.isSuccess && setup.isSuccess;
  const result = ready ? dealTarget(pipelines.data, setup.data.applied?.pipelineId ?? null) : null;
  const target = result && !("problem" in result) ? result : null;
  const reason = pipelines.isError ? PIPELINES_NOT_LOADED
    : setup.isError ? SETUP_NOT_LOADED
    : result && "problem" in result ? (result.problem === "no_open_stage" ? NO_OPEN_STAGE_REASON : NO_PIPELINE_REASON)
    : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={target === null}
        aria-busy={(!ready && !pipelines.isError && !setup.isError) || undefined}
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
  const profileCurrency = businessCurrency(profile.data) ?? FALLBACK_CURRENCY;
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string | null>(null);
  const [problem, setProblem] = useState<"title" | "amount" | "currency" | null>(null);
  // The deal the first attempt added when only its value failed: the retry saves the value alone.
  const [created, setCreated] = useState<CreatedDeal | null>(null);
  // A value needs the business's currency, or one the owner picked: never a guessed USD.
  const currencyKnown = currency !== null || businessCurrency(profile.data) !== null;
  const shownCurrency = currency ?? profileCurrency;

  const create = useMutation({
    mutationFn: ({ input, value, created: earlier }: { input: NewDeal; value: DealValue | null; created: CreatedDeal | null; generation: number }) =>
      createDealWithValue(api, input, value, (payload) => intents.keyFor(payload), earlier, (payload, error) => intents.settle(payload, error)),
    onSettled: (_result, error, attempt) => { if (!attempt.created) intents.settle(attempt.input, error); },
    onSuccess: async (result, attempt) => {
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      await queryClient.invalidateQueries({ queryKey: keys.dealsAll });
      if (result.valueError) {
        // The deal exists: keep the dialog open on the error so the value can be saved again.
        if (generation.isCurrent(attempt.generation)) setCreated(result.deal);
        return;
      }
      if (generation.isCurrent(attempt.generation)) onOpenChange(false);
      toast(`Added the deal ${result.deal.title}.`);
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
    setCreated(null);
  }, [open, reset]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setProblem("title");
    const decided = dealValueFor(amount, currencyKnown, shownCurrency);
    if ("problem" in decided) return setProblem(decided.problem);
    const value = decided.value;
    setProblem(null);
    create.mutate({
      input: { contactId, pipelineId: target.pipelineId, stageId: target.stageId, title: name }, value, created, generation: generation.current(),
    });
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
              readOnly={created !== null}
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
                readOnly={created !== null}
                aria-invalid={problem === "amount" || undefined}
                aria-describedby={problem === "amount" ? "new-deal-problem new-deal-help" : "new-deal-help"}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="new-deal-currency">Currency</Label>
              <Select
                id="new-deal-currency"
                className="w-full"
                value={currencyKnown ? shownCurrency : ""}
                disabled={created !== null}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {currencyKnown ? null : <option value="" disabled>Choose a currency</option>}
                {CURRENCIES.filter((item) => isActiveCurrencyCode(item.code)).map((item) => <option key={item.code} value={item.code}>{currencyLabel(item.code)}</option>)}
              </Select>
            </div>
          </div>
          {problem ? (
            <p id="new-deal-problem" role="alert" className="-mt-2 text-sm text-danger">
              {problem === "title" ? "Give the deal a title." : problem === "currency" ? CHOOSE_CURRENCY : amountHint(shownCurrency)}
            </p>
          ) : null}
          <p id="new-deal-help" className={problem ? "text-xs text-meta" : "-mt-2 text-xs text-meta"}>Leave the value empty if it is not known yet.</p>
          {create.isError ? <ErrorNote error={create.error} /> : null}
          {created && create.data?.valueError ? <ErrorNote error={create.data.valueError} message={VALUE_NOT_SAVED} /> : null}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{created ? "Close" : "Cancel"}</Button>
            <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>{created ? "Save the value" : "Add deal"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
