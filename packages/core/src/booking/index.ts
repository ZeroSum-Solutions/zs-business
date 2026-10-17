import { NotImplemented, type CreateBooking, type GetAvailableSlots } from "@zs/contracts";

export const getAvailableSlots: GetAvailableSlots = (_input, _deps) => {
  throw new NotImplemented("getAvailableSlots is not implemented");
};

export const createBooking: CreateBooking = async (_command, _ctx) => {
  throw new NotImplemented("createBooking is not implemented");
};
