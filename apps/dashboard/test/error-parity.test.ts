// The demo adapter must fail exactly as the live API does. Each case builds the body with
// core's own mapError, sends it through the HTTP client, and compares the ApiError with the
// one the demo adapter throws for the same request.
import { describe, expect, it } from "vitest";
import {
  ActionError,
  Conflict,
  IdempotencyConflict,
  NotFound,
  TenantDenied,
  slotsQuerySchema,
  upsertContactRequestSchema,
  type ApiErrorCode,
} from "@zs/contracts";
import { DatabaseUnavailable, mapError, validationError } from "@zs/core";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_PIPELINE, SHOWROOM_ID } from "../src/lib/api/demo/seed";
import { API_ERRORS, ApiError, demoErrorBody } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";
import { toUpsertContactRequest, type NewContact } from "../src/lib/api/types";

const NOW = new Date("2026-10-18T13:00:00.000Z");
const UNKNOWN = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c99";
const week = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z", zone: "America/New_York" };

function demo() {
  let ids = 0;
  return createDemoAdapter({ clock: { now: () => NOW }, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
}

let keys = 0;
const key = () => ({ idempotencyKey: `parity-key-${++keys}` });

/** The error the HTTP client throws when the API answers with core's mapping of `thrown`. */
async function liveError(thrown: unknown): Promise<ApiError> {
  const { status, body } = mapError(thrown);
  const api = createHttpClient({
    baseUrl: "https://api.example.test",
    getToken: () => "token",
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  });
  return api.listResources().then(() => { throw new Error("expected a rejection"); }, (error: ApiError) => error);
}

const view = (error: unknown) => {
  if (!(error instanceof ApiError)) throw error;
  return { kind: error.kind, status: error.status, code: error.code, details: error.details, message: error.message };
};

async function expectSame(demoCall: Promise<unknown>, thrown: unknown) {
  const demoErr = await demoCall.then(() => { throw new Error("demo call resolved"); }, (error: unknown) => error);
  expect(view(demoErr)).toEqual(view(await liveError(thrown)));
}

describe("error bodies match the API", () => {
  it.each<[ApiErrorCode, unknown]>([
    ["ValidationFailed", new ActionError("ValidationFailed", "handler text", { issues: [{ path: "email", message: "x" }] })],
    ["Forbidden", new TenantDenied()],
    ["NotFound", new NotFound("Booking resource not found")],
    ["Conflict", new Conflict("Requested slot is unavailable", { reason: "slot_unavailable" })],
    ["Internal", new Error("boom")],
    ["Unavailable", new DatabaseUnavailable("busy")],
  ])("%s carries core's fixed message and status", (code, thrown) => {
    const mapped = mapError(thrown);
    expect(mapped.status).toBe(API_ERRORS[code].status);
    expect(mapped.body).toEqual(demoErrorBody(code, mapped.body.error.details));
  });

  it("answers slots for an unknown calendar with 403, like the API", async () => {
    await expectSame(demo().getSlots({ resourceId: UNKNOWN, ...week }), new TenantDenied());
  });

  it("answers a booking on an unknown calendar with 403", async () => {
    await expectSame(demo().createBooking({ resourceId: UNKNOWN, startsAt: "2026-10-20T14:00:00.000Z" }, key()), new TenantDenied());
  });

  it("answers a stage move on an unknown deal with 403", async () => {
    await expectSame(demo().moveDealStage({
      dealId: UNKNOWN, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[1]!.id, expectedRevision: 1,
    }, key()), new TenantDenied());
  });

  it("refuses an inverted slot range with the contract's issues", async () => {
    const query = { resourceId: SHOWROOM_ID, from: week.to, to: week.from, zone: week.zone };
    const issues = slotsQuerySchema.safeParse(query).error!.issues;
    await expectSame(demo().getSlots(query), validationError("Invalid query", issues));
  });

  it.each<[string, NewContact]>([
    ["no identity", { displayName: "No details", email: null, phone: null }],
    ["a bad email", { displayName: null, email: "not-an-email", phone: null }],
    ["a bad phone", { displayName: null, email: null, phone: "555" }],
  ])("refuses a contact with %s with the contract's issues", async (_label, input) => {
    const issues = upsertContactRequestSchema.safeParse(toUpsertContactRequest(input)).error!.issues;
    await expectSame(demo().createOrFindContact(input, key()), validationError("Invalid body", issues));
  });

  it("shows a plain message when a contact has no email or phone", async () => {
    const error = await demo().createOrFindContact({ displayName: "No details", email: null, phone: null }, key()).catch((caught: unknown) => caught);
    expect((error as ApiError).message).toBe("Add an email or a phone number.");
  });

  it("maps a taken slot the same way", async () => {
    const api = demo();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    api.bookAsSomeoneElse(SHOWROOM_ID, slots[0]!.startsAt);
    await expectSame(api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt }, key()),
      new Conflict("conflicting key value violates exclusion constraint", { postgresCode: "23P01", constraint: "bookings_no_overlap" }));
  });

  it("maps a reused idempotency key the same way", async () => {
    const api = demo();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    await api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt }, { idempotencyKey: "k" });
    await expectSame(api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[1]!.startsAt }, { idempotencyKey: "k" }), new IdempotencyConflict());
  });

  it("maps a stale revision the same way", async () => {
    const api = demo();
    const [deal] = (await api.listDeals()).items;
    const current = api.editDealElsewhere(deal!.id);
    await expectSame(api.moveDealStage({
      dealId: deal!.id, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[1]!.id, expectedRevision: deal!.revision,
    }, key()), new Conflict("The deal revision changed", { reason: "stale_revision", currentRevision: current.revision }));
  });

  it("maps a conflict reason outside the API's allowlist to the generic conflict copy", async () => {
    const error = await liveError(new Conflict("x", { reason: "some_internal_reason" }));
    expect(error).toMatchObject({ kind: "conflict", reason: "conflict", message: "Something changed while you were working." });
  });
});
