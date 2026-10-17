import {
  NotImplemented,
  type CreateDeal,
  type CreateOrFindContact,
  type MoveDealStage,
} from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";

export const crmHandlers: Readonly<Record<string, ActionHandler>> = {};

export const createOrFindContact: CreateOrFindContact = async (_command, _ctx) => {
  throw new NotImplemented("createOrFindContact is not implemented");
};
export const createDeal: CreateDeal = async (_command, _ctx) => {
  throw new NotImplemented("createDeal is not implemented");
};
export const moveDealStage: MoveDealStage = async (_command, _ctx) => {
  throw new NotImplemented("moveDealStage is not implemented");
};
