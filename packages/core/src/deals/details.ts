// Deal value and lead source (inbox-home.md H-1, H-2). Original code. A separate action from the
// frozen F2 three (crm.md C-23 keeps crmHandlers to exactly those keys), with C-14's
// compare-and-set on the deal revision so it cannot interleave with a stage move.
import {
  Conflict,
  setDealDetailsCommandSchema,
  setDealDetailsOutputSchema,
  TenantDenied,
  type DealSummary,
  type SetDealDetailsCommand,
  type SetDealDetailsOutput,
  type ActionCommand,
  type ActionResult,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { dealColumns, dealRecord, parseOrFail, type DealRow } from "../crm/rows.js";

export const SET_DEAL_DETAILS_ACTION = "crm.deal.set-details";

export interface DealSummaryRow extends DealRow {
  value_minor: string | null;
  currency: string | null;
  lead_source: DealSummary["leadSource"];
  won_at: Date | null;
}
export const dealSummaryColumns = `${dealColumns},value_minor::text AS value_minor,currency,lead_source,won_at`;

export function dealSummary(row: DealSummaryRow): DealSummary {
  const amount = row.value_minor === null ? null : Number(row.value_minor);
  return {
    ...dealRecord(row),
    value: amount === null || row.currency === null ? null : { amountMinor: amount, currency: row.currency },
    leadSource: row.lead_source,
    wonAt: row.won_at?.toISOString() ?? null,
  };
}

async function currentRevision(tx: Transaction, tenantId: string, dealId: string): Promise<number> {
  const row = (await tx.query<{ revision: string }>(
    "SELECT revision::text AS revision FROM crm_deals WHERE tenant_id=$1 AND id=$2", [tenantId, dealId])).rows[0];
  if (!row) throw new TenantDenied();
  return Number(row.revision);
}

export const setDealDetailsHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "deal") return null;
    const owned = await tx.query("SELECT 1 FROM crm_deals WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
    return owned.rowCount === 1 ? { tenantId: target.tenantId, type: "deal", id: target.id } : null;
  },
  async handle({ tx, command, binding, now }) {
    const { payload: input } = parseOrFail(setDealDetailsCommandSchema, command);
    const tenantId = binding.tenantId;
    const row = (await tx.query<DealSummaryRow>(
      `UPDATE crm_deals SET value_minor=$4, currency=$5, lead_source=$6, revision=revision+1, updated_at=$7
        WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND revision < 9007199254740991
        RETURNING ${dealSummaryColumns}`,
      [tenantId, input.dealId, input.expectedRevision, input.value?.amountMinor ?? null, input.value?.currency ?? null,
        input.leadSource, now],
    )).rows[0];
    if (!row)
      throw new Conflict("The deal revision changed", {
        reason: "stale_revision",
        currentRevision: await currentRevision(tx, tenantId, input.dealId),
      });
    return { result: dealSummary(row) };
  },
};

export const dealDetailsHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [SET_DEAL_DETAILS_ACTION]: setDealDetailsHandler,
});

interface DealWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
export async function setDealDetails(command: SetDealDetailsCommand, ctx: DealWriteContext): Promise<SetDealDetailsOutput> {
  const parsed = parseOrFail(setDealDetailsCommandSchema, command);
  return parseOrFail(setDealDetailsOutputSchema, await ctx.dispatch(parsed));
}
