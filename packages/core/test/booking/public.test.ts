import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  createBookingCommandSchema,
  createBookingOutputSchema,
  getAvailableSlotsInputSchema,
  getAvailableSlotsOutputSchema,
  type ActionCommand,
} from "@zs/contracts";
import { createBooking, getAvailableSlots } from "../../src/index.js";

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../fixtures/public/booking/${name}.json`, import.meta.url), "utf8"));
}

it.each([
  ["alignment-notice", "B-8/B-11/B-12: uses the local grid and exact notice/horizon bounds"],
  ["buffers-override", "B-6/B-14/B-15: replaces weekly hours and respects buffers across midnight"],
  ["dst-gap", "B-7/B-9: skips nonexistent starts while keeping elapsed duration"],
  ["dst-overlap", "B-7/B-16: keeps both occurrences of repeated local starts in UTC order"],
])("%s: %s", (name) => {
  const example = fixture(name!);
  const input = getAvailableSlotsInputSchema.parse(example.input);
  const expected = getAvailableSlotsOutputSchema.parse(example.expected);
  const before = structuredClone(input);
  const clock = { now: () => new Date(example.clock) };
  expect(getAvailableSlots(input, { clock })).toEqual(expected);
  expect(input).toEqual(before);
});

it("B-17/B-18: forwards one booking command and returns the committed dispatcher envelope", async () => {
  const example = fixture("create-booking");
  const command = createBookingCommandSchema.parse(example.command);
  const expected = createBookingOutputSchema.parse(example.expected);
  // Boundary test only. The future real dispatcher/handler integration proves persistence.
  const dispatch = vi.fn(async (_command: ActionCommand) => expected);
  expect(await createBooking(command, { dispatch })).toEqual(expected);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});
