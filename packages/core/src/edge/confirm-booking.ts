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

/** `failed`: the action could not run; the visitor's retry with the same key sends it. */
export type ConfirmationOutcome = ConfirmationNotice | "failed";

export async function confirmBooking(
  run: (command: ActionCommand) => Promise<ActionResult>, tenantId: string, bookingId: string, kind: ConfirmationKind,
): Promise<ConfirmationOutcome> {
  const idempotencyKey = `confirm:${bookingId}`;
  try {
    const output = confirmationOutputSchema.parse(await run({
      actionType: CONFIRMATION_SEND_ACTION,
      target: { tenantId, type: "booking", id: bookingId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
      payload: { bookingId, kind },
    }));
    return output.result.notice;
  } catch {
    return "failed";
  }
}
