import {
  intakeItemOutputSchema,
  linkIntakeItemCommandSchema,
  publicBookingRequestCommandSchema,
  publicBookingRequestOutputSchema,
  rejectIntakeItemCommandSchema,
  type ActionCommand,
  type ActionResult,
  type IntakeItemOutput,
  type LinkIntakeItemCommand,
  type PublicBookingRequestCommand,
  type RejectIntakeItemCommand,
} from "@zs/contracts";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail } from "../crm/rows.js";
import { PUBLIC_REQUEST_ACTION, publicRequestHandler } from "./public-request.js";
import { linkIntakeItemHandler, rejectIntakeItemHandler } from "./review.js";

/** M3a intake actions; disjoint from bookingHandlers (B-27) and crmHandlers (C-23). */
export const intakeHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [PUBLIC_REQUEST_ACTION]: publicRequestHandler,
  "intake.item.link": linkIntakeItemHandler,
  "intake.item.reject": rejectIntakeItemHandler,
});
export { signBookingKey, verifyBookingKey, type BookingKeySecrets, type BookingPageRef } from "./keys.js";

interface IntakeWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
// Parse once, dispatch once, validate the envelope: the same shape as the CRM wrappers.
export async function linkIntakeItem(command: LinkIntakeItemCommand, ctx: IntakeWriteContext): Promise<IntakeItemOutput> {
  const parsed = parseOrFail(linkIntakeItemCommandSchema, command);
  return parseOrFail(intakeItemOutputSchema, await ctx.dispatch(parsed));
}
export async function rejectIntakeItem(command: RejectIntakeItemCommand, ctx: IntakeWriteContext): Promise<IntakeItemOutput> {
  const parsed = parseOrFail(rejectIntakeItemCommandSchema, command);
  return parseOrFail(intakeItemOutputSchema, await ctx.dispatch(parsed));
}
export async function requestPublicBooking(command: PublicBookingRequestCommand, ctx: IntakeWriteContext) {
  const parsed = parseOrFail(publicBookingRequestCommandSchema, command);
  return parseOrFail(publicBookingRequestOutputSchema, await ctx.dispatch(parsed));
}
