import {
  createDealCommandSchema,
  createDealOutputSchema,
  createOrFindContactCommandSchema,
  createOrFindContactOutputSchema,
  moveDealStageCommandSchema,
  moveDealStageOutputSchema,
  type CreateDeal,
  type CreateOrFindContact,
  type MoveDealStage,
} from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";
import { createOrFindContactHandler } from "./contact.js";
import { createDealHandler, moveDealStageHandler } from "./deal.js";
import { parseOrFail } from "./rows.js";

export const crmHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "crm.contact.create-or-find": createOrFindContactHandler,
  "crm.deal.create": createDealHandler,
  "crm.deal.move-stage": moveDealStageHandler,
});

// C-17: parse once, dispatch exactly once through the bound shared dispatcher, validate the envelope.
// Dispatcher errors propagate unchanged; there is no re-dispatch.
export const createOrFindContact: CreateOrFindContact = async (command, ctx) => {
  const parsed = parseOrFail(createOrFindContactCommandSchema, command);
  return parseOrFail(createOrFindContactOutputSchema, await ctx.dispatch(parsed));
};
export const createDeal: CreateDeal = async (command, ctx) => {
  const parsed = parseOrFail(createDealCommandSchema, command);
  return parseOrFail(createDealOutputSchema, await ctx.dispatch(parsed));
};
export const moveDealStage: MoveDealStage = async (command, ctx) => {
  const parsed = parseOrFail(moveDealStageCommandSchema, command);
  return parseOrFail(moveDealStageOutputSchema, await ctx.dispatch(parsed));
};
