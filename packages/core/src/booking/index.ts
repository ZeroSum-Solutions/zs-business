import { NotImplemented, type CreateBooking, type GetAvailableSlots } from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";

export const bookingHandlers: Readonly<Record<string, ActionHandler>> = {};

export const getAvailableSlots: GetAvailableSlots = (_input, _deps) => {
  throw new NotImplemented("getAvailableSlots is not implemented");
};

export const createBooking: CreateBooking = async (_command, _ctx) => {
  throw new NotImplemented("createBooking is not implemented");
};
