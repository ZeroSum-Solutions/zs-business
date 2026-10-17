import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  Conflict,
  createDealCommandSchema,
  createDealOutputSchema,
  createOrFindContactCommandSchema,
  createOrFindContactOutputSchema,
  moveDealStageCommandSchema,
  moveDealStageOutputSchema,
  type ActionCommand,
} from "@zs/contracts";
import { createDeal, createOrFindContact, moveDealStage } from "../../src/index.js";

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../../fixtures/public/crm/${name}.json`, import.meta.url), "utf8"));
}

// Scripted dispatcher responses exercise the frozen facade, not database algorithms.
it("C-2/C-4/C-5: normalizes email before approval and forwards the create/find envelope", async () => {
  const example = fixture("contact-created");
  const command = createOrFindContactCommandSchema.parse(example.command);
  const expected = createOrFindContactOutputSchema.parse(example.expected);
  expect(command.payload.email).toBe("person@example.test");
  const dispatch = vi.fn(async (_command: ActionCommand) => expected);
  expect(await createOrFindContact(command, { dispatch })).toEqual(expected);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});

it("C-6/C-10: returns the existing contact and consent from a committed import result", async () => {
  const example = fixture("contact-import-preserves-consent");
  const command = createOrFindContactCommandSchema.parse(example.command);
  const expected = createOrFindContactOutputSchema.parse(example.expected);
  const dispatch = vi.fn(async (_command: ActionCommand) => expected);
  const actual = await createOrFindContact(command, { dispatch });
  expect(actual).toEqual(expected);
  expect(actual.result.contact.consent).toEqual(example.state.contacts[0].consent);
  expect(actual.result.contact.id).not.toBe(command.payload.contactId);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});

it("C-7/C-19: preserves a typed split-identity conflict from the dispatcher", async () => {
  const example = fixture("contact-split-identity");
  const command = createOrFindContactCommandSchema.parse(example.command);
  const dispatch = vi.fn(async (_command: ActionCommand): Promise<never> => {
    throw new Conflict("Identities resolve to different contacts", example.expected.error.details);
  });
  const actual = await createOrFindContact(command, { dispatch }).catch((error: unknown) => {
    if (!(error instanceof Conflict)) throw error;
    return error;
  });
  expect(actual).toBeInstanceOf(Conflict);
  expect(actual).toMatchObject(example.expected.error);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});

it("C-13/C-17: forwards deal creation and returns revision one", async () => {
  const example = fixture("deal-created");
  const command = createDealCommandSchema.parse(example.command);
  const expected = createDealOutputSchema.parse(example.expected);
  const dispatch = vi.fn(async (_command: ActionCommand) => expected);
  expect(await createDeal(command, { dispatch })).toEqual(expected);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});

it("C-14/C-15: forwards an expected revision and returns the committed next revision", async () => {
  const example = fixture("deal-stage-moved");
  const command = moveDealStageCommandSchema.parse(example.command);
  const expected = moveDealStageOutputSchema.parse(example.expected);
  const dispatch = vi.fn(async (_command: ActionCommand) => expected);
  const actual = await moveDealStage(command, { dispatch });
  expect(actual).toEqual(expected);
  expect(actual.result.revision).toBe(command.payload.expectedRevision + 1);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});

it("C-14/C-19: preserves the dispatcher's typed stale-revision conflict", async () => {
  const example = fixture("deal-stage-stale");
  const command = moveDealStageCommandSchema.parse(example.command);
  const dispatch = vi.fn(async (_command: ActionCommand): Promise<never> => {
    throw new Conflict("Deal revision changed", example.expected.error.details);
  });
  const actual = await moveDealStage(command, { dispatch }).catch((error: unknown) => {
    if (!(error instanceof Conflict)) throw error;
    return error;
  });
  expect(actual).toBeInstanceOf(Conflict);
  expect(actual).toMatchObject(example.expected.error);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
});
