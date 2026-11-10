// The confirmation email (booking-self-service.md BS-3). It is its own action, dispatched after the
// booking commits: the booking action's one outbox event feeds the automation events and must not
// be replaced by a message. A failure here never fails the booking.
import {
  CONFIRMATION_SEND_ACTION,
  confirmationOutputSchema,
  type ActionCommand,
  type ActionResult,
  type ConfirmationKind,
  type ConfirmationNotice,
} from "@zs/contracts";
import { derivedId } from "./ids.js";

/** `failed`: the action could not run or ran out of time; the visitor's retry with the same key sends it. */
export type ConfirmationOutcome = ConfirmationNotice | "failed";

/** BS-3: the confirmation gets at most this long, and always leaves this much of the request deadline for the answer. */
const CONFIRM_BUDGET_MS = 3000;
const CONFIRM_MARGIN_MS = 1500;

/** Milliseconds the confirmation may take; zero or less means there is no room and it is skipped. */
export const confirmBudget = (timeLeft: (() => number) | undefined): number =>
  Math.min(CONFIRM_BUDGET_MS, (timeLeft?.() ?? Infinity) - CONFIRM_MARGIN_MS);

export async function confirmBooking(
  run: (command: ActionCommand) => Promise<ActionResult>, tenantId: string, bookingId: string, kind: ConfirmationKind,
  budgetMs: number = CONFIRM_BUDGET_MS,
): Promise<ConfirmationOutcome> {
  if (budgetMs <= 0) return "failed";
  const idempotencyKey = `confirm:${bookingId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The booking is saved. A slow confirmation must not eat the time left to answer 201 (work still running
    // after this finishes on its own; the dispatcher's own transaction decides whether it commits).
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("confirmation timed out")), budgetMs); });
    const output = confirmationOutputSchema.parse(await Promise.race([run({
      actionType: CONFIRMATION_SEND_ACTION,
      target: { tenantId, type: "booking", id: bookingId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
      payload: { bookingId, kind },
    }), late]));
    return output.result.notice;
  } catch {
    return "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
