// M3a public edge session (public-intake.md P-2, P-3, P-5, P-6, P-11). The tenant and page come
// from a verified booking key, never from the request; the server builds the principal itself.
import {
  NotFound,
  TenantDenied,
  publicBookingRequestBodySchema,
  publicIdempotencyKeySchema,
  slotsQuerySchema,
  uuidSchema,
  type PublicBookingReply,
  type PublicPage,
  type SlotsResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { PUBLIC_REQUEST_ACTION } from "../intake/public-request.js";
import { requestPublicBooking } from "../intake/index.js";
import type { BookingPageRef } from "../intake/keys.js";
import { findSlots } from "../reads/booking.js";
import { loadPublishedPage, pageHasResource, publicPage } from "../reads/intake.js";
import { derivedId } from "./ids.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies } from "./session.js";

/** The one actor every anonymous request runs as, per tenant (P-3). */
export const publicIntakeActorId = (tenantId: string) => derivedId(tenantId, "public-intake", "actor");

/** P-1, P-3: the public principal is no member and may run the one public action only. */
const publicAuthorize: Authorize = async (_tx, binding) => {
  if (binding.actionType !== PUBLIC_REQUEST_ACTION) throw new TenantDenied();
};

export function createPublicSession(deps: EdgeDependencies, ref: BookingPageRef) {
  const tenantId = uuidSchema.parse(ref.tenantId);
  const pageId = uuidSchema.parse(ref.pageId);
  const run = directDispatch(deps, tenantId, publicIntakeActorId(tenantId), publicAuthorize);
  const read = <T>(work: (tx: Transaction) => Promise<T>) => deps.db.tenant(tenantId, work);

  /** P-4: an unpublished page and an unlinked resource look exactly like a forged key. */
  const requirePage = async (tx: Transaction, resourceId?: string) => {
    const row = await loadPublishedPage(tx, tenantId, pageId);
    if (!row || (resourceId !== undefined && !(await pageHasResource(tx, tenantId, pageId, resourceId))))
      throw new NotFound();
    return row;
  };

  return {
    getPage: (): Promise<PublicPage> => read(async (tx) => publicPage(tx, tenantId, await requirePage(tx))),

    findSlots: (query: unknown): Promise<SlotsResponse> => {
      const parsed = parseInput(slotsQuerySchema, query, "query");
      const now = new Date(readClock(deps.clock));
      return read(async (tx) => {
        await requirePage(tx, parsed.resourceId);
        return findSlots(tx, tenantId, parsed, now);
      });
    },

    async request(body: unknown, rawKey: unknown): Promise<PublicBookingReply> {
      const key = parseInput(publicIdempotencyKeySchema, rawKey, "Idempotency-Key");
      const { website: _honeypot, botToken: _token, ...input } = parseInput(publicBookingRequestBodySchema, body);
      // P-5: the stored key is namespaced, and every ID derives from it, so a retry replays.
      const idempotencyKey = `public:${pageId}:${key}`;
      const bookingId = derivedId(tenantId, idempotencyKey, "booking");
      const output = await requestPublicBooking({
        actionType: PUBLIC_REQUEST_ACTION,
        target: { tenantId, type: "booking", id: bookingId },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: {
          ...input,
          bookingId,
          intakeItemId: derivedId(tenantId, idempotencyKey, "intake"),
          contactId: derivedId(tenantId, idempotencyKey, "contact"),
          pageId,
        },
      }, { dispatch: run });
      // P-6: the outcome and contact stay on the server; every caller sees this shape.
      const { result } = output;
      return {
        requestId: result.intakeItemId,
        status: "confirmed",
        resourceId: result.resourceId,
        startsAt: result.startsAt,
        endsAt: result.endsAt,
      };
    },
  };
}
export type PublicSession = ReturnType<typeof createPublicSession>;
