// The customer's own booking link (booking-self-service.md BS-1..BS-8). The tenant and the booking
// come from a verified token, never from the request; the server builds a principal that may run
// the two self-service actions only.
import {
  CONFIRMATION_SEND_ACTION,
  Conflict,
  manageCancelBodySchema,
  manageRescheduleBodySchema,
  manageSlotsQuerySchema,
  manageViewSchema,
  publicIdempotencyKeySchema,
  SELF_CANCEL_ACTION,
  SELF_RESCHEDULE_ACTION,
  selfCancelOutputSchema,
  selfRescheduleOutputSchema,
  type ActionCommand,
  type ManageRescheduleReply,
  type ManageView,
  type SlotsResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { manageExpiry, signManageToken, verifyManageToken, type ManageSecrets } from "../booking/manage-token.js";
import { readClock } from "../booking/slots.js";
import { linkOrigin, manageView, type ManageLinkConfig } from "../booking/self-service.js";
import { findSlots } from "../reads/booking.js";
import { confirmBooking, confirmBudget } from "./confirm-booking.js";
import { only, toJson } from "./dispatch-util.js";
import { derivedId } from "./ids.js";
import { publicIntakeActorId } from "./public-session.js";
import { directDispatch, parseInput, type EdgeDependencies } from "./session.js";

/** BS-1: what a verified token names. `expired` is decided on the injected clock, before any database work. */
export interface ManageHandle {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly expired: boolean;
  view(): Promise<ManageView>;
  slots(query: unknown): Promise<SlotsResponse>;
  cancel(body: unknown, rawKey: unknown): Promise<ManageView>;
  reschedule(body: unknown, rawKey: unknown): Promise<ManageRescheduleReply>;
}

const linkExpired = () => new Conflict("This link has expired", { reason: "link_expired" });

export function createManageSession(deps: EdgeDependencies, secrets: ManageSecrets, publicBaseUrl: string) {
  const link: ManageLinkConfig = { secret: secrets.current, publicBaseUrl };

  return {
    /** The handle for a token, or null for one that is malformed or not signed by a known secret (BS-1). */
    open(token: string): ManageHandle | null {
      const ref = verifyManageToken(secrets, token);
      if (!ref) return null;
      const { tenantId, bookingId } = ref;
      const expired = (): boolean => readClock(deps.clock) >= ref.expiresAt * 1000;
      const live = <T>(work: () => Promise<T>): Promise<T> => {
        if (expired()) return Promise.reject(linkExpired());
        return work();
      };
      const read = <T>(work: (tx: Transaction) => Promise<T>) => deps.db.tenant(tenantId, work);
      const viewOf = (id: string): Promise<ManageView> => read(async (tx) =>
        parseInput(manageViewSchema, (await manageView(tx, tenantId, id, new Date(readClock(deps.clock)), link)).view, "view"));
      const key = (raw: unknown) => `manage:${bookingId}:${parseInput(publicIdempotencyKeySchema, raw, "Idempotency-Key")}`;
      const run = directDispatch(deps, tenantId, publicIntakeActorId(tenantId),
        only(SELF_CANCEL_ACTION, SELF_RESCHEDULE_ACTION), { manage: link });
      const command = (actionType: string, idempotencyKey: string, targetId: string, payload: unknown): ActionCommand => ({
        actionType,
        target: { tenantId, type: "booking", id: targetId },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: toJson(payload),
      });

      return {
        tenantId,
        bookingId,
        get expired() { return expired(); },
        view: () => live(() => viewOf(bookingId)),

        slots: (query) => live(async () => {
          const parsed = parseInput(manageSlotsQuerySchema, query, "query");
          const now = new Date(readClock(deps.clock));
          return read(async (tx) => {
            const { view, resourceId } = await manageView(tx, tenantId, bookingId, now, null);
            if (!view.canChange) throw new Conflict("The booking can no longer be changed", { reason: "not_changeable" });
            return findSlots(tx, tenantId, { resourceId, ...parsed }, now);
          });
        }),

        cancel: (body, rawKey) => live(async () => {
          parseInput(manageCancelBodySchema, body === undefined ? {} : body);
          const idempotencyKey = key(rawKey);
          selfCancelOutputSchema.parse(await run(command(SELF_CANCEL_ACTION, idempotencyKey, bookingId, { bookingId })));
          return viewOf(bookingId);
        }),

        reschedule: (body, rawKey) => live(async () => {
          const request = parseInput(manageRescheduleBodySchema, body);
          const idempotencyKey = key(rawKey);
          // BS-7: the new booking's ID derives from the stored key, so a replay finds the same booking.
          const newBookingId = derivedId(tenantId, idempotencyKey, "booking");
          const output = selfRescheduleOutputSchema.parse(await run(command(
            SELF_RESCHEDULE_ACTION, idempotencyKey, bookingId, { bookingId, newBookingId, startsAt: request.startsAt })));
          const created = output.result.booking;
          const confirm = directDispatch(deps, tenantId, publicIntakeActorId(tenantId), only(CONFIRMATION_SEND_ACTION), { manage: link });
          if (linkOrigin(publicBaseUrl)) await confirmBooking(confirm, tenantId, created.id, "rescheduled", confirmBudget(deps.timeLeft));
          return {
            view: await viewOf(created.id),
            token: signManageToken(secrets.current, { tenantId, bookingId: created.id, expiresAt: manageExpiry(created.startsAt) }),
          };
        }),
      };
    },
  };
}
export type ManageSession = ReturnType<typeof createManageSession>;
